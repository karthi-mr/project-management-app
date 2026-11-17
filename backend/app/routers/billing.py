"""Sign-up and workspace billing. Payment is manual: a workspace requests a plan, pays by bank
transfer and the platform owner activates the license (see routers/platform.py)."""
import os
import re
import secrets
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..database import get_db
from ..models import Invoice, LicenseRequest, Notification, Organization, Plan, User, utcnow
from ..saas import (
    FEATURES,
    addon_out,
    all_addons,
    new_license_key,
    split_keys,
    create_organization,
    get_org,
    get_settings,
    license_status,
    org_out,
    plan_out,
    price_quote,
    usage,
)
from ..security import create_token, hash_password, require_admin, validate_password
from ..serializers import dt, user_full

router = APIRouter(prefix="/api", tags=["billing"])

AVATAR_COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6"]

# Simple abuse guard for the public sign-up form: a handful of workspaces per address per hour.
RESERVED_SLUGS = {"www", "app", "api", "admin", "login", "signup", "platform", "billing", "support", "share", "welcome"}
SIGNUPS_PER_HOUR = int(os.getenv("PM_SIGNUPS_PER_HOUR", "5"))  # raised only for automated browser tests
_signups: dict[str, list[float]] = {}


def public_settings(db: Session) -> dict:
    s = get_settings(db)
    return {
        "company_name": s["company_name"],
        "support_email": s["support_email"],
        "currency": s["currency"],
        "trial_days": int(s["trial_days"]) if s["trial_days"].isdigit() else 14,
        "allow_signup": s["allow_signup"] == "true",
        "tagline": s["tagline"],
    }


def request_out(r: LicenseRequest) -> dict:
    return {
        "id": r.id,
        "org_id": r.org_id,
        "org_name": r.organization.name if r.organization else None,
        "plan_id": r.plan_id,
        "plan_name": r.plan_name,
        "addons": split_keys(r.addons),
        "seats": r.seats,
        "period": r.period,
        "amount": r.amount,
        "currency": r.currency,
        "payment_reference": r.payment_reference,
        "list_amount": r.list_amount,
        "coupon_code": r.coupon_code,
        "discount_note": r.discount_note,
        "note": r.note,
        "status": r.status,
        "decision_note": r.decision_note,
        "requested_by": r.requested_by_name,
        "decided_by": r.decided_by_name,
        "created_at": dt(r.created_at),
        "decided_at": dt(r.decided_at),
    }


def invoice_out(i: Invoice) -> dict:
    return {
        "id": i.id,
        "number": i.number,
        "org_id": i.org_id,
        "org_name": i.org_name,
        "plan_name": i.plan_name,
        "addon_names": [n for n in (i.addon_names or "").split(", ") if n],
        "seats": i.seats,
        "period": i.period,
        "amount": i.amount,
        "currency": i.currency,
        "period_start": dt(i.period_start),
        "period_end": dt(i.period_end),
        "payment_reference": i.payment_reference,
        "list_amount": i.list_amount,
        "discount_note": i.discount_note,
        "issued_at": dt(i.issued_at),
    }


# ───────────── Public: pricing and sign-up ─────────────


@router.get("/public/plans")
def public_plans(db: Session = Depends(get_db)):
    plans = db.scalars(select(Plan).where(Plan.is_public).order_by(Plan.sort, Plan.id)).all()
    return {"plans": [plan_out(p) for p in plans], "addons": [addon_out(a) for a in all_addons(db, public_only=True)],
            "features": FEATURES, "settings": public_settings(db)}


class RegisterIn(BaseModel):
    company: str = Field(min_length=2, max_length=120)
    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(max_length=200)
    website: str = Field(default="", max_length=200)  # honeypot: real people leave it empty
    accept_terms: bool = False


@router.post("/auth/register", status_code=201)
def register(data: RegisterIn, request: Request, db: Session = Depends(get_db)):
    """Create a new workspace on the free trial, with the person signing up as its administrator."""
    settings = get_settings(db)
    if settings["allow_signup"] != "true":
        raise HTTPException(403, "Sign-up is closed. Contact us to get a workspace.")
    if data.website:
        raise HTTPException(400, "Could not create the workspace")
    if not data.accept_terms:
        raise HTTPException(422, "Please accept the terms of service and the privacy policy")
    ip = request.client.host if request.client else "unknown"
    recent = [t for t in _signups.get(ip, []) if time.time() - t < 3600]
    if len(recent) >= SIGNUPS_PER_HOUR:
        raise HTTPException(429, "Too many workspaces created from this address. Try again later.")

    username = data.username.strip().lower()
    if not re.fullmatch(r"[a-z0-9._-]{3,50}", username):
        raise HTTPException(422, "Username may only contain letters, numbers, dots, dashes and underscores")
    email = data.email.lower()
    validate_password(data.password)
    # A new workspace has nobody in it yet, so any username and email are free: the same person
    # may already have an account in another workspace.
    org = create_organization(db, data.company, settings)
    org.billing_email = email
    user = User(
        org_id=org.id,
        username=username,
        email=email,
        full_name=data.full_name.strip(),
        role="admin",
        password_hash=hash_password(data.password),
        must_change_password=False,
        avatar_color=secrets.choice(AVATAR_COLORS),
        last_login=utcnow(),
        terms_accepted_at=utcnow(),
    )
    db.add(user)
    db.flush()
    from ..sample import create_sample_project

    create_sample_project(db, org, user)  # something to look at during the trial
    audit(db, user, "workspace.created", org.name, request)
    db.commit()
    _signups[ip] = recent + [time.time()]
    return {"access_token": create_token(user, db), "user": {**user_full(user), "org": org_out(db, org)}}


# ───────────── Workspace billing (administrators) ─────────────


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    billing_email: str = Field(default="", max_length=255)
    logo_url: str | None = Field(default=None, max_length=200)
    brand_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    slug: str | None = Field(default=None, max_length=40)
    timezone: str | None = Field(default=None, max_length=60)


class LicenseRequestIn(BaseModel):
    plan_id: int
    seats: int = Field(ge=1, le=100000)
    period: Literal["monthly", "yearly"]
    payment_reference: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=2000)
    coupon_code: str = Field(default="", max_length=40)
    addons: list[str] = Field(default=[], max_length=50)


class QuoteIn(BaseModel):
    plan_id: int
    seats: int = Field(ge=1, le=100000)
    period: Literal["monthly", "yearly"]
    coupon_code: str = Field(default="", max_length=40)
    addons: list[str] = Field(default=[], max_length=50)


@router.post("/billing/quote")
def price(data: QuoteIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """What a request would cost, with this workspace's discount and an optional coupon."""
    plan = db.get(Plan, data.plan_id)
    if not plan or not plan.is_public:
        raise HTTPException(404, "That plan is not available")
    return price_quote(db, get_org(db, admin), plan, data.seats, data.period, data.coupon_code, data.addons)


@router.get("/billing")
def billing(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    org = get_org(db, admin)
    settings = get_settings(db)
    plans = db.scalars(select(Plan).where(Plan.is_public).order_by(Plan.sort, Plan.id)).all()
    requests = db.scalars(
        select(LicenseRequest).where(LicenseRequest.org_id == org.id).order_by(LicenseRequest.created_at.desc()).limit(50)
    ).all()
    invoices = db.scalars(select(Invoice).where(Invoice.org_id == org.id).order_by(Invoice.issued_at.desc())).all()
    return {
        "org": {**org_out(db, org), "discount_percent": org.discount_percent or 0},
        "plans": [plan_out(p) for p in plans],
        "addons": [addon_out(a) for a in all_addons(db, public_only=True)],
        "features": FEATURES,
        "settings": {**public_settings(db), "payment_instructions": settings["payment_instructions"]},
        "requests": [request_out(r) for r in requests],
        "invoices": [invoice_out(i) for i in invoices],
    }


@router.patch("/billing/workspace")
def update_workspace(data: WorkspaceIn, request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    org = get_org(db, admin)
    org.name = data.name.strip()
    org.billing_email = data.billing_email.strip()
    fields = data.model_dump(exclude_unset=True)
    if "logo_url" in fields:
        if fields["logo_url"] and not fields["logo_url"].startswith("/api/files/"):
            raise HTTPException(422, "Upload the logo first")
        org.logo_url = fields["logo_url"] or None
    if "brand_color" in fields:
        org.brand_color = fields["brand_color"]
    if "timezone" in fields:
        org.timezone = (fields["timezone"] or "").strip()
    if "slug" in fields:
        slug = (fields["slug"] or "").strip().lower()
        if slug:
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,38}[a-z0-9]", slug) or slug in RESERVED_SLUGS:
                raise HTTPException(422, "The address may contain 3 to 40 lowercase letters, numbers and dashes")
            clash = db.scalar(select(Organization.id).where(Organization.slug == slug, Organization.id != org.id))
            if clash:
                raise HTTPException(409, "That address is already taken")
        org.slug = slug or None
    audit(db, admin, "workspace.updated", org.name, request)
    db.commit()
    return org_out(db, org)


@router.post("/billing/requests", status_code=201)
def request_license(data: LicenseRequestIn, request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Ask for a plan. Nothing is charged: the platform owner activates it after the transfer arrives."""
    org = get_org(db, admin)
    if license_status(org) == "suspended":
        raise HTTPException(402, "This workspace is suspended. Contact support.")
    plan = db.get(Plan, data.plan_id)
    if not plan or not plan.is_public:
        raise HTTPException(404, "That plan is not available")
    in_use = usage(db, org.id)
    if data.seats < in_use["users"]:
        raise HTTPException(422, f"You have {in_use['users']} active users, so you need at least that many seats")
    if plan.max_users is not None and data.seats > plan.max_users:
        raise HTTPException(422, f"{plan.name} covers up to {plan.max_users} users. Choose a larger plan for more.")
    if plan.max_projects is not None and in_use["projects"] > plan.max_projects:
        raise HTTPException(422, f"{plan.name} includes {plan.max_projects} projects and you have {in_use['projects']}. Choose a larger plan or delete some projects first.")
    if db.scalar(select(LicenseRequest.id).where(LicenseRequest.org_id == org.id, LicenseRequest.status == "pending")):
        raise HTTPException(409, "You already have a request waiting. Cancel it before sending another.")

    settings = get_settings(db)
    price = price_quote(db, org, plan, data.seats, data.period, data.coupon_code, data.addons)
    req = LicenseRequest(
        org_id=org.id, plan_id=plan.id, plan_name=plan.name, addons=",".join(price["addons"]),
        seats=data.seats, period=data.period,
        amount=price["amount"], currency=settings["currency"],
        list_amount=price["list_amount"] if price["discount"] else None,
        coupon_code=price["coupon_code"], discount_note=price["discount_note"],
        payment_reference=data.payment_reference.strip(), note=data.note.strip(),
        requested_by_id=admin.id, requested_by_name=admin.full_name,
    )
    db.add(req)
    if price["list_amount"] == 0:
        # Nothing to pay (the Free plan): it starts straight away, no one needs to approve it.
        org.plan_id = plan.id
        org.seats = data.seats
        org.is_trial = False
        org.valid_until = None
        org.addons = org.free_addons or ""
        if not org.license_key:
            org.license_key = new_license_key()
        req.status = "approved"
        req.decided_at = utcnow()
        req.decided_by_name = "Automatic (free plan)"
        db.info.pop("org_cache", None)
        db.info.pop("feature_cache", None)
        audit(db, admin, "license.free_plan", f"{plan.name}, {data.seats} seats", request)
        db.commit()
        return request_out(req)
    owners = db.scalars(select(User).where(User.is_platform_admin.is_(True), User.is_active).execution_options(all_orgs=True)).all()
    for owner in owners:
        extras = f" with {len(price['addons'])} add-on{'s' if len(price['addons']) != 1 else ''}" if price["addons"] else ""
        db.add(Notification(user_id=owner.id, message=f"{org.name} requested {plan.name}{extras} for {data.seats} users ({data.period})"))
        db.info.setdefault("notify_users", set()).add(owner.id)
    audit(db, admin, "license.requested", f"{plan.name}, {data.seats} seats, {data.period}", request)
    db.commit()
    return request_out(req)


@router.post("/billing/requests/{request_id}/cancel")
def cancel_request(request_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    req = db.get(LicenseRequest, request_id)
    if not req or req.org_id != admin.org_id:
        raise HTTPException(404, "Request not found")
    if req.status != "pending":
        raise HTTPException(400, "This request has already been handled")
    req.status = "cancelled"
    req.decided_at = utcnow()
    db.commit()
    return request_out(req)


@router.get("/billing/invoices/{invoice_id}")
def read_invoice(invoice_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    invoice = db.get(Invoice, invoice_id)
    if not invoice or (invoice.org_id != admin.org_id and not admin.is_platform_admin):
        raise HTTPException(404, "Invoice not found")
    org = db.get(Organization, invoice.org_id)
    settings = get_settings(db)
    return {
        **invoice_out(invoice),
        "billing_email": org.billing_email if org else "",
        "seller": {"name": settings["company_name"], "email": settings["support_email"]},
    }
