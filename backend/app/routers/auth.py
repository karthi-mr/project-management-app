import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..database import get_db
from ..models import PasswordResetRequest, User, utcnow
from ..security import (
    create_token,
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
    return {**user_full(user), "org": org_out(db, get_org(db, user))}

# Simple in-memory brute-force throttle: 5 failures -> 10 minute lockout.
MAX_FAILURES = 5
LOCK_SECONDS = 600
_failures: dict[str, tuple[int, float]] = {}


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=200)


class ChangePasswordIn(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(max_length=200)


class ForgotIn(BaseModel):
    identifier: str = Field(min_length=1, max_length=255)
    note: str = Field(default="", max_length=500)


class ProfileIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr


class AvatarIn(BaseModel):
    url: str | None = Field(default=None, max_length=200)


class PreferencesIn(BaseModel):
    preferences: dict


def _find_user(db: Session, identifier: str) -> User | None:
    ident = identifier.strip().lower()
    return db.scalar(
        select(User).where(
            or_(func.lower(User.username) == ident, func.lower(User.email) == ident)
        )
    )


@router.post("/login")
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)):
    key = data.username.strip().lower()
    count, since = _failures.get(key, (0, 0.0))
    if count >= MAX_FAILURES:
        if time.time() - since < LOCK_SECONDS:
            raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")
        _failures.pop(key, None)
        count = 0

    user = _find_user(db, data.username)
    if not user or not verify_password(data.password, user.password_hash):
        _failures[key] = (count + 1, time.time())
        audit(db, user, "login.failed", "Wrong username or password", request, actor_name=key)
        db.commit()
        raise HTTPException(401, "Incorrect username or password")
    if not user.is_active:
        raise HTTPException(403, "This account is disabled. Contact your administrator.")

    _failures.pop(key, None)
    user.last_login = utcnow()
    audit(db, user, "login.success", "", request)
    db.commit()
    return {"access_token": create_token(user, db), "user": me_out(db, user)}


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
    user = _find_user(db, data.identifier)
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


@router.patch("/profile")
def update_profile(
    data: ProfileIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    email = data.email.lower()
    clash = db.scalar(
        select(User).where(func.lower(User.email) == email, User.id != user.id)
        .execution_options(all_orgs=True)  # emails are unique across every workspace
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
