import re
import secrets
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..database import get_db
from ..models import PasswordResetRequest, User, utcnow
from ..saas import check_seat_available, get_org
from ..security import (
    generate_password,
    get_current_user,
    hash_password,
    require_admin,
    validate_password,
)
from ..serializers import reset_request_out, user_brief, user_full

router = APIRouter(prefix="/api", tags=["users"])

AVATAR_COLORS = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316",
    "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
]


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    role: Literal["admin", "manager", "member"] = "member"
    password: str | None = Field(default=None, max_length=200)  # None -> generate


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=120)
    email: EmailStr | None = None
    role: Literal["admin", "manager", "member"] | None = None
    is_active: bool | None = None
    hourly_rate: float | None = Field(default=None, ge=0, le=100000)
    weekly_capacity: float | None = Field(default=None, ge=0, le=168)


class ResetPasswordIn(BaseModel):
    password: str | None = Field(default=None, max_length=200)  # None -> generate


def _set_temp_password(user: User, password: str | None) -> str:
    if password:
        validate_password(password)
    else:
        password = generate_password()
    user.password_hash = hash_password(password)
    user.must_change_password = True
    user.token_version = (user.token_version or 0) + 1
    return password


def _protect_platform_owner(target: User, actor: User) -> None:
    if target.is_platform_admin and not actor.is_platform_admin:
        raise HTTPException(403, "The platform owner's account can only be changed by a platform owner")


def _active_admin_count(db: Session) -> int:
    return db.scalar(
        select(func.count()).select_from(User).where(User.role == "admin", User.is_active)
    )


@router.get("/users")
def list_users(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    users = db.scalars(select(User).order_by(User.full_name)).all()
    if user.role == "admin":
        return [user_full(u) for u in users]
    return [user_brief(u) for u in users if u.is_active]


@router.post("/users", status_code=201)
def create_user(
    data: UserCreate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    username = data.username.strip().lower()
    if not re.fullmatch(r"[a-z0-9._-]{3,50}", username):
        raise HTTPException(
            422, "Username may only contain letters, numbers, dots, dashes and underscores"
        )
    email = data.email.lower()
    if db.scalar(select(User).where(func.lower(User.username) == username).execution_options(all_orgs=True)):
        raise HTTPException(409, "That username is already taken")
    if db.scalar(select(User).where(func.lower(User.email) == email).execution_options(all_orgs=True)):
        raise HTTPException(409, "That email is already in use")

    check_seat_available(db, get_org(db, admin))
    user = User(
        org_id=admin.org_id,
        username=username,
        full_name=data.full_name.strip(),
        email=email,
        role=data.role,
        password_hash="",
        avatar_color=secrets.choice(AVATAR_COLORS),
    )
    temp = _set_temp_password(user, data.password)
    user.token_version = 0
    db.add(user)
    audit(db, admin, "user.created", f"{user.username} ({user.role})", request)
    db.commit()
    return {"user": user_full(user), "temporary_password": temp}


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    data: UserUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    _protect_platform_owner(user, admin)
    demoting = data.role in ("member", "manager") and user.role == "admin"
    disabling = data.is_active is False and user.is_active
    if (demoting or disabling) and user.role == "admin":
        if user.id == admin.id:
            raise HTTPException(400, "You cannot demote or disable your own account")
        if _active_admin_count(db) <= 1:
            raise HTTPException(400, "At least one active administrator is required")

    if data.email is not None:
        email = data.email.lower()
        clash = db.scalar(
            select(User).where(func.lower(User.email) == email, User.id != user.id)
            .execution_options(all_orgs=True)
        )
        if clash:
            raise HTTPException(409, "That email is already in use")
        user.email = email
    if data.full_name is not None:
        user.full_name = data.full_name.strip()
    if data.role is not None:
        user.role = data.role
    sent = data.model_dump(exclude_unset=True)
    if "hourly_rate" in sent:
        user.hourly_rate = data.hourly_rate
    if data.weekly_capacity is not None:
        user.weekly_capacity = data.weekly_capacity
    if data.is_active is not None:
        if user.id == admin.id and not data.is_active:
            raise HTTPException(400, "You cannot disable your own account")
        if data.is_active and not user.is_active:
            check_seat_available(db, get_org(db, admin))
        user.is_active = data.is_active
    changed = ", ".join(f"{k}={v}" for k, v in data.model_dump(exclude_unset=True).items())
    audit(db, admin, "user.updated", f"{user.username}: {changed}", request)
    db.commit()
    return user_full(user)


@router.post("/users/{user_id}/reset-password")
def reset_password(
    user_id: int,
    data: ResetPasswordIn,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if user.id == admin.id:
        raise HTTPException(400, "Use Profile → Change password for your own account")
    temp = _set_temp_password(user, data.password)
    # Any pending forgot-password request is now satisfied.
    for req in db.scalars(
        select(PasswordResetRequest).where(
            PasswordResetRequest.user_id == user.id,
            PasswordResetRequest.status == "pending",
        )
    ):
        req.status = "approved"
        req.resolved_at = utcnow()
        req.resolved_by_id = admin.id
    audit(db, admin, "password.reset_by_admin", user.username, request)
    db.commit()
    return {"user": user_full(user), "temporary_password": temp}


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if user.id == admin.id:
        raise HTTPException(400, "You cannot delete your own account")
    _protect_platform_owner(user, admin)
    if user.role == "admin" and user.is_active and _active_admin_count(db) <= 1:
        raise HTTPException(400, "At least one active administrator is required")
    audit(db, admin, "user.deleted", user.username, request)
    db.delete(user)
    db.commit()


@router.get("/admin/reset-requests")
def list_reset_requests(
    admin: User = Depends(require_admin), db: Session = Depends(get_db)
):
    rows = db.scalars(
        select(PasswordResetRequest)
        .join(User, PasswordResetRequest.user_id == User.id)
        .where(User.org_id == admin.org_id)
        .order_by(PasswordResetRequest.created_at.desc())
        .limit(100)
    ).all()
    return [reset_request_out(r) for r in rows]


@router.post("/admin/reset-requests/{request_id}/reject")
def reject_reset_request(
    request_id: int,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    req = db.get(PasswordResetRequest, request_id)
    if not req or req.status != "pending" or req.user is None:  # None: another workspace's user
        raise HTTPException(404, "Pending request not found")
    req.status = "rejected"
    req.resolved_at = utcnow()
    req.resolved_by_id = admin.id
    audit(db, admin, "password.reset_dismissed", req.user.username, request)
    db.commit()
    return reset_request_out(req)
