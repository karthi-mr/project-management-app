"""The platform owner's console: workspaces, license requests, plans, invoices and settings.

Every endpoint here requires a platform owner, and works across all workspaces.
"""
import json
import re
import secrets
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..audit import audit
from ..database import get_db
from ..models import AuditLog, Invoice, LicenseRequest, Notification, Organization, Plan, Project, User, utcnow
from ..saas import (
    DEFAULT_SETTINGS,
    FEATURES,
    create_organization,
    get_settings,
    license_status,
    new_license_key,
    org_out,
    period_days,
    plan_out,
    purge_organization,
    set_settings,
)
from ..security import generate_password, hash_password, require_platform_admin, validate_password
from ..serializers import dt, user_brief
from .billing import AVATAR_COLORS, invoice_out, request_out

router = APIRouter(prefix="/api/platform", tags=["platform"])


def _org(db: Session, org_id: int) -> Organization:
    org = db.get(Organization, org_id)
    if not org:
        raise HTTPException(404, "Workspace not found")
    return org


def _admins(db: Session, org_id: int) -> list[User]:
    return list(db.scalars(select(User).where(User.org_id == org_id, User.role == "admin", User.is_active).order_by(User.id)))


def _row(db: Session, org: Organization) -> dict:
    admins = _admins(db, org.id)
    last_seen = db.scalar(select(func.max(User.last_login)).where(User.org_id == org.id))
    return {
        **org_out(db, org, private=True),
        "contact": {"name": admins[0].full_name, "email": admins[0].email} if admins else None,
        "last_activity": dt(last_seen),
    }


# ───────────── Overview ─────────────


@router.get("/overview")
def overview(_: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    orgs = db.scalars(select(Organization)).all()
    counts = {"trial": 0, "active": 0, "expired": 0, "suspended": 0}
    for org in orgs:
        counts[license_status(org)] += 1
    now = utcnow()
    month_ago = now - timedelta(days=30)
    invoices = db.scalars(select(Invoice)).all()
    # Monthly recurring revenue: the latest paid period of each active workspace, per month.
    mrr = 0.0
    for org in orgs:
        if license_status(org) != "active":
            continue
        latest = max((i for i in invoices if i.org_id == org.id), key=lambda i: i.issued_at, default=None)
        if latest and latest.period_end >= now:
            mrr += latest.amount / (12 if latest.period == "yearly" else 1)
    soon = now + timedelta(days=14)
    return {
        "workspaces": len(orgs),
        "by_status": counts,
        "users": db.scalar(select(func.count()).select_from(User).where(User.is_active)),
        "projects": db.scalar(select(func.count()).select_from(Project)),
        "pending_requests": db.scalar(select(func.count()).select_from(LicenseRequest).where(LicenseRequest.status == "pending")),
        "revenue_total": round(sum(i.amount for i in invoices), 2),
        "revenue_30_days": round(sum(i.amount for i in invoices if i.issued_at >= month_ago), 2),
        "mrr": round(mrr, 2),
        "currency": get_settings(db)["currency"],
        "new_30_days": sum(1 for o in orgs if o.created_at >= month_ago),
        "expiring_soon": [
            _row(db, o) for o in sorted(orgs, key=lambda o: o.valid_until or datetime.max)
            if o.valid_until is not None and now <= o.valid_until <= soon and not o.suspended
        ][:8],
    }


# ───────────── Workspaces ─────────────


class OrgCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    admin_full_name: str = Field(min_length=1, max_length=120)
    admin_email: EmailStr
    admin_username: str = Field(min_length=3, max_length=50)


class OrgUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    plan_id: int | None = None
    seats: int | None = Field(default=None, ge=1, le=100000)
    unlimited_seats: bool | None = None
    valid_until: date | None = None
    never_expires: bool | None = None
    is_trial: bool | None = None
    suspended: bool | None = None
    notes: str | None = Field(default=None, max_length=5000)
    billing_email: str | None = Field(default=None, max_length=255)
    discount_percent: float | None = Field(default=None, ge=0, le=100)


@router.get("/organizations")
def list_organizations(
    q: str | None = Query(default=None, max_length=100),
    status: Literal["trial", "active", "expired", "suspended"] | None = None,
    _: User = Depends(require_platform_admin),
    db: Session = Depends(get_db),
):
    stmt = select(Organization)
    if q and q.strip():
        like = f"%{q.strip()}%"
        matching_users = select(User.org_id).where(or_(User.email.ilike(like), User.full_name.ilike(like)))
        stmt = stmt.where(or_(Organization.name.ilike(like), Organization.id.in_(matching_users)))
    rows = [_row(db, o) for o in db.scalars(stmt.order_by(Organization.created_at.desc())).all()]
    return [r for r in rows if not status or r["status"] == status]


@router.post("/organizations", status_code=201)
def create_org(data: OrgCreate, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    """Set up a workspace for a customer yourself. Its administrator gets a temporary password."""
    username = data.admin_username.strip().lower()
    if not re.fullmatch(r"[a-z0-9._-]{3,50}", username):
        raise HTTPException(422, "Username may only contain letters, numbers, dots, dashes and underscores")
    email = data.admin_email.lower()
    if db.scalar(select(User).where(func.lower(User.username) == username)):
        raise HTTPException(409, "That username is already taken")
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        raise HTTPException(409, "That email is already in use")
    org = create_organization(db, data.name)
    org.billing_email = email
    password = generate_password()
    db.add(User(
        org_id=org.id, username=username, email=email, full_name=data.admin_full_name.strip(), role="admin",
        password_hash=hash_password(password), must_change_password=True, avatar_color=secrets.choice(AVATAR_COLORS),
    ))
    audit(db, owner, "platform.workspace_created", org.name, request)
    db.commit()
    return {"organization": _row(db, org), "username": username, "temporary_password": password}


@router.get("/organizations/{org_id}")
def read_organization(org_id: int, _: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    org = _org(db, org_id)
    users = db.scalars(select(User).where(User.org_id == org.id).order_by(User.full_name)).all()
    requests = db.scalars(select(LicenseRequest).where(LicenseRequest.org_id == org.id).order_by(LicenseRequest.created_at.desc()).limit(30)).all()
    invoices = db.scalars(select(Invoice).where(Invoice.org_id == org.id).order_by(Invoice.issued_at.desc())).all()
    return {
        **_row(db, org),
        "users": [
            {**user_brief(u), "email": u.email, "role": u.role, "is_active": u.is_active, "last_login": dt(u.last_login)}
            for u in users
        ],
        "requests": [request_out(r) for r in requests],
        "invoices": [invoice_out(i) for i in invoices],
    }


@router.patch("/organizations/{org_id}")
def update_organization(org_id: int, data: OrgUpdate, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    """Grant or change a license by hand: plan, seats, expiry, trial flag, suspension."""
    org = _org(db, org_id)
    fields = data.model_dump(exclude_unset=True)
    changes = []
    if fields.get("name"):
        org.name = fields["name"].strip()
    if "plan_id" in fields and fields["plan_id"] is not None and fields["plan_id"] != org.plan_id:
        plan = db.get(Plan, fields["plan_id"])
        if not plan:
            raise HTTPException(404, "Plan not found")
        org.plan_id = plan.id
        changes.append(f"plan → {plan.name}")
    if fields.get("unlimited_seats"):
        org.seats = None
        changes.append("seats → unlimited")
    elif fields.get("seats") is not None:
        org.seats = fields["seats"]
        changes.append(f"seats → {org.seats}")
    if fields.get("never_expires"):
        org.valid_until = None
        changes.append("never expires")
    elif fields.get("valid_until") is not None:
        org.valid_until = datetime.combine(fields["valid_until"], datetime.max.time()).replace(microsecond=0)
        changes.append(f"valid until {fields['valid_until'].isoformat()}")
    if fields.get("is_trial") is not None:
        org.is_trial = fields["is_trial"]
    if fields.get("suspended") is not None and fields["suspended"] != org.suspended:
        if fields["suspended"] and org.id == owner.org_id:
            raise HTTPException(400, "You cannot suspend your own workspace")
        org.suspended = fields["suspended"]
        changes.append("suspended" if org.suspended else "reactivated")
    if fields.get("discount_percent") is not None and fields["discount_percent"] != (org.discount_percent or 0):
        org.discount_percent = fields["discount_percent"]
        changes.append(f"discount → {org.discount_percent:g}%")
    if fields.get("notes") is not None:
        org.notes = fields["notes"]
    if fields.get("billing_email") is not None:
        org.billing_email = fields["billing_email"].strip()
    if not org.license_key and not org.is_trial:
        org.license_key = new_license_key()
    if changes:
        audit(db, owner, "platform.license_changed", f"{org.name}: {', '.join(changes)}", request)
        for admin in _admins(db, org.id):
            db.add(Notification(user_id=admin.id, message=f"Your workspace license was updated: {', '.join(changes)}"))
            db.info.setdefault("notify_users", set()).add(admin.id)
    db.commit()
    return _row(db, org)


@router.delete("/organizations/{org_id}", status_code=204)
def delete_organization(org_id: int, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    """Permanently delete a workspace and everything in it. It must be suspended first."""
    org = _org(db, org_id)
    if org.id == owner.org_id:
        raise HTTPException(400, "You cannot delete your own workspace")
    if not org.suspended:
        raise HTTPException(400, "Suspend the workspace first, then delete it")
    name = org.name
    purge_organization(db, org)
    audit(db, owner, "platform.workspace_deleted", name, request)
    db.commit()


# ───────────── License requests ─────────────


class DecisionIn(BaseModel):
    note: str = Field(default="", max_length=2000)
    amount: float | None = Field(default=None, ge=0, le=1e9)  # a custom price agreed with the customer


def _next_invoice_number(db: Session) -> str:
    year = utcnow().year
    count = db.scalar(select(func.count()).select_from(Invoice).where(Invoice.number.like(f"INV-{year}-%")))
    return f"INV-{year}-{count + 1:04d}"


@router.get("/requests")
def list_requests(
    status: Literal["pending", "approved", "rejected", "cancelled"] | None = None,
    _: User = Depends(require_platform_admin),
    db: Session = Depends(get_db),
):
    stmt = select(LicenseRequest)
    if status:
        stmt = stmt.where(LicenseRequest.status == status)
    rows = db.scalars(stmt.order_by(LicenseRequest.status != "pending", LicenseRequest.created_at.desc()).limit(200)).all()
    out = []
    for r in rows:
        org = r.organization
        out.append({**request_out(r), "org_status": license_status(org) if org else None,
                    "current_plan": org.plan.name if org and org.plan else None,
                    "valid_until": dt(org.valid_until) if org else None})
    return out


@router.post("/requests/{request_id}/approve")
def approve_request(request_id: int, data: DecisionIn, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    """Payment received: activate the license and issue the invoice."""
    req = db.get(LicenseRequest, request_id)
    if not req or req.organization is None:
        raise HTTPException(404, "Request not found")
    if req.status != "pending":
        raise HTTPException(400, "This request has already been handled")
    plan = db.get(Plan, req.plan_id) if req.plan_id else None
    if not plan:
        raise HTTPException(400, "The requested plan no longer exists. Reject this request and ask for a new one.")
    org = req.organization
    now = utcnow()
    if data.amount is not None and data.amount != req.amount:
        if req.list_amount is None:
            req.list_amount = req.amount
        req.amount = round(data.amount, 2)
        req.discount_note = (req.discount_note + ", " if req.discount_note else "") + "custom price"
    if req.coupon_code:
        from ..models import Coupon

        coupon = db.scalar(select(Coupon).where(Coupon.code == req.coupon_code))
        if coupon:
            coupon.used = (coupon.used or 0) + 1
    # Renewing the same paid plan early adds the new period after the current one.
    renewing = not org.is_trial and org.plan_id == plan.id and org.valid_until is not None and org.valid_until > now
    start = org.valid_until if renewing else now
    end = start + timedelta(days=period_days(req.period))

    org.plan_id = plan.id
    org.seats = req.seats
    org.is_trial = False
    org.valid_until = end
    if not org.license_key:
        org.license_key = new_license_key()

    req.status = "approved"
    req.decision_note = data.note.strip()
    req.decided_at = now
    req.decided_by_name = owner.full_name

    invoice = None
    for _attempt in range(5):  # two approvals at the same moment must not share a number
        try:
            with db.begin_nested():
                invoice = Invoice(
                    number=_next_invoice_number(db), org_id=org.id, org_name=org.name, request_id=req.id,
                    plan_name=plan.name, seats=req.seats, period=req.period, amount=req.amount, currency=req.currency,
                    period_start=start, period_end=end, payment_reference=req.payment_reference,
                    list_amount=req.list_amount, discount_note=req.discount_note,
                )
                db.add(invoice)
            break
        except IntegrityError:
            invoice = None
    if invoice is None:
        raise HTTPException(500, "Could not issue an invoice number. Try again.")

    for admin in _admins(db, org.id):
        db.add(Notification(user_id=admin.id, message=f"Your {plan.name} license is active until {end.date().isoformat()} for {req.seats} users"))
        db.info.setdefault("notify_users", set()).add(admin.id)
    audit(db, owner, "platform.license_activated", f"{org.name}: {plan.name}, {req.seats} seats, until {end.date().isoformat()}", request)
    db.add(AuditLog(org_id=org.id, actor_name="platform", action="license.activated", detail=f"{plan.name}, {req.seats} seats, until {end.date().isoformat()}"))
    db.commit()
    return {"request": request_out(req), "invoice": invoice_out(invoice), "organization": _row(db, org)}


@router.post("/requests/{request_id}/reject")
def reject_request(request_id: int, data: DecisionIn, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    req = db.get(LicenseRequest, request_id)
    if not req:
        raise HTTPException(404, "Request not found")
    if req.status != "pending":
        raise HTTPException(400, "This request has already been handled")
    req.status = "rejected"
    req.decision_note = data.note.strip()
    req.decided_at = utcnow()
    req.decided_by_name = owner.full_name
    for admin in _admins(db, req.org_id):
        reason = f": {req.decision_note}" if req.decision_note else ""
        db.add(Notification(user_id=admin.id, message=f"Your {req.plan_name} license request was not approved{reason}"))
        db.info.setdefault("notify_users", set()).add(admin.id)
    audit(db, owner, "platform.license_rejected", f"{req.organization.name if req.organization else req.org_id}: {req.plan_name}", request)
    db.commit()
    return request_out(req)


# ───────────── Plans ─────────────


class PlanIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = Field(default="", max_length=300)
    price_monthly: float = Field(ge=0, le=1e7)
    price_yearly: float = Field(ge=0, le=1e8)
    max_users: int | None = Field(default=None, ge=1, le=100000)
    max_projects: int | None = Field(default=None, ge=1, le=100000)
    features: list[str] = []
    is_public: bool = True
    sort: int = Field(default=0, ge=0, le=1000)


def _apply_plan(plan: Plan, data: PlanIn) -> None:
    unknown = [f for f in data.features if f not in FEATURES]
    if unknown:
        raise HTTPException(422, f"Unknown feature: {unknown[0]}")
    plan.name = data.name.strip()
    plan.description = data.description.strip()
    plan.price_monthly = data.price_monthly
    plan.price_yearly = data.price_yearly
    plan.max_users = data.max_users
    plan.max_projects = data.max_projects
    plan.features = json.dumps([f for f in FEATURES if f in data.features])
    plan.sort = data.sort
    # The trial plan is assigned automatically and is never sold.
    plan.is_public = False if plan.key == "trial" else data.is_public


@router.get("/plans")
def list_plans(_: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    plans = db.scalars(select(Plan).order_by(Plan.sort, Plan.id)).all()
    in_use = dict(db.execute(select(Organization.plan_id, func.count()).group_by(Organization.plan_id)).all())
    return {"plans": [{**plan_out(p), "workspaces": in_use.get(p.id, 0)} for p in plans], "features": FEATURES}


@router.post("/plans", status_code=201)
def create_plan(data: PlanIn, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    base = re.sub(r"[^a-z0-9]+", "-", data.name.lower()).strip("-")[:24] or "plan"
    key, n = base, 2
    while db.scalar(select(Plan.id).where(Plan.key == key)):
        key, n = f"{base}-{n}", n + 1
    plan = Plan(key=key, name=data.name)
    _apply_plan(plan, data)
    db.add(plan)
    audit(db, owner, "platform.plan_created", plan.name, request)
    db.commit()
    return plan_out(plan)


@router.put("/plans/{plan_id}")
def update_plan(plan_id: int, data: PlanIn, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    plan = db.get(Plan, plan_id)
    if not plan:
        raise HTTPException(404, "Plan not found")
    _apply_plan(plan, data)
    audit(db, owner, "platform.plan_updated", plan.name, request)
    db.commit()
    return plan_out(plan)


@router.delete("/plans/{plan_id}", status_code=204)
def delete_plan(plan_id: int, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    plan = db.get(Plan, plan_id)
    if not plan:
        raise HTTPException(404, "Plan not found")
    if plan.key in ("trial", "enterprise"):
        raise HTTPException(400, "This plan is needed by the system. Hide it instead.")
    if db.scalar(select(Organization.id).where(Organization.plan_id == plan.id).limit(1)):
        raise HTTPException(400, "Workspaces are using this plan. Move them to another plan, or hide it instead.")
    audit(db, owner, "platform.plan_deleted", plan.name, request)
    db.delete(plan)
    db.commit()


# ───────────── Invoices and settings ─────────────


@router.get("/invoices")
def list_invoices(_: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    return [invoice_out(i) for i in db.scalars(select(Invoice).order_by(Invoice.issued_at.desc()).limit(500)).all()]


class SettingsIn(BaseModel):
    company_name: str = Field(min_length=1, max_length=120)
    support_email: str = Field(default="", max_length=255)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    trial_days: int = Field(ge=1, le=365)
    allow_signup: bool
    payment_instructions: str = Field(max_length=5000)
    tagline: str | None = Field(default=None, max_length=200)
    terms_text: str | None = Field(default=None, max_length=50000)
    privacy_text: str | None = Field(default=None, max_length=50000)


@router.get("/settings")
def read_settings(_: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    s = get_settings(db)
    return {
        "company_name": s["company_name"], "support_email": s["support_email"], "currency": s["currency"],
        "trial_days": int(s["trial_days"]) if s["trial_days"].isdigit() else 14,
        "allow_signup": s["allow_signup"] == "true", "payment_instructions": s["payment_instructions"],
        "tagline": s["tagline"], "terms_text": s["terms_text"], "privacy_text": s["privacy_text"],
    }


@router.put("/settings")
def update_settings(data: SettingsIn, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    set_settings(db, {
        "company_name": data.company_name.strip(), "support_email": data.support_email.strip(),
        "currency": data.currency, "trial_days": str(data.trial_days),
        "allow_signup": "true" if data.allow_signup else "false",
        "payment_instructions": data.payment_instructions,
        **{k: v for k, v in (("tagline", data.tagline), ("terms_text", data.terms_text), ("privacy_text", data.privacy_text)) if v is not None},
    })
    audit(db, owner, "platform.settings_updated", "", request)
    db.commit()
    return read_settings(owner, db)


__all__ = ["router", "DEFAULT_SETTINGS", "validate_password"]
