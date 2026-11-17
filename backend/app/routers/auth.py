import json
import re
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..database import get_db
from ..models import Organization, PasswordResetRequest, User, format_public_id, utcnow
from .. import twofactor
from ..security import (
    create_challenge,
    create_token,
    read_challenge,
    get_current_user,
    get_token_user,
    hash_password,
    validate_password,
    verify_password,
)
from ..saas import get_org, org_out
from ..serializers import user_full

router = APIRouter(prefix="/api/auth", tags=["auth"])


def me_out(db: Session, user: User) -> dict:
    """The signed-in user together with their workspace and its license."""
    org = get_org(db, user)
    return {
        **user_full(user),
        "org": org_out(db, org),
        # The workspace requires two-factor sign-in and this person has not set it up yet.
        "two_factor_setup_required": user.totp_enabled_at is None and bool(org.require_two_factor),
    }

# Simple in-memory brute-force throttle: 5 failures -> 10 minute lockout.
MAX_FAILURES = 5
LOCK_SECONDS = 600
_failures: dict[str, tuple[int, float]] = {}


class LoginIn(BaseModel):
    workspace: str = Field(min_length=1, max_length=60)  # the 8-digit workspace ID, or its sign-in address
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=200)


class TwoFactorLoginIn(BaseModel):
    challenge: str = Field(min_length=1, max_length=2000)
    code: str = Field(min_length=1, max_length=40)  # a 6-digit code or a recovery code


class CodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=40)


class DisableTwoFactorIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=1, max_length=40)


class ChangePasswordIn(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(max_length=200)


class FindWorkspaceIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=200)


class ForgotIn(BaseModel):
    workspace: str = Field(min_length=1, max_length=60)
    identifier: str = Field(min_length=1, max_length=255)
    note: str = Field(default="", max_length=500)


class ProfileIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr


class AvatarIn(BaseModel):
    url: str | None = Field(default=None, max_length=200)


class PreferencesIn(BaseModel):
    preferences: dict


_DUMMY: list[str] = []


def _dummy_hash() -> str:
    if not _DUMMY:
        _DUMMY.append(hash_password("not-a-real-password"))
    return _DUMMY[0]


def find_workspace(db: Session, value: str) -> Organization | None:
    """A workspace by its 8-digit ID (spaces and dashes allowed) or by its sign-in address."""
    raw = value.strip().lower()
    digits = re.sub(r"[\s-]", "", raw)
    if re.fullmatch(r"\d{8}", digits):
        return db.scalar(select(Organization).where(Organization.public_id == digits))
    if re.fullmatch(r"[a-z0-9-]{3,40}", raw):
        return db.scalar(select(Organization).where(Organization.slug == raw))
    return None


def _find_user(db: Session, workspace: str, identifier: str) -> User | None:
    org = find_workspace(db, workspace)
    if org is None:
        return None
    ident = identifier.strip().lower()
    return db.scalar(
        select(User).where(
            User.org_id == org.id,
            or_(func.lower(User.username) == ident, func.lower(User.email) == ident),
        )
    )


@router.post("/login")
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)):
    workspace_key = re.sub(r"[\s-]", "", data.workspace.strip().lower())
    key = f"{workspace_key}:{data.username.strip().lower()}"
    count, since = _failures.get(key, (0, 0.0))
    if count >= MAX_FAILURES:
        if time.time() - since < LOCK_SECONDS:
            raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")
        _failures.pop(key, None)
        count = 0

    user = _find_user(db, data.workspace, data.username)
    # Check a password even when nobody matched, so the answer takes as long either way.
    password_ok = verify_password(data.password, user.password_hash if user else _dummy_hash())
    if not user or not password_ok:
        _failures[key] = (count + 1, time.time())
        if user:
            audit(db, user, "login.failed", "Wrong password", request, actor_name=user.username)
            db.commit()
        # The same answer whether the workspace, the person or the password was wrong, so nobody
        # can find out which workspace IDs exist by trying them.
        raise HTTPException(401, "Incorrect workspace ID, username or password")
    if not user.is_active:
        raise HTTPException(403, "This account is disabled. Contact your administrator.")

    _failures.pop(key, None)
    if user.totp_enabled_at is not None:
        # The password was right; the authenticator code comes next.
        audit(db, user, "login.password_ok", "Waiting for the two-factor code", request)
        db.commit()
        return {"two_factor_required": True, "challenge": create_challenge(user)}
    user.last_login = utcnow()
    audit(db, user, "login.success", "", request)
    db.commit()
    return {"access_token": create_token(user, db), "user": me_out(db, user)}


def _throttle(key: str) -> int:
    count, since = _failures.get(key, (0, 0.0))
    if count >= MAX_FAILURES:
        if time.time() - since < LOCK_SECONDS:
            raise HTTPException(429, "Too many wrong codes. Try again in a few minutes.")
        _failures.pop(key, None)
        return 0
    return count


def _verify_second_factor(db: Session, user: User, code: str) -> str | None:
    """Accept an authenticator code or an unused recovery code. Returns which one, or None."""
    step = twofactor.check_code(user.totp_secret or "", code, user.totp_last_step)
    if step is not None:
        user.totp_last_step = step
        return "code"
    remaining = twofactor.use_recovery_code(user.recovery_codes, code)
    if remaining is not None:
        user.recovery_codes = remaining
        return "recovery"
    return None


@router.post("/login/2fa")
def login_two_factor(data: TwoFactorLoginIn, request: Request, db: Session = Depends(get_db)):
    """Second step of signing in: the code from the authenticator app, or a recovery code."""
    found = read_challenge(data.challenge)
    if not found:
        raise HTTPException(401, "This sign-in has expired. Enter your password again.")
    user = db.get(User, found[0])
    if not user or not user.is_active or user.token_version != found[1] or user.totp_enabled_at is None:
        raise HTTPException(401, "This sign-in has expired. Enter your password again.")
    key = f"2fa:{user.id}"
    count = _throttle(key)
    used = _verify_second_factor(db, user, data.code)
    if used is None:
        _failures[key] = (count + 1, time.time())
        audit(db, user, "login.failed", "Wrong two-factor code", request)
        db.commit()
        raise HTTPException(401, "That code is not right. Check your authenticator app and try again.")
    _failures.pop(key, None)
    user.last_login = utcnow()
    left = twofactor.recovery_left(user.recovery_codes)
    audit(db, user, "login.success", "With a recovery code" if used == "recovery" else "With two-factor code", request)
    db.commit()
    out = {"access_token": create_token(user, db), "user": me_out(db, user)}
    if used == "recovery":
        out["recovery_codes_left"] = left
    return out


# ───────────── Setting up two-factor sign-in ─────────────


def _two_factor_out(db: Session, user: User) -> dict:
    org = get_org(db, user)
    return {
        "enabled": user.totp_enabled_at is not None,
        "enabled_at": user.totp_enabled_at.isoformat(timespec="seconds") + "Z" if user.totp_enabled_at else None,
        "recovery_codes_left": twofactor.recovery_left(user.recovery_codes) if user.totp_enabled_at else 0,
        "required": bool(org.require_two_factor),
    }


@router.get("/2fa")
def two_factor_status(user: User = Depends(get_token_user), db: Session = Depends(get_db)):
    return _two_factor_out(db, user)


@router.post("/2fa/setup")
def two_factor_setup(user: User = Depends(get_token_user), db: Session = Depends(get_db)):
    """Start setting up: a new secret to scan. Nothing changes until it is confirmed with a code."""
    if user.must_change_password:
        raise HTTPException(403, "PASSWORD_CHANGE_REQUIRED")
    if user.totp_enabled_at is not None:
        raise HTTPException(400, "Two-factor sign-in is already on. Turn it off first to move it to a new phone.")
    from ..saas import get_settings

    secret = twofactor.new_secret()
    user.totp_pending_secret = secret
    db.commit()
    issuer = get_settings(db)["company_name"] or "Trackly"
    uri = twofactor.provisioning_uri(secret, user.email or user.username, issuer)
    return {"secret": " ".join(secret[i:i + 4] for i in range(0, len(secret), 4)), "uri": uri, "qr_svg": twofactor.qr_svg(uri)}


@router.post("/2fa/enable")
def two_factor_enable(data: CodeIn, request: Request, user: User = Depends(get_token_user), db: Session = Depends(get_db)):
    """Confirm setup with the first code from the app. Returns the recovery codes, shown only now."""
    if user.must_change_password:
        raise HTTPException(403, "PASSWORD_CHANGE_REQUIRED")
    if user.totp_enabled_at is not None:
        raise HTTPException(400, "Two-factor sign-in is already on")
    if not user.totp_pending_secret:
        raise HTTPException(400, "Start the setup again")
    key = f"2fa:{user.id}"
    count = _throttle(key)
    step = twofactor.check_code(user.totp_pending_secret, data.code)
    if step is None:
        _failures[key] = (count + 1, time.time())
        raise HTTPException(422, "That code is not right. Make sure your phone's clock is set automatically, then try the newest code.")
    _failures.pop(key, None)
    codes, stored = twofactor.new_recovery_codes()
    user.totp_secret = user.totp_pending_secret
    user.totp_pending_secret = None
    user.totp_last_step = step
    user.totp_enabled_at = utcnow()
    user.recovery_codes = stored
    audit(db, user, "2fa.enabled", "", request)
    db.commit()
    return {"recovery_codes": codes, "user": me_out(db, user)}


@router.post("/2fa/disable")
def two_factor_disable(data: DisableTwoFactorIn, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if user.totp_enabled_at is None:
        raise HTTPException(400, "Two-factor sign-in is not on")
    if get_org(db, user).require_two_factor:
        raise HTTPException(403, "Your workspace requires two-factor sign-in, so it cannot be turned off.")
    if not verify_password(data.password, user.password_hash):
        raise HTTPException(403, "That password is not correct")
    key = f"2fa:{user.id}"
    count = _throttle(key)
    if _verify_second_factor(db, user, data.code) is None:
        _failures[key] = (count + 1, time.time())
        raise HTTPException(403, "That code is not right")
    _failures.pop(key, None)
    user.totp_secret = None
    user.totp_pending_secret = None
    user.totp_enabled_at = None
    user.totp_last_step = None
    user.recovery_codes = ""
    audit(db, user, "2fa.disabled", "", request)
    db.commit()
    return me_out(db, user)


@router.post("/2fa/recovery-codes")
def two_factor_new_codes(data: CodeIn, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Replace all recovery codes. The old ones stop working."""
    if user.totp_enabled_at is None:
        raise HTTPException(400, "Two-factor sign-in is not on")
    key = f"2fa:{user.id}"
    count = _throttle(key)
    step = twofactor.check_code(user.totp_secret or "", data.code, user.totp_last_step)
    if step is None:
        _failures[key] = (count + 1, time.time())
        raise HTTPException(403, "Enter a current code from your authenticator app")
    _failures.pop(key, None)
    user.totp_last_step = step
    codes, stored = twofactor.new_recovery_codes()
    user.recovery_codes = stored
    audit(db, user, "2fa.recovery_codes_renewed", "", request)
    db.commit()
    return {"recovery_codes": codes}


@router.get("/me")
def me(user: User = Depends(get_token_user), db: Session = Depends(get_db)):
    return me_out(db, user)


@router.post("/change-password")
def change_password(
    data: ChangePasswordIn,
    request: Request,
    user: User = Depends(get_token_user),
    db: Session = Depends(get_db),
):
    if not verify_password(data.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    if data.new_password == data.current_password:
        raise HTTPException(400, "New password must be different from the current one")
    from ..saas import get_org as _get_org

    validate_password(data.new_password, _get_org(db, user))
    user.password_hash = hash_password(data.new_password)
    user.must_change_password = False
    user.token_version += 1  # signs out every other session
    audit(db, user, "password.changed", "", request)
    # Every other browser and device is signed out; this one gets a fresh session.
    from ..models import UserSession

    for old in db.scalars(select(UserSession).where(UserSession.user_id == user.id, UserSession.revoked.is_(False))).all():
        old.revoked = True
    db.commit()
    return {"access_token": create_token(user, db), "user": me_out(db, user)}


@router.post("/forgot-password")
def forgot_password(data: ForgotIn, request: Request, db: Session = Depends(get_db)):
    # Always answer the same way so accounts cannot be enumerated.
    user = _find_user(db, data.workspace, data.identifier)
    if user and user.is_active:
        pending = db.scalar(
            select(PasswordResetRequest).where(
                PasswordResetRequest.user_id == user.id,
                PasswordResetRequest.status == "pending",
            )
        )
        if pending:
            if data.note.strip():
                pending.note = data.note.strip()
        else:
            db.add(PasswordResetRequest(user_id=user.id, note=data.note.strip()))
            audit(db, user, "password.reset_requested", "", request)
        db.commit()
    return {
        "message": "If the account exists, your administrator has been notified and "
        "will issue you a temporary password."
    }


@router.post("/find-workspace")
def find_my_workspace(data: FindWorkspaceIn, db: Session = Depends(get_db)):
    """Someone who forgot their workspace ID: list the workspaces where this email and password
    sign in. Without the right password nothing is shown, so this reveals nobody's accounts."""
    email = data.email.strip().lower()
    key = f"find:{email}"
    count, since = _failures.get(key, (0, 0.0))
    if count >= MAX_FAILURES:
        if time.time() - since < LOCK_SECONDS:
            raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")
        count = 0
    found = []
    for user in db.scalars(select(User).where(func.lower(User.email) == email, User.is_active)).all():
        if verify_password(data.password, user.password_hash):
            org = db.get(Organization, user.org_id)
            if org is not None:
                found.append({"name": org.name, "public_id": format_public_id(org.public_id), "username": user.username})
    if not found:
        _failures[key] = (count + 1, time.time())
        raise HTTPException(404, "No workspace found for that email and password")
    _failures.pop(key, None)
    return sorted(found, key=lambda w: w["name"].lower())


@router.patch("/profile")
def update_profile(
    data: ProfileIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    email = data.email.lower()
    clash = db.scalar(
        select(User).where(func.lower(User.email) == email, User.id != user.id, User.org_id == user.org_id)
        .execution_options(all_orgs=True)  # emails are unique within a workspace
    )
    if clash:
        raise HTTPException(409, "That email is already in use")
    user.full_name = data.full_name.strip()
    user.email = email
    db.commit()
    return me_out(db, user)


@router.put("/avatar")
def set_avatar(
    data: AvatarIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Set (or with null, remove) the profile photo. The image is uploaded to /api/files first."""
    if data.url is not None and not data.url.startswith("/api/files/"):
        raise HTTPException(422, "Upload the photo first")
    user.avatar_url = data.url
    db.commit()
    return me_out(db, user)


@router.put("/preferences")
def set_preferences(
    data: PreferencesIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Per-user interface settings (for example the dashboard layout)."""
    raw = json.dumps(data.preferences)
    if len(raw) > 8000:
        raise HTTPException(422, "Preferences are too large")
    user.preferences = raw
    db.commit()
    return me_out(db, user)
