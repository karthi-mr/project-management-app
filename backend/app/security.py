import ipaddress
import os
import re
import secrets
import string
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import DATA_DIR, get_db
from .models import User

ALGORITHM = "HS256"
TOKEN_TTL_HOURS = int(os.getenv("PM_TOKEN_TTL_HOURS", "12"))


def _load_secret() -> str:
    env = os.getenv("PM_SECRET_KEY")
    if env:
        return env
    path = DATA_DIR / ".secret_key"
    if path.exists():
        return path.read_text().strip()
    secret = secrets.token_urlsafe(48)
    path.write_text(secret)
    path.chmod(0o600)
    return secret


SECRET_KEY = _load_secret()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def validate_password(password: str, org=None) -> None:
    """Raise 422 when the password does not meet the policy (the workspace's own, when it has one)."""
    problems = []
    minimum = max(8, (org.password_min_length or 8) if org is not None else 8)
    if len(password) < minimum:
        problems.append(f"at least {minimum} characters")
    if org is not None and org.password_require_mixed_case and not (re.search(r"[a-z]", password) and re.search(r"[A-Z]", password)):
        problems.append("upper and lower case letters")
    if org is not None and org.password_require_symbol and not re.search(r"[^A-Za-z0-9]", password):
        problems.append("a symbol")
    if len(password.encode("utf-8")) > 72:
        problems.append("at most 72 bytes")
    if not re.search(r"[A-Za-z]", password):
        problems.append("a letter")
    if not re.search(r"\d", password):
        problems.append("a number")
    if problems:
        raise HTTPException(422, "Password must contain " + ", ".join(problems) + ".")


def generate_password(length: int = 12) -> str:
    # Avoid look-alike characters so the password is easy to hand over.
    letters = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
    digits = "23456789"
    symbols = "!@#$%*?"
    alphabet = letters + digits + symbols
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if (
            any(c in string.ascii_lowercase for c in pw)
            and any(c in string.ascii_uppercase for c in pw)
            and any(c in digits for c in pw)
            and any(c in symbols for c in pw)
        ):
            return pw


def parse_allowlist(text: str, strict: bool = False) -> list:
    """Addresses and CIDR ranges, one per line. Bad lines raise ValueError(line) when strict."""
    networks = []
    for line in (text or "").replace(",", "\n").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            networks.append(ipaddress.ip_network(line, strict=False))
        except ValueError:
            if strict:
                raise ValueError(line)
    return networks


def create_token(user: User, db: Session | None = None) -> str:
    """Sign a token. With a database session it is tied to a session record that can be ended."""
    payload = {
        "sub": str(user.id),
        "ver": user.token_version,
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HOURS),
    }
    if db is not None:
        from .access import request_agent, request_ip
        from .models import UserSession

        key = secrets.token_urlsafe(24)
        db.add(UserSession(user_id=user.id, key=key, ip=request_ip.get()[:60], user_agent=request_agent.get()))
        db.commit()
        payload["sid"] = key
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


_bearer = HTTPBearer(auto_error=False)


def get_token_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """Authenticated user, even if they still have to change their password."""
    unauthorized = HTTPException(
        status.HTTP_401_UNAUTHORIZED, "Not authenticated", {"WWW-Authenticate": "Bearer"}
    )
    if creds is None:
        raise unauthorized
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise unauthorized
    user = db.get(User, user_id)
    if not user or not user.is_active or payload.get("ver") != user.token_version:
        raise unauthorized
    from .access import request_ip
    from .models import Organization, UserSession

    # Tokens issued since sessions exist name one, so it can be ended from another device.
    key = payload.get("sid")
    if key:
        live = db.scalar(select(UserSession).where(UserSession.key == key))
        if live is None or live.revoked or live.user_id != user.id:
            raise unauthorized
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        if (now - live.last_seen_at).total_seconds() > 300:
            live.last_seen_at = now
            live.ip = request_ip.get()[:60] or live.ip
            db.commit()
        db.info["session_key"] = key  # which of the person's sessions this request belongs to

    # A workspace can restrict sign-ins to its own networks.
    org = db.get(Organization, user.org_id) if user.org_id else None
    if org is not None and org.ip_allowlist:
        from .saas import has_feature

        networks = parse_allowlist(org.ip_allowlist) if has_feature(db, org.id, "security") else []
        if networks:
            try:
                address = ipaddress.ip_address(request_ip.get())
                allowed = any(address in n for n in networks)
            except ValueError:
                allowed = False
            if not allowed:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Your workspace only allows access from approved networks.")

    # From here on this session only sees the caller's workspace (see models._isolate_workspace).
    db.info["org_id"] = user.org_id
    return user


# While a license is expired or suspended the workspace is read-only, except for these areas.
WRITABLE_WHEN_LOCKED = ("/api/auth/", "/api/billing", "/api/platform", "/api/notifications", "/api/support", "/api/onboarding")


def get_current_user(user: User = Depends(get_token_user), db: Session = Depends(get_db)) -> User:
    """Authenticated user who has completed the mandatory password change, in a workspace
    that is allowed to make this request."""
    if user.must_change_password:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "PASSWORD_CHANGE_REQUIRED")
    from .access import is_write_request, request_path
    from .saas import get_org, license_status

    if is_write_request() and not request_path.get().startswith(WRITABLE_WHEN_LOCKED):
        state = license_status(get_org(db, user))
        if state == "suspended":
            raise HTTPException(402, "This workspace is suspended. Contact support to restore it.")
        if state == "expired":
            raise HTTPException(
                402,
                "Your workspace's license has expired, so it is read-only. "
                "An administrator can renew it on the Billing page.",
            )
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator access required")
    return user


def require_platform_admin(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> User:
    """The person who runs the SaaS. Their console works across every workspace."""
    if not user.is_platform_admin:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    db.info.pop("org_id", None)
    return user
