"""
scripts/create_admin.py — Helper to generate and save secure password hash to .env
==================================================================================
Usage:
    python scripts/create_admin.py [username] [password]
"""

import os
import sys
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from api.auth import hash_password

def update_env_file(username: str, pw_hash: str):
    env_path = PROJECT_ROOT / ".env"
    lines = []
    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

    # Filter out existing admin keys if already present
    new_lines = []
    for line in lines:
        if line.startswith("ADMIN_USERNAME=") or line.startswith("ADMIN_PASSWORD_HASH="):
            continue
        new_lines.append(line)

    # Ensure trailing newline
    if new_lines and not new_lines[-1].endswith("\n"):
        new_lines[-1] += "\n"

    new_lines.append(f"ADMIN_USERNAME={username}\n")
    new_lines.append(f"ADMIN_PASSWORD_HASH={pw_hash}\n")

    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

    print(f"\n[OK] Automatically saved credentials to {env_path.name}:")
    print(f"     ADMIN_USERNAME={username}")
    print(f"     ADMIN_PASSWORD_HASH={pw_hash[:16]}... (PBKDF2 Salted Hash)\n")

def main():
    username = sys.argv[1] if len(sys.argv) > 1 else input("Enter admin username [admin]: ").strip() or "admin"
    password = sys.argv[2] if len(sys.argv) > 2 else input("Enter admin password: ").strip()

    if not password:
        print("Password cannot be empty.")
        return

    pw_hash = hash_password(password)
    update_env_file(username, pw_hash)

if __name__ == "__main__":
    main()
