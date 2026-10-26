"""
api/blocks.py — Road & Footpath Closure Management Router (FastAPI)
==================================================================
- Manages road/footpath closures for LPUNavix
- Atomic file persistence to data/road_blocks.json
- Append-only audit logging to data/blocks_audit.log
- Automatic expiration filtering
- Protected admin management endpoints
"""

import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from api.auth import (
    clear_failed_attempts,
    create_session_token,
    get_admin_credentials,
    get_current_admin,
    is_rate_limited,
    record_failed_attempt,
    revoke_session,
    verify_password,
    verify_session_token,
)

router = APIRouter(tags=["Road Blocks & Admin"])

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
BLOCKS_FILE = DATA_DIR / "road_blocks.json"
AUDIT_LOG_FILE = DATA_DIR / "blocks_audit.log"


def ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not BLOCKS_FILE.exists():
        atomic_write_json(BLOCKS_FILE, [])


def atomic_write_json(filepath: Path, data: Any):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = filepath.with_suffix(".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, filepath)


def log_audit(username: str, action: str, block_id: str, details: str):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat()
    line = f"[{timestamp}] [USER:{username}] [ACTION:{action}] [BLOCK_ID:{block_id}] {details}\n"
    with open(AUDIT_LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line)


def load_raw_blocks() -> List[Dict[str, Any]]:
    ensure_data_dir()
    try:
        with open(BLOCKS_FILE, "r", encoding="utf-8") as f:
            blocks = json.load(f)
            if not isinstance(blocks, list):
                return []
            return blocks
    except Exception:
        return []


def get_active_blocks() -> List[Dict[str, Any]]:
    blocks = load_raw_blocks()
    now_ts = time.time()
    active = []
    expired_found = False

    for b in blocks:
        expires_at = b.get("expiresAt")
        if expires_at:
            try:
                # ISO parsing
                dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                if dt.timestamp() < now_ts:
                    expired_found = True
                    continue
            except Exception:
                pass
        active.append(b)

    if expired_found:
        atomic_write_json(BLOCKS_FILE, active)

    return active


# ---------------- Models ----------------

class LoginRequest(BaseModel):
    username: str
    password: str


class CreateBlockRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    type: str = Field(..., pattern="^(segment|way)$")
    refId: str = Field(..., min_length=1)  # canonical segment ID or way ID
    wayId: Optional[Any] = None
    coords: List[List[float]] = Field(..., min_items=2)
    markerCoord: Optional[List[float]] = None
    reason: str = Field(..., min_length=1, max_length=200)
    modes: List[str] = Field(default_factory=lambda: ["walking", "kart"])  # walking, kart, all
    expiresAt: Optional[str] = None


# ---------------- Public Endpoints ----------------

@router.get("/api/blocks")
def get_blocks():
    """
    Public sanitized endpoint: Returns all currently active road closures.
    Excludes sensitive internal admin metadata.
    """
    active = get_active_blocks()
    sanitized = []
    for b in active:
        sanitized.append({
            "id": b.get("id"),
            "name": b.get("name"),
            "type": b.get("type"),
            "refId": b.get("refId"),
            "wayId": b.get("wayId"),
            "coords": b.get("coords"),
            "markerCoord": b.get("markerCoord"),
            "reason": b.get("reason"),
            "modes": b.get("modes", ["walking", "kart"]),
            "createdAt": b.get("createdAt"),
            "expiresAt": b.get("expiresAt"),
        })
    return sanitized


# ---------------- Admin Auth Endpoints ----------------

@router.post("/api/admin/login")
def admin_login(payload: LoginRequest, request: Request, response: Response):
    client_ip = request.client.host if request.client else "unknown"

    if is_rate_limited(client_ip):
        raise HTTPException(
            status_code=429,
            detail="Too many failed login attempts. Please wait 5 minutes before trying again."
        )

    creds = get_admin_credentials()
    if payload.username != creds["username"] or not verify_password(payload.password, creds["hash"]):
        record_failed_attempt(client_ip)
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    clear_failed_attempts(client_ip)
    token = create_session_token(payload.username)

    # Set secure SameSite cookie
    response.set_cookie(
        key="lpunavix_admin_token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=14400,
        secure=False  # Allow local development and ngrok/http
    )

    log_audit(payload.username, "LOGIN", "-", f"Logged in from {client_ip}")
    return {"status": "ok", "token": token, "username": payload.username}


@router.post("/api/admin/logout")
def admin_logout(request: Request, response: Response):
    auth_header = request.headers.get("authorization", "")
    token = auth_header[7:].strip() if auth_header.startswith("Bearer ") else request.cookies.get("lpunavix_admin_token")
    if token:
        user = verify_session_token(token) or "unknown"
        revoke_session(token)
        log_audit(user, "LOGOUT", "-", "Admin logged out; session revoked")

    response.delete_cookie("lpunavix_admin_token")
    return {"status": "ok", "message": "Logged out successfully"}


@router.get("/api/admin/me")
def check_admin_session(current_user: str = Depends(get_current_admin)):
    return {"status": "ok", "username": current_user}


# ---------------- Protected Road Block Endpoints ----------------

@router.post("/api/admin/blocks")
def create_block(payload: CreateBlockRequest, current_user: str = Depends(get_current_admin)):
    blocks = load_raw_blocks()

    block_id = f"blk_{uuid.uuid4().hex[:12]}"
    now_iso = datetime.now(timezone.utc).isoformat()

    new_block = {
        "id": block_id,
        "name": payload.name,
        "type": payload.type,
        "refId": payload.refId,
        "wayId": str(payload.wayId) if payload.wayId is not None else None,
        "coords": payload.coords,
        "markerCoord": payload.markerCoord,
        "reason": payload.reason,
        "modes": payload.modes,
        "createdAt": now_iso,
        "expiresAt": payload.expiresAt,
        "createdBy": current_user
    }

    # Avoid duplicate refId if identical block already active
    blocks = [b for b in blocks if b.get("refId") != payload.refId]
    blocks.append(new_block)

    atomic_write_json(BLOCKS_FILE, blocks)
    log_audit(current_user, "CREATE_BLOCK", block_id, f"Blocked {payload.type} '{payload.name}' ({payload.refId}): {payload.reason}")

    return {"status": "ok", "block": new_block}


@router.delete("/api/admin/blocks/{block_id}")
def delete_block(block_id: str, current_user: str = Depends(get_current_admin)):
    blocks = load_raw_blocks()
    initial_len = len(blocks)
    target = next((b for b in blocks if b.get("id") == block_id), None)

    if not target:
        raise HTTPException(status_code=404, detail="Block not found.")

    blocks = [b for b in blocks if b.get("id") != block_id]
    atomic_write_json(BLOCKS_FILE, blocks)
    log_audit(current_user, "DELETE_BLOCK", block_id, f"Unblocked {target.get('name', 'path')} ({target.get('refId')})")

    return {"status": "ok", "message": "Block removed successfully."}
