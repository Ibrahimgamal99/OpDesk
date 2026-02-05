#!/usr/bin/env python3
"""
CRM Receiver Server

A simple Python server that receives call data from CRM connector using Basic Auth.
This server can be used for testing or as a standalone receiver service.
"""

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional
from dotenv import load_dotenv

from fastapi import FastAPI, Request, HTTPException, Depends, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.responses import JSONResponse
import uvicorn

# Load environment variables
load_dotenv()

# Setup logging to file
log_dir = Path(__file__).parent.parent / "logs"
log_dir.mkdir(exist_ok=True)

# Create log file with timestamp
log_filename = log_dir / f"crm_receiver_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

# Configure logging with both file and console handlers
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_filename, encoding='utf-8'),
        logging.StreamHandler()  # Also log to console
    ]
)
log = logging.getLogger(__name__)

# Filter to suppress "change detected" messages from Uvicorn's WatchFiles reloader
class SuppressChangeDetectedFilter(logging.Filter):
    def filter(self, record):
        return "change detected" not in record.getMessage().lower()

# Suppress "change detected" messages from Uvicorn's WatchFiles reloader
watchfiles_logger = logging.getLogger("watchfiles")
watchfiles_logger.setLevel(logging.WARNING)

# Apply filter to root logger to catch all "change detected" messages
root_logger = logging.getLogger()
root_logger.addFilter(SuppressChangeDetectedFilter())

# Basic Auth security
security = HTTPBasic()

# Configuration
RECEIVER_USERNAME = os.getenv('CRM_RECEIVER_USERNAME', 'admin')
RECEIVER_PASSWORD = os.getenv('CRM_RECEIVER_PASSWORD', 'password')
RECEIVER_PORT = int(os.getenv('CRM_RECEIVER_PORT', '8888'))
RECEIVER_HOST = os.getenv('CRM_RECEIVER_HOST', '0.0.0.0')

# In-memory storage for received call data (optional - can be replaced with database)
received_calls: list = []


def verify_credentials(credentials: HTTPBasicCredentials = Depends(security)) -> str:
    """
    Verify Basic Auth credentials.
    
    Args:
        credentials: HTTP Basic Auth credentials
        
    Returns:
        Username if credentials are valid
        
    Raises:
        HTTPException: If credentials are invalid
    """
    if credentials.username != RECEIVER_USERNAME or credentials.password != RECEIVER_PASSWORD:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Basic"},
        )
    return credentials.username


# FastAPI app
app = FastAPI(
    title="CRM Receiver Server",
    description="Receives call data from CRM connector using Basic Auth",
    version="1.0.0"
)


@app.get("/")
async def root():
    """Root endpoint - health check."""
    return {
        "service": "CRM Receiver Server",
        "status": "running",
        "endpoints": {
            "receive_calls": "/api/calls",
            "get_calls": "/api/calls/received",
            "health": "/health"
        }
    }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "received_calls_count": len(received_calls)
    }


@app.post("/api/calls")
async def receive_call_data(
    call_data: Dict[str, Any],
    request: Request,
    username: str = Depends(verify_credentials)
):
    """
    Receive call data from CRM connector.
    
    This endpoint accepts POST requests with Basic Auth and receives call data
    in the format sent by the CRM connector.
    
    Expected call_data fields:
        - caller: Caller extension/number
        - destination: Destination extension/number
        - duration: Call duration (optional)
        - datetime: Call datetime (optional)
        - call_status: Call status (optional)
        - queue: Queue name (optional)
        - call_type: Call type (optional)
        - Additional custom fields
    
    Returns:
        Success response with received data
    """
    try:
        # Add metadata
        call_record = {
            "received_at": datetime.now().isoformat(),
            "received_by": username,
            "client_ip": request.client.host if request.client else "unknown",
            "call_data": call_data
        }
        
        # Store in memory (you can replace this with database storage)
        received_calls.append(call_record)
        
        # Keep only last 1000 records to prevent memory issues
        if len(received_calls) > 1000:
            received_calls.pop(0)
        
        # Log received call data to file
        log.info("=" * 80)
        log.info(f"📞 CALL DATA RECEIVED")
        log.info(f"   Timestamp: {call_record['received_at']}")
        log.info(f"   Received by: {username}")
        log.info(f"   Client IP: {call_record['client_ip']}")
        log.info(f"   Caller: {call_data.get('caller', 'N/A')}")
        log.info(f"   Destination: {call_data.get('destination', 'N/A')}")
        log.info(f"   Duration: {call_data.get('duration', 'N/A')}")
        log.info(f"   Call Status: {call_data.get('call_status', 'N/A')}")
        log.info(f"   Call Type: {call_data.get('call_type', 'N/A')}")
        log.info(f"   Queue: {call_data.get('queue', 'N/A')}")
        log.info(f"   DateTime: {call_data.get('datetime', 'N/A')}")
        
        # Log full JSON data
        log.info(f"   Full Data: {json.dumps(call_data, indent=2, ensure_ascii=False)}")
        log.info("=" * 80)
        
        # Return success response
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={
                "success": True,
                "message": "Call data received successfully",
                "received_at": call_record["received_at"],
                "call_id": f"{call_data.get('caller', 'unknown')}-{call_data.get('destination', 'unknown')}-{datetime.now().timestamp()}"
            }
        )
    
    except Exception as e:
        log.error("=" * 80)
        log.error(f"❌ ERROR PROCESSING CALL DATA")
        log.error(f"   Error: {str(e)}")
        log.error(f"   Call Data: {json.dumps(call_data, indent=2, ensure_ascii=False)}")
        log.error("=" * 80)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error processing call data: {str(e)}"
        )


@app.get("/api/calls/received")
async def get_received_calls(
    limit: int = 100,
    username: str = Depends(verify_credentials)
):
    """
    Get list of received call data.
    
    Args:
        limit: Maximum number of records to return (default: 100, max: 1000)
        username: Authenticated username (from Basic Auth)
    
    Returns:
        List of received call records
    """
    limit = min(limit, 1000)  # Cap at 1000
    
    # Return most recent calls first
    recent_calls = received_calls[-limit:] if len(received_calls) > limit else received_calls
    recent_calls.reverse()  # Most recent first
    
    return {
        "total_received": len(received_calls),
        "returned": len(recent_calls),
        "calls": recent_calls
    }


@app.delete("/api/calls/received")
async def clear_received_calls(username: str = Depends(verify_credentials)):
    """
    Clear all received call data.
    
    Args:
        username: Authenticated username (from Basic Auth)
    
    Returns:
        Success message
    """
    count = len(received_calls)
    received_calls.clear()
    
    log.info(f"Cleared {count} call records by {username}")
    
    return {
        "success": True,
        "message": f"Cleared {count} call records"
    }


@app.head("/api/calls")
async def head_calls(username: str = Depends(verify_credentials)):
    """
    HEAD request endpoint for connection testing.
    Returns 200 OK if authentication is valid.
    """
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={}
    )


if __name__ == "__main__":
    log.info("=" * 80)
    log.info("🚀 Starting CRM Receiver Server")
    log.info(f"   Host: {RECEIVER_HOST}")
    log.info(f"   Port: {RECEIVER_PORT}")
    log.info(f"   Username: {RECEIVER_USERNAME}")
    log.info(f"   Endpoint: http://{RECEIVER_HOST}:{RECEIVER_PORT}/api/calls")
    log.info(f"   Log File: {log_filename}")
    log.info("=" * 80)
    
    uvicorn.run(
        "crm_receiver:app",
        host=RECEIVER_HOST,
        port=RECEIVER_PORT,
        reload=True,
        log_level="info"
    )

