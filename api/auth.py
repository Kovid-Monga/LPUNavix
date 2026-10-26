"""
api/auth.py — Secure Admin Authentication for LPUNavix
======================================================
- PBKDF2-HMAC-SHA256 password hashing with cryptographic salt
- HMAC-SHA256 signed session tokens with expiration
- Server-side immediate token revocation on logout
- Per-IP login rate limiting (5 attempts per 5 minutes)
"""

import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict
from typing import Dict, Optional, Set
from fastapi import Header, HTTPException, Request

# In-memory storage for revoked tokens & active sessions
ACTIVE_SESSIONS: Set[str] = set()
REVOKED_TOKENS: Set[str] = set()

# Login rate-limiting: ip -> list of failure timestamps
FAILED_LOGIN_ATTEMPTS: Dict[str, list] = defaultdict(list)
RATE_LIMIT_WINDOW = 300  # 5 minutes
MAX_FAILED_ATTEMPTS = 5

# Session validity
SESSION_DURATION_SECONDS = 4 * 3600  # 4 hours


def get_secret_key() -> bytes:
    key = os.getenv("SESSION_SECRET_KEY")
    if not key:
        key = "lpunavix-secure-session-key-2026-prod-fallback"
    return key.encode("utf-8")


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    if salt is None:
        salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100_000)
    return f"{salt.hex()}${dk.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, dk_hex = stored_hash.split("$")
        salt = bytes.fromhex(salt_hex)
        expected_dk = bytes.fromhex(dk_hex)
        actual_dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100_000)
        return hmac.compare_digest(actual_dk, expected_dk)
    except Exception:
        return False


def get_admin_credentials() -> Dict[str, str]:
    username = os.getenv("ADMIN_USERNAME", "admin")
    pw_hash = os.getenv("ADMIN_PASSWORD_HASH")
    if not pw_hash:
        # Default bootstrap hash for initial setup if not yet configured in .env (password: "admin123")
        # Can be changed via scripts/create_admin.py or editing .env
        pw_hash = "385e87001125022145d00411209c28d9$980365b2e844aaa905fae14d774b05421e7fe4b5deeebe125d3341e06e1a2b3d"
    return {"username": username, "hash": pw_hash}


def is_rate_limited(ip: str) -> bool:
    now = time.time()
    attempts = [t for t in FAILED_LOGIN_ATTEMPTS[ip] if now - t < RATE_LIMIT_WINDOW]
    FAILED_LOGIN_ATTEMPTS[ip] = attempts
    return len(attempts) >= MAX_FAILED_ATTEMPTS


def record_failed_attempt(ip: str):
    FAILED_LOGIN_ATTEMPTS[ip].append(time.time())


def clear_failed_attempts(ip: str):
    FAILED_LOGIN_ATTEMPTS.pop(ip, None)


def create_session_token(username: str) -> str:
    token_id = secrets.token_hex(16)
    expires_at = int(time.time()) + SESSION_DURATION_SECONDS
    payload = f"{token_id}:{username}:{expires_at}"
    sig = hmac.new(get_secret_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    token = f"{payload}:{sig}"
    ACTIVE_SESSIONS.add(token)
    return token


def verify_session_token(token: str) -> Optional[str]:
    if not token or token in REVOKED_TOKENS or token not in ACTIVE_SESSIONS:
        return None
    try:
        parts = token.split(":")
        if len(parts) != 4:
            return None
        token_id, username, exp_str, sig = parts
        payload = f"{token_id}:{username}:{exp_str}"
        expected_sig = hmac.new(get_secret_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        if int(exp_str) < time.time():
            ACTIVE_SESSIONS.discard(token)
            return None
        return username
    except Exception:
        return None


def revoke_session(token: str):
    ACTIVE_SESSIONS.discard(token)
    REVOKED_TOKENS.add(token)


def get_current_admin(request: Request, authorization: Optional[str] = Header(None)) -> str:
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
    if not token:
        token = request.cookies.get("lpunavix_admin_token")
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    username = verify_session_token(token)
    if not username:
        raise HTTPException(status_code=401, detail="Session expired or invalid. Please log in again.")
    return username
