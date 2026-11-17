"""Workspaces, plans and licenses: the rules that make Trackly a multi-tenant SaaS.

Payment is manual: a workspace requests a plan, pays by bank transfer, and the platform owner
activates the license. Nothing in here talks to a payment provider.
"""
import json
import secrets
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .models import (
    AuditLog,
    Organization,
    Plan,
    PlatformSetting,
    Project,
    ProjectTemplate,
    User,
    utcnow,
)

# Capabilities a plan can include. Everything not listed here is part of every plan.
FEATURES = {
    "sprints": "Sprints",
    "customization": "Custom workflows, fields and issue templates",
    "automation": "Automation rules",
    "approvals": "Approvals",
    "workload": "Workload planning",
    "budgets": "Budgets and cost tracking",
    "group_chat": "Group chats",
    "audit_log": "Audit log",
    "security": "Security controls (allowed networks)",
}
ALL_FEATURES = list(FEATURES)

DEFAULT_PLANS = [
    {
        "key": "trial", "name": "Free trial", "sort": 0, "is_public": False,
        "description": "Every feature, to try Trackly with your team.",
        "price_monthly": 0, "price_yearly": 0, "max_users": 5, "max_projects": 3, "features": ALL_FEATURES,
    },
    {
        "key": "starter", "name": "Starter", "sort": 1, "is_public": True,
        "description": "Projects, issues, planning and chat for a small team.",
        "price_monthly": 6, "price_yearly": 60, "max_users": 10, "max_projects": 10,
        "features": ["sprints", "customization"],
    },
    {
        "key": "business", "name": "Business", "sort": 2, "is_public": True,
        "description": "Automation, approvals, workload and budgets for growing teams.",
        "price_monthly": 12, "price_yearly": 120, "max_users": 50, "max_projects": None,
        "features": ["sprints", "customization", "automation", "approvals", "workload", "budgets", "group_chat"],
    },
    {
        "key": "enterprise", "name": "Enterprise", "sort": 3, "is_public": True,
        "description": "Everything, with unlimited users and the audit log.",
        "price_monthly": 20, "price_yearly": 200, "max_users": None, "max_projects": None, "features": ALL_FEATURES,
    },
]

DEFAULT_SETTINGS = {
    "company_name": "Trackly",
    "support_email": "",
    "currency": "USD",
    "trial_days": "14",
    "allow_signup": "true",
    "tagline": "Plan, track and deliver every project in one place.",
    "terms_text": (
        "These are placeholder terms. Replace them in the owner console before taking customers.\n\n"
        "1. The service is provided as is.\n2. You keep ownership of the data you put in.\n"
        "3. Licenses are paid in advance and activated once payment is confirmed.\n"
        "4. You can export or delete your workspace at any time."
    ),
    "privacy_text": (
        "This is a placeholder privacy policy. Replace it in the owner console before taking customers.\n\n"
        "We store the account details you give us (name, email) and the project data you create, "
        "only to provide the service. We do not sell your data. You can export everything or delete "
        "your workspace from the Billing page."
    ),
    "payment_instructions": (
        "Transfer the amount to our company account and enter the transfer reference in your "
        "request. Your license is activated once the payment is confirmed.\n\n"
        "Bank: (set this in the owner console)\nAccount name:\nAccount number:\nIFSC / SWIFT:"
    ),
}

GRACE_WARNING_DAYS = 7

# Parts of the app a workspace can switch off to keep things simple. Projects, features, milestones,
# issues, releases, the board and the calendar are always there. Switching a module off only hides it;
# nothing is deleted, and switching it back on shows everything again.
MODULES = {
    "sprints": "Sprints",
    "tests": "Test cases",
    "documents": "Documents",
    "risks": "Risks",
    "time": "Time tracking and timesheets",
    "budgets": "Budgets and costs",
    "portfolio": "Portfolio",
    "workload": "Workload",
    "chat": "Chat",
    "automation": "Automation rules",
    "client_access": "Client links and feedback",
}
# A new workspace starts focused on planning and delivery; the rest is one switch away.
NEW_WORKSPACE_HIDDEN = ("tests", "risks", "time", "budgets", "portfolio", "workload", "automation")


def hidden_modules(org) -> set[str]:
    return {m for m in (org.hidden_modules or "").split(",") if m in MODULES}


# ───────────── Settings ─────────────


def get_settings(db: Session) -> dict:
    stored = {s.key: s.value for s in db.scalars(select(PlatformSetting))}
    return {**DEFAULT_SETTINGS, **stored}


def set_settings(db: Session, values: dict) -> None:
    for key, value in values.items():
        if key not in DEFAULT_SETTINGS:
            continue
        row = db.get(PlatformSetting, key)
        if row:
            row.value = str(value)
        else:
            db.add(PlatformSetting(key=key, value=str(value)))


# ───────────── Plans and license state ─────────────


def plan_features(plan: Plan | None) -> list[str]:
    if not plan:
        return []
    try:
        return [f for f in json.loads(plan.features or "[]") if f in FEATURES]
    except ValueError:
        return []


def plan_out(plan: Plan) -> dict:
    return {
        "id": plan.id,
        "key": plan.key,
        "name": plan.name,
        "description": plan.description,
        "price_monthly": plan.price_monthly,
        "price_yearly": plan.price_yearly,
        "max_users": plan.max_users,
        "max_projects": plan.max_projects,
        "features": plan_features(plan),
        "is_public": plan.is_public,
        "sort": plan.sort,
    }


def license_status(org: Organization, now: datetime | None = None) -> str:
    """suspended | expired | trial | active"""
    now = now or utcnow()
    if org.suspended:
        return "suspended"
    if org.valid_until is not None and org.valid_until < now:
        return "expired"
    return "trial" if org.is_trial else "active"


def usage(db: Session, org_id: int) -> dict:
    users = db.scalar(
        select(func.count()).select_from(User).where(User.org_id == org_id, User.is_active)
        .execution_options(all_orgs=True)
    )
    projects = db.scalar(
        select(func.count()).select_from(Project).where(Project.org_id == org_id)
        .execution_options(all_orgs=True)
    )
    return {"users": users, "projects": projects}


def seat_limit(org: Organization) -> int | None:
    """Licensed seats: what was purchased, capped by the plan's own maximum."""
    limits = [n for n in (org.seats, org.plan.max_users if org.plan else None) if n is not None]
    return min(limits) if limits else None


def org_out(db: Session, org: Organization, private: bool = False) -> dict:
    status = license_status(org)
    days_left = None
    if org.valid_until is not None:
        days_left = (org.valid_until.date() - utcnow().date()).days
    data = {
        "id": org.id,
        "name": org.name,
        "status": status,
        "is_trial": org.is_trial,
        "plan": plan_out(org.plan) if org.plan else None,
        "features": plan_features(org.plan),
        "seats": seat_limit(org),
        "max_projects": org.plan.max_projects if org.plan else None,
        "valid_until": org.valid_until.isoformat(timespec="seconds") + "Z" if org.valid_until else None,
        "days_left": days_left,
        "read_only": status in ("expired", "suspended"),
        "usage": usage(db, org.id),
        "license_key": org.license_key,
        "modules": {key: key not in hidden_modules(org) for key in MODULES},
        "billing_email": org.billing_email,
        "logo_url": org.logo_url,
        "brand_color": org.brand_color,
        "slug": org.slug,
        "timezone": org.timezone or "",
        "created_at": org.created_at.isoformat(timespec="seconds") + "Z",
    }
    if private:
        data["notes"] = org.notes
        data["suspended"] = org.suspended
        data["purchased_seats"] = org.seats
        data["discount_percent"] = org.discount_percent or 0
    return data


def get_org(db: Session, user: User) -> Organization:
    cache = db.info.setdefault("org_cache", {})
    if user.org_id not in cache:
        cache[user.org_id] = db.get(Organization, user.org_id)
    org = cache[user.org_id]
    if org is None:
        raise HTTPException(403, "This account is not attached to a workspace")
    return org


def has_feature(db: Session, org_id: int | None, feature: str) -> bool:
    if org_id is None:
        return True
    cache = db.info.setdefault("feature_cache", {})
    if org_id not in cache:
        org = db.get(Organization, org_id)
        cache[org_id] = set(plan_features(org.plan)) if org else set()
    return feature in cache[org_id]


def require_feature(db: Session, user: User, feature: str) -> None:
    if not has_feature(db, user.org_id, feature):
        raise HTTPException(
            402, f"{FEATURES[feature]} is not included in your plan. Upgrade on the Billing page to use it."
        )


def check_seat_available(db: Session, org: Organization, adding: int = 1) -> None:
    limit = seat_limit(org)
    if limit is not None and usage(db, org.id)["users"] + adding > limit:
        raise HTTPException(
            402,
            f"Your license covers {limit} user{'' if limit == 1 else 's'} and all are in use. "
            "Disable someone, or request more seats on the Billing page.",
        )


def check_project_available(db: Session, org: Organization) -> None:
    limit = org.plan.max_projects if org.plan else None
    if limit is not None and usage(db, org.id)["projects"] >= limit:
        raise HTTPException(
            402,
            f"Your plan includes {limit} project{'' if limit == 1 else 's'} and all are in use. "
            "Delete a project you no longer need, or upgrade on the Billing page.",
        )


def new_license_key() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "TRK-" + "-".join("".join(secrets.choice(alphabet) for _ in range(5)) for _ in range(4))


def period_days(period: str) -> int:
    return 365 if period == "yearly" else 30


def quote(plan: Plan, seats: int, period: str) -> float:
    price = plan.price_yearly if period == "yearly" else plan.price_monthly
    return round(price * seats, 2)


def price_quote(db: Session, org: Organization, plan: Plan, seats: int, period: str, coupon_code: str = "") -> dict:
    """List price, the discounts that apply (the workspace's own, then a coupon) and what is due."""
    from .models import Coupon

    list_amount = quote(plan, seats, period)
    amount = list_amount
    notes = []
    if org.discount_percent:
        amount -= amount * org.discount_percent / 100
        notes.append(f"{org.discount_percent:g}% customer discount")
    coupon = None
    code = (coupon_code or "").strip().upper()
    if code:
        coupon = db.scalar(select(Coupon).where(Coupon.code == code))
        if (not coupon or not coupon.active or (coupon.expires_at and coupon.expires_at < utcnow())
                or (coupon.max_uses is not None and coupon.used >= coupon.max_uses)):
            raise HTTPException(422, "That coupon code is not valid any more")
        if coupon.percent_off:
            amount -= amount * coupon.percent_off / 100
            notes.append(f"{coupon.percent_off:g}% off with {coupon.code}")
        if coupon.amount_off:
            amount -= coupon.amount_off
            notes.append(f"{coupon.amount_off:g} off with {coupon.code}")
    amount = round(max(0.0, amount), 2)
    return {
        "list_amount": list_amount, "amount": amount, "discount": round(list_amount - amount, 2),
        "discount_note": ", ".join(notes)[:200], "coupon_code": coupon.code if coupon else "",
    }


def purge_organization(db: Session, org: Organization) -> None:
    """Permanently delete a workspace and everything in it."""
    for project in db.scalars(
        select(Project).where(Project.org_id == org.id).execution_options(include_deleted=True, all_orgs=True)
    ).all():
        db.delete(project)
    db.flush()
    for user in db.scalars(select(User).where(User.org_id == org.id).execution_options(all_orgs=True)).all():
        db.delete(user)
    db.flush()
    db.delete(org)
    db.info.pop("org_cache", None)


def create_organization(db: Session, name: str, settings: dict | None = None) -> Organization:
    """A new workspace starts on the free trial."""
    settings = settings or get_settings(db)
    trial = db.scalar(select(Plan).where(Plan.key == "trial"))
    try:
        days = max(1, int(settings.get("trial_days", "14")))
    except ValueError:
        days = 14
    org = Organization(
        name=name.strip()[:120],
        plan_id=trial.id if trial else None,
        seats=trial.max_users if trial else 5,
        is_trial=True,
        valid_until=utcnow() + timedelta(days=days),
        hidden_modules=",".join(NEW_WORKSPACE_HIDDEN),
    )
    db.add(org)
    db.flush()
    return org


# ───────────── Start-up ─────────────


def bootstrap(db: Session) -> None:
    """Seed plans and settings, and convert a pre-SaaS installation into the first workspace."""
    existing = {p.key for p in db.scalars(select(Plan))}
    for spec in DEFAULT_PLANS:
        if spec["key"] not in existing:
            db.add(Plan(**{**spec, "features": json.dumps(spec["features"])}))
    db.flush()

    # Capabilities added after a plan was created are switched on for the plans meant to have everything.
    done = db.get(PlatformSetting, "features_added")
    known = set((done.value if done else "").split(","))
    new = [f for f in ("security",) if f not in known]
    if new:
        for plan in db.scalars(select(Plan).where(Plan.key.in_(("trial", "enterprise")))):
            plan.features = json.dumps([f for f in FEATURES if f in set(plan_features(plan)) | set(new)])
        value = ",".join(sorted((known | set(new)) - {""}))
        if done:
            done.value = value
        else:
            db.add(PlatformSetting(key="features_added", value=value))

    orphans = db.scalar(select(func.count()).select_from(User).where(User.org_id.is_(None)))
    if orphans:
        enterprise = db.scalar(select(Plan).where(Plan.key == "enterprise"))
        org = db.scalar(select(Organization).order_by(Organization.id).limit(1))
        if org is None:
            # The data that existed before workspaces becomes the owner's own workspace,
            # with a license that never expires.
            org = Organization(
                name="My workspace", plan_id=enterprise.id, seats=None, is_trial=False,
                valid_until=None, license_key=new_license_key(), notes="Original installation",
            )
            db.add(org)
            db.flush()
        db.execute(update(User).where(User.org_id.is_(None)).values(org_id=org.id))
        db.execute(update(Project).where(Project.org_id.is_(None)).values(org_id=org.id).execution_options(include_deleted=True))
        db.execute(update(ProjectTemplate).where(ProjectTemplate.org_id.is_(None), ProjectTemplate.builtin.is_(False)).values(org_id=org.id))
        db.execute(update(AuditLog).where(AuditLog.org_id.is_(None)).values(org_id=org.id))

    # There must always be someone who runs the platform: the longest-standing administrator.
    if not db.scalar(select(User.id).where(User.is_platform_admin.is_(True)).limit(1)):
        first_admin = db.scalar(select(User).where(User.role == "admin", User.is_active).order_by(User.id).limit(1))
        if first_admin:
            first_admin.is_platform_admin = True
    db.commit()
