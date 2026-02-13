#!/usr/bin/env python3
"""
CRM Connector Interface

A unified interface for integrating with multiple CRM systems using different
authentication methods: API Key, Basic Auth, Bearer Token, and OAuth2.

This connector sends call data to CRM systems in a standardized format.
"""

import asyncio
import base64
import json
import logging
from enum import Enum
from typing import Dict, Optional, Any, Union
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
        method: str = "POST"
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
        # Validate required fields
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
        kwargs["api_key_header"] = config.get("api_key_header", "X-API-Key")
    
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

