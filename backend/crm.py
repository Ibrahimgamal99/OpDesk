#!/usr/bin/env python3
"""
CRM Connector Interface

A unified interface for integrating with multiple CRM systems using different
authentication methods: API Key, Basic Auth, Bearer Token, and OAuth2.

This connector sends call data to CRM systems in a standardized format.
"""

import asyncio
import base64
import ipaddress
import json
import logging
import re
import socket
import urllib.parse
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Any, Union
from datetime import datetime, timedelta
import httpx

log = logging.getLogger(__name__)


class AuthType(Enum):
    """Supported authentication types."""
    API_KEY = "api_key"
    BASIC_AUTH = "basic_auth"
    BEARER_TOKEN = "bearer_token"
    OAUTH2 = "oauth2"


class CRMConnector:
    """
    Unified CRM Connector that supports multiple authentication methods.
    
    Usage:
        # API Key authentication
        crm = CRMConnector(
            server_url="https://crm.example.com",
            auth_type=AuthType.API_KEY,
            api_key="your-api-key-here"
        )
        
        # Basic Auth
        crm = CRMConnector(
            server_url="https://crm.example.com",
            auth_type=AuthType.BASIC_AUTH,
            username="user",
            password="pass"
        )
        
        # Bearer Token
        crm = CRMConnector(
            server_url="https://crm.example.com",
            auth_type=AuthType.BEARER_TOKEN,
            bearer_token="your-token-here"
        )
        
        # OAuth2
        crm = CRMConnector(
            server_url="https://crm.example.com",
            auth_type=AuthType.OAUTH2,
            oauth2_client_id="client-id",
            oauth2_client_secret="client-secret",
            oauth2_token_url="https://crm.example.com/oauth/token"
        )
        
        # Send call data
        call_data = {
            "caller": "1002",
            "destination": "1001",
            "duration": "00:05:23",
            "talk_time": "00:04:50",
            "datetime": "2024-01-01T12:00:00",
            "call_status": "completed",
            "queue": "sales",
            "call_type": "inbound"
        }
        await crm.send_call_data(call_data)
    """
    
    def __init__(
        self,
        server_url: str,
        auth_type: AuthType,
        # API Key auth
        api_key: Optional[str] = None,
        api_key_header: str = "X-API-Key",  # Customizable header name
        # Basic Auth
        username: Optional[str] = None,
        password: Optional[str] = None,
        # Bearer Token
        bearer_token: Optional[str] = None,
        # OAuth2
        oauth2_client_id: Optional[str] = None,
        oauth2_client_secret: Optional[str] = None,
        oauth2_token_url: Optional[str] = None,
        oauth2_scope: Optional[str] = None,
        oauth2_token: Optional[str] = None,  # Pre-obtained token
        # Common settings
        endpoint_path: str = "/api/calls",  # CRM endpoint path
        timeout: int = 30,
        verify_ssl: bool = True,
        custom_headers: Optional[Dict[str, str]] = None
    ):
        """
        Initialize CRM Connector.
        
        Args:
            server_url: CRM server URL (e.g., "https://crm.example.com" or "http://192.168.1.100:8080")
            auth_type: Authentication type (AuthType enum)
            api_key: API key for API_KEY auth type
            api_key_header: Header name for API key (default: "X-API-Key")
            username: Username for BASIC_AUTH
            password: Password for BASIC_AUTH
            bearer_token: Bearer token for BEARER_TOKEN auth type
            oauth2_client_id: OAuth2 client ID
            oauth2_client_secret: OAuth2 client secret
            oauth2_token_url: OAuth2 token endpoint URL
            oauth2_scope: OAuth2 scope (optional)
            oauth2_token: Pre-obtained OAuth2 token (optional, will fetch if not provided)
            endpoint_path: API endpoint path for sending call data
            timeout: Request timeout in seconds
            verify_ssl: Whether to verify SSL certificates
            custom_headers: Additional custom headers to include in requests
        """
        # Normalize server URL (remove trailing slash)
        self.server_url = server_url.rstrip('/')
        self.auth_type = auth_type
        self.endpoint_path = endpoint_path
        self.timeout = timeout
        self.verify_ssl = verify_ssl
        self.custom_headers = custom_headers or {}
        
        # Auth credentials
        self.api_key = api_key
        self.api_key_header = api_key_header
        self.username = username
        self.password = password
        self.bearer_token = bearer_token
        
        # OAuth2 credentials
        self.oauth2_client_id = oauth2_client_id
        self.oauth2_client_secret = oauth2_client_secret
        self.oauth2_token_url = oauth2_token_url
        self.oauth2_scope = oauth2_scope
        self._oauth2_token = oauth2_token
        self._oauth2_token_expiry: Optional[datetime] = None
        self._token_lock: Optional[asyncio.Lock] = None  # For thread-safe token refresh
        
        # HTTP client
        self._client: Optional[httpx.AsyncClient] = None
        
        # Validate auth configuration
        self._validate_auth_config()
    
    def _validate_auth_config(self):
        """Validate that required credentials are provided for the selected auth type."""
        if self.auth_type == AuthType.API_KEY:
            if not self.api_key:
                raise ValueError("API key is required for API_KEY authentication")
        
        elif self.auth_type == AuthType.BASIC_AUTH:
            if not self.username or not self.password:
                raise ValueError("Username and password are required for BASIC_AUTH authentication")
        
        elif self.auth_type == AuthType.BEARER_TOKEN:
            if not self.bearer_token:
                raise ValueError("Bearer token is required for BEARER_TOKEN authentication")
        
        elif self.auth_type == AuthType.OAUTH2:
            if not self.oauth2_client_id or not self.oauth2_client_secret:
                raise ValueError("OAuth2 client_id and client_secret are required for OAUTH2 authentication")
            if not self.oauth2_token_url and not self._oauth2_token:
                raise ValueError("OAuth2 token_url is required if no pre-obtained token is provided")
    
    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client, recreating if closed."""
        if self._client is None or self._client.is_closed:
            if self._client is not None:
                try:
                    await self._client.aclose()
                except Exception:
                    pass  # Ignore errors when closing
            self._client = httpx.AsyncClient(
                timeout=self.timeout,
                verify=self.verify_ssl
            )
        return self._client
    
    async def _get_oauth2_token(self) -> str:
        """
        Get OAuth2 access token, refreshing if necessary.
        Uses async lock to prevent race conditions during token refresh.
        
        Returns:
            Valid OAuth2 access token
        """
        # Initialize lock if not exists
        if self._token_lock is None:
            self._token_lock = asyncio.Lock()
        
        async with self._token_lock:
            # Double-check token validity after acquiring lock
            if self._oauth2_token and self._oauth2_token_expiry:
                if datetime.now() < self._oauth2_token_expiry:
                    return self._oauth2_token
            
            # Fetch new token
            if not self.oauth2_token_url:
                raise ValueError("OAuth2 token URL is required to fetch token")
            
            client = await self._get_client()
            
            # Prepare OAuth2 token request
            data = {
                "grant_type": "client_credentials",
                "client_id": self.oauth2_client_id,
                "client_secret": self.oauth2_client_secret
            }
            
            if self.oauth2_scope:
                data["scope"] = self.oauth2_scope
            
            try:
                response = await client.post(
                    self.oauth2_token_url,
                    data=data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"}
                )
                response.raise_for_status()
                
                token_data = response.json()
                self._oauth2_token = token_data.get("access_token")
                
                # Calculate token expiry (default to 1 hour if not provided)
                expires_in = token_data.get("expires_in", 3600)
                self._oauth2_token_expiry = datetime.now() + timedelta(seconds=expires_in - 60)  # 60s buffer
                
                if not self._oauth2_token:
                    raise ValueError("No access_token in OAuth2 response")
                
                return self._oauth2_token
            
            except httpx.HTTPStatusError as e:
                # Sanitize error logging - don't expose response body which may contain secrets
                log.error(f"Failed to fetch OAuth2 token: HTTP {e.response.status_code}")
                if log.isEnabledFor(logging.DEBUG):
                    log.debug(f"OAuth2 token response body (truncated): {e.response.text[:200]}...")
                raise
            except httpx.HTTPError as e:
                log.error(f"Failed to fetch OAuth2 token: {type(e).__name__}")
                raise
    
    def _build_headers(self) -> Dict[str, str]:
        """Build request headers based on authentication type."""
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "OpDesk-CRM-Connector/1.0"
        }
        
        # Add custom headers
        headers.update(self.custom_headers)
        
        # Add auth headers based on auth type
        if self.auth_type == AuthType.API_KEY:
            headers[self.api_key_header] = self.api_key
        
        elif self.auth_type == AuthType.BASIC_AUTH:
            credentials = f"{self.username}:{self.password}"
            encoded = base64.b64encode(credentials.encode()).decode()
            headers["Authorization"] = f"Basic {encoded}"
        
        elif self.auth_type == AuthType.BEARER_TOKEN:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        
        elif self.auth_type == AuthType.OAUTH2:
            # OAuth2 token will be added in send_call_data after fetching
            pass
        
        return headers
    
    async def send_call_data(
        self,
        call_data: Dict[str, Any],
        endpoint_path: Optional[str] = None,
        method: str = "POST",
        require_fields: bool = True
    ) -> Dict[str, Union[bool, int, str, Dict[str, Any], None]]:
        """
        Send call data to CRM system.
        
        Args:
            call_data: Dictionary containing call information. Expected fields:
                - caller: Caller extension/number (required)
                - destination: Destination extension/number (required)
                - duration: Call duration in seconds or formatted string (e.g., "00:05:23" or 323) - total time
                - talk_time: Talk time in seconds or formatted string - time from answer to hangup (optional)
                - datetime: Call datetime in ISO format (e.g., "2024-01-01T12:00:00")
                - call_status: Call status (e.g., "completed", "answered", "no_answer", "busy", "failed")
                - queue: Queue name if call was queued (optional)
                - call_type: Type of call (e.g., "inbound", "outbound", "internal")
                - Additional custom fields as needed
            endpoint_path: Optional override for endpoint path
            method: HTTP method (POST, PUT, PATCH)
        
        Returns:
            Response dictionary with keys: success (bool), status_code (int|None), 
            data (dict|None), error (str|None)
        
        Raises:
            ValueError: If required fields are missing or OAuth2 token cannot be obtained
        
        Example:
            call_data = {
                "caller": "1002",
                "destination": "1001",
                "duration": "00:05:23",
                "talk_time": "00:04:50",
                "datetime": "2024-01-01T12:00:00",
                "call_status": "completed",
                "queue": "sales",
                "call_type": "inbound"
            }
            result = await crm.send_call_data(call_data)
        """
        # Validate required fields. The call-data sync path lets operators choose
        # exactly which fields to push (require_fields=False), so the check is opt-out.
        if require_fields:
            required_fields = ["caller", "destination"]
            missing = [f for f in required_fields if f not in call_data or not call_data[f]]
            if missing:
                raise ValueError(f"Missing required fields: {missing}")

        client = await self._get_client()
        url = f"{self.server_url}{endpoint_path or self.endpoint_path}"
        
        # Build headers
        headers = self._build_headers()
        
        # Handle OAuth2 token
        if self.auth_type == AuthType.OAUTH2:
            token = await self._get_oauth2_token()
            headers["Authorization"] = f"Bearer {token}"
        
        try:
            # Send request
            response = await client.request(
                method=method,
                url=url,
                json=call_data,
                headers=headers
            )
            
            # Raise exception for HTTP errors
            response.raise_for_status()
            
            # Try to parse JSON response
            try:
                response_data = response.json()
            except json.JSONDecodeError:
                response_data = {"message": response.text, "status_code": response.status_code}
            
            log.info(f"Successfully sent call data to CRM: {url}")
            return {
                "success": True,
                "status_code": response.status_code,
                "data": response_data,
                "error": None
            }
        
        except httpx.HTTPStatusError as e:
            # Sanitize error logging - don't expose response body which may contain secrets
            log.error(f"HTTP error sending call data to CRM: {e.response.status_code}")
            if log.isEnabledFor(logging.DEBUG):
                log.debug(f"Response body (truncated): {e.response.text[:200]}...")
            
            return {
                "success": False,
                "status_code": e.response.status_code,
                "error": e.response.text,
                "data": None
            }
        
        except httpx.RequestError as e:
            log.error(f"Request error sending call data to CRM: {type(e).__name__}")
            if log.isEnabledFor(logging.DEBUG):
                log.debug(f"Request error details: {str(e)}")
            
            return {
                "success": False,
                "status_code": None,
                "error": str(e),
                "data": None
            }
    
    async def get_json(
        self,
        endpoint_path: str
    ) -> Dict[str, Union[bool, int, str, Dict[str, Any], None]]:
        """
        GET {server_url}{endpoint_path} and parse the JSON response.

        Used by the contact-lookup feature. The path must arrive fully rendered
        (any [Number] placeholder already substituted and URL-encoded).

        Returns:
            Response dictionary with keys: success (bool), status_code (int|None),
            data (dict|list|None), error (str|None) — same shape as send_call_data.
        """
        client = await self._get_client()
        url = f"{self.server_url}{endpoint_path}"

        headers = self._build_headers()
        headers.pop("Content-Type", None)

        if self.auth_type == AuthType.OAUTH2:
            token = await self._get_oauth2_token()
            headers["Authorization"] = f"Bearer {token}"

        try:
            response = await client.request(method="GET", url=url, headers=headers)
            response.raise_for_status()

            try:
                response_data = response.json()
            except json.JSONDecodeError:
                response_data = {"message": response.text, "status_code": response.status_code}

            return {
                "success": True,
                "status_code": response.status_code,
                "data": response_data,
                "error": None
            }

        except httpx.HTTPStatusError as e:
            # Sanitize error logging - don't expose response body which may contain secrets
            log.error(f"HTTP error on CRM lookup: {e.response.status_code}")
            if log.isEnabledFor(logging.DEBUG):
                log.debug(f"Response body (truncated): {e.response.text[:200]}...")

            return {
                "success": False,
                "status_code": e.response.status_code,
                "error": e.response.text,
                "data": None
            }

        except httpx.RequestError as e:
            log.error(f"Request error on CRM lookup: {type(e).__name__}")
            if log.isEnabledFor(logging.DEBUG):
                log.debug(f"Request error details: {str(e)}")

            return {
                "success": False,
                "status_code": None,
                "error": str(e),
                "data": None
            }

    async def test_connection(self, endpoint_path: Optional[str] = None) -> Dict[str, Any]:
        """
        Test connection to CRM system.
        Tries HEAD request first (lighter weight), falls back to POST with test data.
        
        Args:
            endpoint_path: Optional endpoint path for testing (defaults to configured endpoint)
        
        Returns:
            Dictionary with connection test results
        """
        test_endpoint = endpoint_path or self.endpoint_path
        
        # Try HEAD request first (lighter weight, doesn't require body)
        try:
            client = await self._get_client()
            url = f"{self.server_url}{test_endpoint}"
            headers = self._build_headers()
            
            # Handle OAuth2 token
            if self.auth_type == AuthType.OAUTH2:
                token = await self._get_oauth2_token()
                headers["Authorization"] = f"Bearer {token}"
            
            response = await client.head(url, headers=headers, follow_redirects=True)
            
            return {
                "success": response.status_code < 400,
                "status_code": response.status_code,
                "message": "Connection test successful" if response.status_code < 400 else "Connection test failed",
                "method": "HEAD"
            }
        except httpx.HTTPStatusError as e:
            # HEAD request failed, try POST with test data
            log.debug(f"HEAD request failed ({e.response.status_code}), trying POST with test data")
        except Exception as e:
            # Other errors, try POST with test data
            log.debug(f"HEAD request error: {type(e).__name__}, trying POST with test data")
        
        # Fallback to POST with test data
        test_data = {
            "test": True,
            "timestamp": datetime.now().isoformat(),
            "message": "Connection test from OpDesk CRM Connector"
        }
        
        try:
            result = await self.send_call_data(test_data, endpoint_path=endpoint_path)
            return {
                "success": result.get("success", False),
                "status_code": result.get("status_code"),
                "message": "Connection test successful" if result.get("success") else "Connection test failed",
                "method": "POST",
                "details": result
            }
        except Exception as e:
            return {
                "success": False,
                "status_code": None,
                "message": f"Connection test failed: {str(e)}",
                "method": "POST",
                "details": None
            }
    
    async def close(self):
        """Close HTTP client and cleanup resources."""
        if self._client:
            await self._client.aclose()
            self._client = None
    
    async def __aenter__(self):
        """Async context manager entry."""
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()
    
    @staticmethod
    def normalize_duration(duration: Union[int, str]) -> str:
        """
        Convert duration to consistent format (HH:MM:SS).
        
        Args:
            duration: Duration as integer (seconds) or string (e.g., "00:05:23" or "323")
        
        Returns:
            Formatted duration string in HH:MM:SS format
        
        Example:
            normalize_duration(323)  # Returns "00:05:23"
            normalize_duration("00:05:23")  # Returns "00:05:23"
            normalize_duration("323")  # Returns "00:05:23"
        """
        if isinstance(duration, int):
            total_seconds = duration
        elif isinstance(duration, str):
            # Check if already in HH:MM:SS format
            if ":" in duration:
                return duration
            # Try to parse as integer seconds
            try:
                total_seconds = int(duration)
            except ValueError:
                # Return as-is if can't parse
                return duration
        else:
            return str(duration)
        
        # Convert seconds to HH:MM:SS
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        seconds = total_seconds % 60
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    
    @staticmethod
    def duration_to_seconds(duration: Union[int, str, None]) -> Optional[int]:
        """Parse a duration into integer seconds.

        Accepts an int (seconds), a plain numeric string ("323"), or an
        "HH:MM:SS"/"MM:SS" string. Returns None if it can't be parsed.
        """
        if duration is None or duration == "":
            return None
        if isinstance(duration, bool):
            return None
        if isinstance(duration, int):
            return duration
        s = str(duration).strip()
        if ":" in s:
            try:
                parts = [int(p) for p in s.split(":")]
            except ValueError:
                return None
            total = 0
            for p in parts:  # H:M:S or M:S — each part is the next-smaller unit
                total = total * 60 + p
            return total
        try:
            return int(s)
        except ValueError:
            return None

    @staticmethod
    def format_call_data_for_crm(
        caller: str,
        destination: str,
        duration: Optional[Union[int, str]] = None,
        datetime_str: Optional[str] = None,
        call_status: Optional[str] = None,
        queue: Optional[str] = None,
        call_type: Optional[str] = None,
        talk_time: Optional[Union[int, str]] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Format call data in the standard CRM format.
        
        Args:
            caller: Caller extension/number
            destination: Destination extension/number
            duration: Call duration (e.g., "00:05:23" or seconds as int/str) - total time from start to hangup
            datetime_str: Call datetime in ISO format (defaults to current time if not provided)
            call_status: Call status (e.g., "completed", "answered", "no_answer", "busy", "failed", "ringing")
            queue: Queue name if call was queued (optional)
            call_type: Type of call - "inbound", "outbound", or "internal" (optional)
            talk_time: Talk time (e.g., "00:05:23" or seconds as int/str) - time from answer to hangup (optional)
            **kwargs: Additional custom fields to include
        
        Returns:
            Formatted call data dictionary ready for CRM
        
        Example:
            call_data = CRMConnector.format_call_data_for_crm(
                caller="1002",
                destination="1001",
                duration="00:05:23",
                talk_time="00:04:50",
                call_status="completed",
                queue="sales",
                call_type="inbound"
            )
        """
        # Use current datetime if not provided
        if datetime_str is None:
            datetime_str = datetime.now().isoformat()
        
        # Build base call data
        crm_data = {
            "caller": str(caller),
            "destination": str(destination),
            "datetime": datetime_str
        }
        
        # Add duration if provided (normalize format)
        if duration is not None:
            crm_data["duration"] = CRMConnector.normalize_duration(duration)
        
        # Add call_status if provided
        if call_status is not None:
            crm_data["call_status"] = call_status
        
        # Add queue if provided
        if queue is not None:
            crm_data["queue"] = queue
        
        # Add call_type if provided
        if call_type is not None:
            crm_data["call_type"] = call_type
        
        # Add talk_time if provided (normalize format)
        if talk_time is not None:
            crm_data["talk_time"] = CRMConnector.normalize_duration(talk_time)
        
        # Add any additional custom fields
        crm_data.update(kwargs)
        
        return crm_data


# ---------------------------------------------------------------------------
# Helper function to create connector from configuration
# ---------------------------------------------------------------------------
def create_crm_connector(config: Dict[str, Any]) -> CRMConnector:
    """
    Create CRM connector from configuration dictionary.
    
    Args:
        config: Configuration dictionary with keys:
            - server_url: CRM server URL (required)
            - auth_type: Authentication type string ("api_key", "basic_auth", "bearer_token", "oauth2")
            - api_key: API key (for api_key auth)
            - api_key_header: API key header name (optional, default: "X-API-Key")
            - username: Username (for basic_auth)
            - password: Password (for basic_auth)
            - bearer_token: Bearer token (for bearer_token auth)
            - oauth2_client_id: OAuth2 client ID (for oauth2 auth)
            - oauth2_client_secret: OAuth2 client secret (for oauth2 auth)
            - oauth2_token_url: OAuth2 token URL (for oauth2 auth)
            - oauth2_scope: OAuth2 scope (optional)
            - endpoint_path: API endpoint path (optional, default: "/api/calls")
            - timeout: Request timeout (optional, default: 30)
            - verify_ssl: Verify SSL certificates (optional, default: True)
            - custom_headers: Custom headers dict (optional)
    
    Returns:
        Configured CRMConnector instance
    
    Example:
        config = {
            "server_url": "https://crm.example.com",
            "auth_type": "api_key",
            "api_key": "your-key-here",
            "endpoint_path": "/api/calls"
        }
        crm = create_crm_connector(config)
    """
    # Map string auth type to enum
    auth_type_map = {
        "api_key": AuthType.API_KEY,
        "basic_auth": AuthType.BASIC_AUTH,
        "bearer_token": AuthType.BEARER_TOKEN,
        "oauth2": AuthType.OAUTH2
    }
    
    auth_type_str = config.get("auth_type", "").lower()
    if auth_type_str not in auth_type_map:
        raise ValueError(f"Invalid auth_type: {auth_type_str}. Must be one of: {list(auth_type_map.keys())}")
    
    auth_type = auth_type_map[auth_type_str]
    
    # Extract common parameters
    kwargs = {
        "server_url": config["server_url"],
        "auth_type": auth_type,
        "endpoint_path": config.get("endpoint_path", "/api/calls"),
        "timeout": config.get("timeout", 30),
        "verify_ssl": config.get("verify_ssl", True),
        "custom_headers": config.get("custom_headers")
    }
    
    # Extract auth-specific parameters
    if auth_type == AuthType.API_KEY:
        kwargs["api_key"] = config.get("api_key")
        # `or` rather than a get() default: a stored-but-empty header name would
        # otherwise produce a nameless auth header and a "missing apikey" from the CRM.
        kwargs["api_key_header"] = config.get("api_key_header") or "X-API-Key"
    
    elif auth_type == AuthType.BASIC_AUTH:
        kwargs["username"] = config.get("username")
        kwargs["password"] = config.get("password")
    
    elif auth_type == AuthType.BEARER_TOKEN:
        kwargs["bearer_token"] = config.get("bearer_token")
    
    elif auth_type == AuthType.OAUTH2:
        kwargs["oauth2_client_id"] = config.get("oauth2_client_id")
        kwargs["oauth2_client_secret"] = config.get("oauth2_client_secret")
        kwargs["oauth2_token_url"] = config.get("oauth2_token_url")
        kwargs["oauth2_scope"] = config.get("oauth2_scope")
        kwargs["oauth2_token"] = config.get("oauth2_token")  # Pre-obtained token
    
    return CRMConnector(**kwargs)


# ===========================================================================
# Call-Data Sync engine
# ---------------------------------------------------------------------------
# The "sync" layer is the operator-facing push: after every completed call the
# AMI monitor assembles the full set of available call values and this module
# decides *what* actually gets sent — which fields the operator selected, which
# call directions are enabled — and applies SSRF hardening before the request
# leaves the box. It mirrors VOPX's crmsync.go design, adapted to OpDesk's
# Asterisk/AMI field names and kept backward-compatible with the original fixed
# payload (the default field selection reproduces the legacy 8-field body).
# ===========================================================================

# Canonical set of call fields that can be selected for the CRM push ("all
# possible pass values"). The Settings API serves this to the UI (one checkbox
# per entry), validates saved selections against it, and the AMI monitor builds
# its payload from the same keys. Every entry is a value that is available by the
# time a call hangs up. `caller`/`destination` are the call's identity and are
# always sent (see build_crm_payload); the rest are opt-in.
CRM_SYNC_FIELD_CATALOG: List[str] = [
    "caller",             # caller number/extension
    "destination",        # destination number/extension
    "duration",           # total call time (see duration_format)
    "talk_time",          # answer→hangup time (see duration_format)
    "datetime",           # call start, ISO 8601
    "call_status",        # canonical outcome enum (see call_log.CALL_OUTCOMES)
    "call_type",          # inbound | outbound | internal
    "queue",              # queue name (queue calls only)
    "caller_name",        # CallerID name, when Asterisk provides it
    "call_id",            # Asterisk Linkedid — the call's cross-reference handle
    "uniqueid",           # Asterisk channel Uniqueid (per-leg de-dup key)
    "disposition",        # same canonical outcome enum as call_status
    "hangup_cause",       # raw Asterisk hangup cause code
    "agent",              # agent/extension that answered (queue calls)
    "agent_name",         # display name of the answering agent
    "answered_extension", # extension that answered the call
    "queue_wait_time",    # seconds spent waiting in queue before answer
]

_CRM_SYNC_FIELD_SET = set(CRM_SYNC_FIELD_CATALOG)

# Catalog names that no longer exist, mapped to their replacement. Used by the
# one-shot settings migration so an upgraded install doesn't silently lose a
# selected field (parse_sync_fields drops anything not in the catalog).
RETIRED_CRM_SYNC_FIELDS: Dict[str, str] = {
    "linkedid": "call_id",
}

# Default selection when nothing has been configured yet. This is exactly the
# field set the connector sent before the sync layer existed, so enabling CRM on
# an upgraded install keeps sending the same *values* — only the JSON key names
# change (see CRM_SYNC_JSON_KEYS).
DEFAULT_CRM_SYNC_FIELDS: List[str] = [
    "caller", "destination", "duration", "talk_time",
    "datetime", "call_status", "call_type", "queue",
]

# Outbound JSON key names. The internal catalog uses snake_case, Asterisk-ish
# names; the CRM receiver gets camelCase keys. Any field not listed keeps its
# internal name — notably `caller`/`destination` (call identity, and the push
# path logs key off them), plus already-clean single words like `queue` and
# `disposition`. The duration fields are named dynamically (see
# _outbound_json_key) so the key reflects whether the value is seconds or HH:MM:SS.
CRM_SYNC_JSON_KEYS: Dict[str, str] = {
    "datetime": "startTime",
    "call_status": "status",
    "call_type": "callType",
    "caller_name": "callerName",
    "call_id": "callId",
    "uniqueid": "uniqueId",
    "hangup_cause": "hangupCause",
    "agent": "agentExt",
    "agent_name": "agentName",
    "answered_extension": "answeredExtension",
    "queue_wait_time": "queueWaitTime",
}


def _outbound_json_key(field_name: str, *, to_seconds: bool) -> str:
    """Map an internal payload key to its outbound JSON key.

    The duration fields carry their unit in the name so the receiver isn't left
    guessing: when the push sends integer seconds they become
    `durationInSeconds`/`talkTimeInSeconds`; in HH:MM:SS mode they are the plain
    `duration`/`talkTime`.
    """
    if field_name == "duration":
        return "durationInSeconds" if to_seconds else "duration"
    if field_name == "talk_time":
        return "talkTimeInSeconds" if to_seconds else "talkTime"
    return CRM_SYNC_JSON_KEYS.get(field_name, field_name)


def default_outbound_keys() -> Dict[str, str]:
    """Map every catalog field to the outbound JSON key it uses by default.

    This is what the Settings UI shows beside each field so an operator knows the
    key their CRM will receive (and can override it via CRM_SYNC_KEY_MAP). The
    duration fields are shown in their HH:MM:SS form (`duration`/`talkTime`); the
    seconds variants are chosen at send time by duration_format.
    """
    return {f: _outbound_json_key(f, to_seconds=False) for f in CRM_SYNC_FIELD_CATALOG}


def parse_key_map(raw: Union[str, Dict[str, str], None]) -> Dict[str, str]:
    """Normalise a stored outbound-key rename map into a clean {from: to} dict.

    Lets an operator rename any outbound JSON key to whatever their CRM expects
    (e.g. {"agentExt": "agentId"}). Accepts a dict or a JSON string. Keys/values
    are trimmed; blank entries and no-op (from == to) renames are dropped. Only
    renames of *known* default outbound keys are kept, so a stale UI value can't
    inject arbitrary keys. Unknown/malformed input yields an empty map.
    """
    if raw is None or raw == "":
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return {}
    if not isinstance(raw, dict):
        return {}
    # Valid rename sources: every outbound key a field can produce, including the
    # seconds-variant duration keys (either form may be the active one).
    valid_sources = set(default_outbound_keys().values())
    valid_sources.update({"durationInSeconds", "talkTimeInSeconds"})
    out: Dict[str, str] = {}
    for k, v in raw.items():
        k = str(k or "").strip()
        v = str(v or "").strip()
        if k and v and k != v and k in valid_sources:
            out[k] = v
    return out


def parse_status_map(raw: Union[str, Dict[str, str], None]) -> Dict[str, str]:
    """Normalise a stored outcome value-map into an upper-cased {from: to} dict.

    Lets an operator translate OpDesk's canonical outcome enum to whatever their
    CRM accepts (e.g. {"BUSY": "NO_ANSWER"} for a CRM whose enum has no BUSY).
    Accepts a dict or a JSON string; keys/values are upper-cased and blanks are
    dropped. Unknown/malformed input yields an empty map (no remapping).
    """
    if raw is None or raw == "":
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return {}
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, str] = {}
    for k, v in raw.items():
        k = str(k or "").strip().upper()
        v = str(v or "").strip().upper()
        if k and v:
            out[k] = v
    return out


def is_crm_sync_field(name: str) -> bool:
    """Report whether `name` is a recognised sync field (used to drop unknown keys)."""
    return name in _CRM_SYNC_FIELD_SET


# ---------------------------------------------------------------------------
# SSRF hardening
# ---------------------------------------------------------------------------
# A CRM URL is operator-configured, so the main threat is a misconfiguration or
# a malicious admin steering the push at internal infrastructure (the box's own
# AMI/DB on loopback, or the cloud metadata service at 169.254.169.254). We
# always block loopback, link-local (incl. metadata), multicast and the
# unspecified address. RFC-1918 private ranges are ALLOWED by default because
# on-prem CRM on the LAN is a first-class OpDesk deployment (the settings UI
# itself suggests e.g. http://192.168.1.100:8080); operators who want a stricter
# posture can opt in via block_private.

def _is_blocked_ip(ip: ipaddress._BaseAddress, *, block_private: bool, block_loopback: bool) -> bool:
    """Return True if `ip` must never be the target of an outbound CRM request."""
    if ip.is_unspecified or ip.is_multicast or ip.is_reserved:
        return True
    # link-local covers IPv4 169.254/16 (incl. the 169.254.169.254 metadata
    # service) and IPv6 fe80::/10 — always blocked.
    if ip.is_link_local:
        return True
    if block_loopback and ip.is_loopback:
        return True
    if block_private and ip.is_private:
        return True
    return False


def validate_crm_url(raw: str, *, block_private: bool = False, block_loopback: bool = True) -> None:
    """
    Vet a CRM base/target URL for the call-data push (SSRF protection).

    Rejects anything that is not an absolute http(s) URL and blocks requests to
    loopback, link-local (incl. cloud metadata), multicast, reserved and the
    unspecified address. An empty URL is allowed (sync simply does nothing). A
    hostname that does not currently resolve is allowed (it may resolve later);
    any address it *does* resolve to is checked.

    Raises:
        ValueError: if the URL is malformed or resolves to a blocked address.
    """
    raw = (raw or "").strip()
    if not raw:
        return

    parsed = httpx.URL(raw)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("CRM URL scheme must be http or https")
    host = parsed.host
    if not host:
        raise ValueError("CRM URL has no host")

    # Collect the candidate IPs: a literal host is checked directly, otherwise we
    # resolve it. Resolution failure is tolerated (host may come up later).
    ips: List[ipaddress._BaseAddress] = []
    try:
        ips.append(ipaddress.ip_address(host))
    except ValueError:
        try:
            for info in socket.getaddrinfo(host, parsed.port or None, proto=socket.IPPROTO_TCP):
                try:
                    ips.append(ipaddress.ip_address(info[4][0]))
                except ValueError:
                    continue
        except (socket.gaierror, OSError):
            ips = []  # unresolvable now — allow

    for ip in ips:
        if _is_blocked_ip(ip, block_private=block_private, block_loopback=block_loopback):
            raise ValueError(f"CRM URL host resolves to a blocked address ({ip})")


def redact_url(raw: str) -> str:
    """Strip the query string and any embedded credentials from a URL for logging."""
    try:
        u = httpx.URL(raw)
        return str(u.copy_with(query=None, userinfo=b""))
    except Exception:
        return "(crm endpoint)"


# ---------------------------------------------------------------------------
# Sync configuration + payload assembly
# ---------------------------------------------------------------------------
@dataclass
class CRMSyncConfig:
    """Resolved call-data sync configuration (read from settings)."""
    enabled: bool = False
    endpoint: str = ""          # path appended to the connection server_url
    method: str = "POST"        # POST or PUT
    fields: List[str] = field(default_factory=lambda: list(DEFAULT_CRM_SYNC_FIELDS))
    dir_inbound: bool = True
    dir_outbound: bool = True
    dir_internal: bool = True
    block_private: bool = False
    duration_format: str = "hms"                              # "hms" | "seconds"
    status_map: Dict[str, str] = field(default_factory=dict)  # {FROM: TO}, upper-cased
    key_map: Dict[str, str] = field(default_factory=dict)     # {defaultKey: newKey}

    def direction_allowed(self, call_type: Optional[str]) -> bool:
        """Whether a call of this direction should be pushed."""
        if call_type == "inbound":
            return self.dir_inbound
        if call_type == "outbound":
            return self.dir_outbound
        if call_type == "internal":
            return self.dir_internal
        # Unknown/blank direction: push it rather than silently dropping the call.
        return True


# ---------------------------------------------------------------------------
# Contact lookup (3CX-style): number formatting, JSON path extraction,
# name templates and configuration. Pure functions — no AMI/DB/HTTP.
# ---------------------------------------------------------------------------
LOOKUP_NUMBER_FORMATS = ("digits", "as_is", "plus", "zeros")

_PATH_TOKEN_RE = re.compile(r"\[([^\[\]]+)\]")


def format_lookup_number(raw: str, fmt: str = "digits") -> str:
    """
    Format a caller number the way the CRM expects it (mirrors 3CX's Number
    element prefix strategies).

      digits — strip everything but digits:      +20 100… -> 20100…
      as_is  — trimmed raw caller-ID
      plus   — international prefix as '+':      0020… -> +20…, keeps +20…
      zeros  — international prefix as '00':     +20…  -> 0020…
    """
    raw = (raw or "").strip()
    if fmt == "as_is":
        return raw
    has_plus = raw.startswith("+")
    digits = re.sub(r"\D", "", raw)
    if fmt == "plus":
        if digits.startswith("00"):
            return "+" + digits[2:]
        return ("+" + digits) if has_plus else digits
    if fmt == "zeros":
        if has_plus and not digits.startswith("00"):
            return "00" + digits
        return digits
    return digits


def lookup_cache_key(raw: str, match_digits: int = 0) -> str:
    """
    Cache/comparison key for a number: digits only, optionally reduced to the
    last N digits so prefix variants (+20…, 0020…, 0…) share one entry.
    """
    digits = re.sub(r"\D", "", raw or "")
    if match_digits and match_digits > 0:
        digits = digits[-match_digits:]
    return digits[:32]


def extract_json_path(data: Any, path: str) -> Optional[str]:
    """
    Walk a dot/index path like 'data.0.name' through parsed JSON.
    Each segment indexes a dict by key or a list by integer.
    Returns str(leaf) for scalar leaves, None on any miss or type mismatch.
    """
    node = data
    for seg in (path or "").strip().split("."):
        if not seg:
            return None
        if isinstance(node, dict):
            if seg not in node:
                return None
            node = node[seg]
        elif isinstance(node, list):
            try:
                node = node[int(seg)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    if isinstance(node, (str, int, float)) and not isinstance(node, bool):
        text = str(node).strip()
        return text or None
    return None


def render_name_template(data: Any, template: str) -> Optional[str]:
    """
    Render a contact-name template like '[data.0.first_name] [data.0.last_name]'
    against a JSON response. Each [path] token is replaced via extract_json_path;
    a template with no tokens is treated as a single bare path. Returns None when
    no token resolves to a value (literal-only leftovers don't count as a name).
    """
    template = (template or "").strip()
    if not template:
        return None
    if "[" not in template:
        return extract_json_path(data, template)

    resolved_any = False

    def _sub(m: "re.Match[str]") -> str:
        nonlocal resolved_any
        value = extract_json_path(data, m.group(1))
        if value is not None:
            resolved_any = True
            return value
        return ""

    rendered = _PATH_TOKEN_RE.sub(_sub, template)
    if not resolved_any:
        return None
    rendered = re.sub(r"\s+", " ", rendered).strip()
    return rendered or None


def render_lookup_url(url_template: str, raw_number: str, number_format: str = "digits") -> str:
    """
    Substitute the formatted, URL-encoded number into a lookup URL template's
    [Number] placeholder. A template without the placeholder gets
    '?phone=[Number]' appended ('&' if it already has a query string).
    """
    template = (url_template or "").strip()
    if "[Number]" not in template:
        template += ("&" if "?" in template else "?") + "phone=[Number]"
    number = urllib.parse.quote(format_lookup_number(raw_number, number_format), safe="")
    return template.replace("[Number]", number)


@dataclass
class CRMLookupConfig:
    """Resolved contact-lookup configuration (read from settings)."""
    enabled: bool = False
    url_template: str = ""      # path template appended to server_url, with [Number]
    name_template: str = ""     # e.g. "[data.0.first_name] [data.0.last_name]"
    number_format: str = "digits"
    match_digits: int = 0       # compare/cache on last N digits (0 = full)
    verify_path: str = ""       # optional path to the matched record's phone field
    ttl_hours: int = 24

    def usable(self) -> bool:
        return self.enabled and bool(self.url_template) and bool(self.name_template)


def parse_sync_fields(raw: Union[str, List[str], None]) -> List[str]:
    """
    Normalise a stored field selection (CSV string or list) into a clean, ordered
    list limited to known catalog fields. Unknown/blank entries are dropped.
    """
    if raw is None:
        items: List[str] = []
    elif isinstance(raw, str):
        items = raw.split(",")
    else:
        items = list(raw)
    out: List[str] = []
    seen = set()
    for f in items:
        f = (f or "").strip()
        if f and f in _CRM_SYNC_FIELD_SET and f not in seen:
            seen.add(f)
            out.append(f)
    return out


_DURATION_FIELDS = ("duration", "talk_time")

# The outcome-enum fields whose values a status map may rewrite. Both carry the
# same canonical outcome enum (see call_log.CALL_OUTCOMES).
_STATUS_MAPPED_FIELDS = ("call_status", "disposition")

# Fields always emitted as an integer rather than a string (the agent extension
# is a plain number, and CRMs that key on it expect a numeric id). A value that
# can't be parsed as an int is left as-is.
_INT_FIELDS = ("agent",)


def build_crm_payload(all_fields: Dict[str, Any], selected: List[str],
                      duration_format: str = "hms",
                      status_map: Optional[Dict[str, str]] = None,
                      key_map: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """
    Build the CRM push body from the full set of available call values, keeping
    only the operator-selected fields that are actually present. Every field is
    opt-in, including `caller`/`destination` — nothing is forced into the body. A
    value is "present" unless it is None or an empty string — numeric 0 is kept.

    duration_format controls how the time fields (duration, talk_time) are
    rendered: "hms" -> "HH:MM:SS" (default), "seconds" -> integer seconds. The
    conversion is applied whatever the stored form (int or "HH:MM:SS"), so the
    receiver always gets the configured shape.

    The returned dict uses the outbound JSON key names (camelCase, e.g.
    `startTime`, `agentExt`, `status`) — see CRM_SYNC_JSON_KEYS. Internally fields
    are still referenced by their catalog (snake_case) names everywhere else.
    """
    def present(v: Any) -> bool:
        return v is not None and v != ""

    keys: List[str] = []
    for f in selected:
        if f in _CRM_SYNC_FIELD_SET and f not in keys:
            keys.append(f)

    payload = {f: all_fields[f] for f in keys if f in all_fields and present(all_fields[f])}

    to_seconds = (duration_format == "seconds")
    for f in _DURATION_FIELDS:
        if f not in payload:
            continue
        if to_seconds:
            secs = CRMConnector.duration_to_seconds(payload[f])
            if secs is not None:
                payload[f] = secs
        else:
            payload[f] = CRMConnector.normalize_duration(payload[f])

    # Status remap: translate the canonical outcome enum to whatever this CRM
    # accepts (e.g. BUSY -> NO_ANSWER for a CRM enum without BUSY). Matched
    # case-insensitively on the value; an unmapped value passes through unchanged.
    # Applied to the internal keys before the camelCase rename.
    if status_map:
        for f in _STATUS_MAPPED_FIELDS:
            if f in payload and payload[f] is not None:
                payload[f] = status_map.get(str(payload[f]).strip().upper(), payload[f])

    # Numeric fields: always send as an integer, not a string (e.g. the agent
    # extension "305" -> 305). A value that can't be parsed as an int is left
    # as-is rather than dropped or nulled.
    for f in _INT_FIELDS:
        if f in payload and not isinstance(payload[f], bool):
            try:
                payload[f] = int(str(payload[f]).strip())
            except (TypeError, ValueError):
                pass  # unparseable -> leave the original value untouched

    # Rename internal snake_case keys to their outbound camelCase JSON names,
    # preserving insertion order. This is the single place the wire format is
    # decided.
    out = {_outbound_json_key(k, to_seconds=to_seconds): v for k, v in payload.items()}

    # Operator outbound-key rename: any default key may be renamed to whatever the
    # CRM expects (e.g. agentExt -> agentId). Applied last, on the already-camelCased
    # keys, preserving order.
    #
    # Collision guard: a rename target that would land on a key already in the body
    # (another rename's target, or an unrenamed default key) is DROPPED — the source
    # keeps its original key instead of clobbering the other value. This prevents a
    # mis-configured map (two fields -> the same key) from silently losing a value;
    # without it, dict-build would let the last writer win.
    if key_map:
        # In seconds mode the duration fields go out as talkTimeInSeconds/
        # durationInSeconds, but the Settings UI keys the rename on the HH:MM:SS
        # form (talkTime/duration). Translate those source keys to the active form
        # so the rename matches the real wire key.
        if to_seconds:
            key_map = {
                {"talkTime": "talkTimeInSeconds", "duration": "durationInSeconds"}.get(k, k): v
                for k, v in key_map.items()
            }
        renamed: Dict[str, Any] = {}
        for k, v in out.items():
            target = key_map.get(k, k)
            if target != k and target in out:
                # Target is (or will be) a real key from another field — refuse the
                # rename and keep the original key so no value is dropped.
                log.warning(
                    "CRM key rename %r -> %r skipped: target collides with an "
                    "existing field; keeping %r", k, target, k)
                target = k
            if target in renamed:
                # Two sources already resolved to the same target this pass — keep
                # the first, drop the rename for the later one to avoid overwrite.
                log.warning(
                    "CRM key %r skipped: %r already emitted by another field", k, target)
                target = k
                if target in renamed:
                    continue  # even the original key is taken; nothing safe to do
            renamed[target] = v
        out = renamed

    return out

