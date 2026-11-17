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

from .models import format_public_id
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
    "approvals_advanced": "Strict sign-off, sign-off checklists, reminders and escalation",
    "time_tracking": "Time tracking and timesheets",
    "tests": "Test management",
    "client_portal": "Client portal (share links and client feedback)",
    "portfolio": "Portfolio",
}
ALL_FEATURES = list(FEATURES)
# Features that every workspace used to have before they could be bought as add-ons. Workspaces that
# existed then keep them free of charge (see _grandfather_addons).
FORMERLY_FREE = ("time_tracking", "tests", "client_portal", "portfolio")

CORE = "Projects, features with sign-off, milestones, issues, board, roadmap, calendar, docs, risks and chat"
DEFAULT_PLANS = [
    {
        "key": "trial", "name": "Free trial", "sort": 0, "is_public": False,
        "description": "Every feature and add-on, to try Trackly with your team.",
        "price_monthly": 0, "price_yearly": 0, "max_users": 5, "max_projects": 3, "features": ALL_FEATURES,
    },
    {
        "key": "free", "name": "Free", "sort": 1, "is_public": True,
        "description": "For a very small team getting started. Free for ever.",
        "price_monthly": 0, "price_yearly": 0, "max_users": 3, "max_projects": 2, "features": [],
    },
    {
        "key": "starter", "name": "Starter", "sort": 2, "is_public": True,
        "description": "Sprints, custom workflows and group chat for a small team.",
        "price_monthly": 6, "price_yearly": 60, "max_users": 10, "max_projects": 10,
        "features": ["sprints", "customization", "group_chat"],
    },
    {
        "key": "professional", "name": "Professional", "sort": 3, "is_public": True,
        "description": "Stage sign-off, time tracking and workload for growing teams.",
        "price_monthly": 9, "price_yearly": 90, "max_users": 25, "max_projects": None,
        "features": ["sprints", "customization", "group_chat", "approvals", "time_tracking", "workload"],
    },
    {
        "key": "business", "name": "Business", "sort": 4, "is_public": True,
        "description": "Strict sign-off, budgets, automation, portfolio and the client portal.",
        "price_monthly": 12, "price_yearly": 120, "max_users": 100, "max_projects": None,
        "features": ["sprints", "customization", "group_chat", "approvals", "time_tracking", "workload",
                     "approvals_advanced", "budgets", "automation", "portfolio", "client_portal"],
    },
    {
        "key": "enterprise", "name": "Enterprise", "sort": 5, "is_public": True,
        "description": "Everything, including test management and advanced security, for unlimited users.",
        "price_monthly": 20, "price_yearly": 200, "max_users": None, "max_projects": None, "features": ALL_FEATURES,
    },
]
# The plans as first shipped. A plan still exactly like this was never edited by the platform
# owner, so it can safely be replaced by the current version (see _upgrade_plans).
ORIGINAL_PLANS = {
    "starter": {"price_monthly": 6, "price_yearly": 60, "max_users": 10, "max_projects": 10, "features": ["sprints", "customization"]},
    "business": {"price_monthly": 12, "price_yearly": 120, "max_users": 50, "max_projects": None,
                 "features": ["sprints", "customization", "automation", "approvals", "workload", "budgets", "group_chat"]},
}

# Extras a workspace can buy on top of any plan, priced per user like plans.
DEFAULT_ADDONS = [
    {"key": "approvals_pro", "name": "Approvals Pro", "sort": 1, "price_monthly": 2, "price_yearly": 20,
     "description": "Strict request-and-approve sign-off, sign-off checklists, reminders and escalation.",
     "features": ["approvals", "approvals_advanced"]},
    {"key": "client_portal", "name": "Client portal", "sort": 2, "price_monthly": 2, "price_yearly": 20,
     "description": "Read-only progress links for clients, with client comments and approvals.",
     "features": ["client_portal"]},
    {"key": "time_budgets", "name": "Time and budgets", "sort": 3, "price_monthly": 3, "price_yearly": 30,
     "description": "Time tracking, timesheets, project budgets and costs from logged hours.",
     "features": ["time_tracking", "budgets"]},
    {"key": "test_management", "name": "Test management", "sort": 4, "price_monthly": 2, "price_yearly": 20,
     "description": "Test cases and test runs per feature; a failed test raises a bug.",
     "features": ["tests"]},
    {"key": "automation", "name": "Automation", "sort": 5, "price_monthly": 2, "price_yearly": 20,
     "description": "Rules that assign, label and move issues for you.",
     "features": ["automation"]},
    {"key": "resource_planning", "name": "Resource planning", "sort": 6, "price_monthly": 2, "price_yearly": 20,
     "description": "Workload per person and every project side by side in a portfolio.",
     "features": ["workload", "portfolio"]},
    {"key": "advanced_security", "name": "Advanced security", "sort": 7, "price_monthly": 3, "price_yearly": 30,
     "description": "Allowed networks (IP allowlist) and the full audit log.",
     "features": ["security", "audit_log"]},
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


def addon_features(addon) -> list[str]:
    try:
        return [f for f in json.loads(addon.features or "[]") if f in FEATURES]
    except ValueError:
        return []


def addon_out(addon) -> dict:
    return {
        "id": addon.id,
        "key": addon.key,
        "name": addon.name,
        "description": addon.description,
        "price_monthly": addon.price_monthly,
        "price_yearly": addon.price_yearly,
        "features": addon_features(addon),
        "is_public": addon.is_public,
        "sort": addon.sort,
    }


def split_keys(value: str | None) -> list[str]:
    return [k for k in (value or "").split(",") if k]


def all_addons(db: Session, public_only: bool = False) -> list:
    from .models import Addon

    query = select(Addon).order_by(Addon.sort, Addon.id)
    if public_only:
        query = query.where(Addon.is_public)
    return db.scalars(query).all()


def org_addons(db: Session, org: Organization) -> list:
    """The add-ons this workspace has, in catalogue order."""
    keys = set(split_keys(org.addons))
    return [a for a in all_addons(db) if a.key in keys] if keys else []


def effective_features(db: Session, org: Organization) -> list[str]:
    """What the workspace can use: its plan, plus its add-ons."""
    have = set(plan_features(org.plan))
    for addon in org_addons(db, org):
        have |= set(addon_features(addon))
    return [f for f in FEATURES if f in have]


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
        "public_id": format_public_id(org.public_id),
        "status": status,
        "is_trial": org.is_trial,
        "plan": plan_out(org.plan) if org.plan else None,
        "features": effective_features(db, org),
        "plan_features": plan_features(org.plan),
        "addons": [addon_out(a) | {"free": a.key in split_keys(org.free_addons)} for a in org_addons(db, org)],
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
        cache[org_id] = set(effective_features(db, org)) if org else set()
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


def quote(plan: Plan, seats: int, period: str, addons: list | None = None) -> float:
    price = plan.price_yearly if period == "yearly" else plan.price_monthly
    for addon in addons or []:
        price += addon.price_yearly if period == "yearly" else addon.price_monthly
    return round(price * seats, 2)


def chosen_addons(db: Session, plan: Plan, keys: list[str], free: list[str] | None = None) -> list:
    """The add-ons someone asked for, without the ones the plan already includes or that are free."""
    wanted = set(keys)
    catalogue = {a.key: a for a in all_addons(db)}
    unknown = [k for k in wanted if k not in catalogue or not catalogue[k].is_public]
    if unknown:
        raise HTTPException(422, f"Unknown add-on: {unknown[0]}")
    included = set(plan_features(plan))
    skip = set(free or [])
    return [a for a in catalogue.values()
            if a.key in wanted and a.key not in skip and not set(addon_features(a)) <= included]


def price_quote(db: Session, org: Organization, plan: Plan, seats: int, period: str, coupon_code: str = "",
                addon_keys: list[str] | None = None) -> dict:
    """List price (plan plus add-ons), the discounts that apply (the workspace's own, then a coupon) and what is due."""
    from .models import Coupon

    addons = chosen_addons(db, plan, addon_keys or [], split_keys(org.free_addons))
    list_amount = quote(plan, seats, period, addons)
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
    per_user = lambda item: item.price_yearly if period == "yearly" else item.price_monthly  # noqa: E731
    return {
        "list_amount": list_amount, "amount": amount, "discount": round(list_amount - amount, 2),
        "discount_note": ", ".join(notes)[:200], "coupon_code": coupon.code if coupon else "",
        "lines": [{"name": plan.name, "per_user": per_user(plan), "amount": round(per_user(plan) * seats, 2)}]
        + [{"name": a.name, "key": a.key, "per_user": per_user(a), "amount": round(per_user(a) * seats, 2)} for a in addons],
        "addons": [a.key for a in addons],
    }


# ───────────── Changing the currency ─────────────

# Rough rates to start from when the platform owner switches currency; they always confirm or edit it.
SUGGESTED_RATES = {
    ("USD", "INR"): 84, ("EUR", "INR"): 90, ("GBP", "INR"): 106, ("AED", "INR"): 23, ("SGD", "INR"): 62,
    ("USD", "EUR"): 0.92, ("USD", "GBP"): 0.79, ("EUR", "USD"): 1.09, ("GBP", "USD"): 1.27,
}


def suggested_rate(old: str, new: str) -> float | None:
    if old == new:
        return 1
    if (old, new) in SUGGESTED_RATES:
        return SUGGESTED_RATES[(old, new)]
    if (new, old) in SUGGESTED_RATES:
        return round(1 / SUGGESTED_RATES[(new, old)], 6)
    return None


def friendly_price(value: float) -> float:
    """A price people expect to see: 504 -> 499, 1680 -> 1699, 5.94 -> 6, 0 stays 0."""
    if value <= 0:
        return 0
    if value >= 100:
        return max(49, round(value / 50) * 50 - 1)
    if value >= 10:
        return float(round(value))
    return max(0.5, round(value * 2) / 2)


def convert_prices(db: Session, rate: float, friendly: bool = True, apply: bool = False) -> list[dict]:
    """Every plan, add-on and fixed-amount coupon priced in the new currency. Yearly prices that were
    ten times the monthly one stay ten times the (rounded) monthly one."""
    from .models import Coupon

    def money(value: float) -> float:
        converted = value * rate
        return friendly_price(converted) if friendly else round(converted, 2)

    rows = []
    for kind, items in (("Plan", db.scalars(select(Plan).order_by(Plan.sort, Plan.id)).all()), ("Add-on", all_addons(db))):
        for item in items:
            monthly = money(item.price_monthly)
            ten_times = abs(item.price_yearly - item.price_monthly * 10) < 0.01
            yearly = round(monthly * 10, 2) if ten_times else money(item.price_yearly)
            rows.append({"kind": kind, "name": item.name, "old_monthly": item.price_monthly, "old_yearly": item.price_yearly,
                         "monthly": monthly, "yearly": yearly})
            if apply:
                item.price_monthly, item.price_yearly = monthly, yearly
    for coupon in db.scalars(select(Coupon).where(Coupon.amount_off > 0)).all():
        new = money(coupon.amount_off)
        rows.append({"kind": "Coupon", "name": coupon.code, "old_monthly": coupon.amount_off, "monthly": new})
        if apply:
            coupon.amount_off = new
    return rows


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


def _once(db: Session, key: str) -> bool:
    """True the first time a one-off upgrade step runs on this installation."""
    if db.get(PlatformSetting, key):
        return False
    db.add(PlatformSetting(key=key, value="done"))
    db.flush()
    return True


def _seed_addons(db: Session) -> None:
    from .models import Addon

    existing = {a.key for a in db.scalars(select(Addon))}
    for spec in DEFAULT_ADDONS:
        if spec["key"] not in existing:
            db.add(Addon(**{**spec, "features": json.dumps(spec["features"])}))
    db.flush()


def _upgrade_plans(db: Session) -> None:
    """Once, when add-ons arrive: plans the platform owner never edited take the new line-up; edited
    ones keep what they had, plus the features everyone used to get for free."""
    if not _once(db, "plans_v2"):
        return
    specs = {p["key"]: p for p in DEFAULT_PLANS}
    for plan in db.scalars(select(Plan)):
        spec = specs.get(plan.key)
        original = ORIGINAL_PLANS.get(plan.key)
        untouched = original is not None and all(
            (plan_features(plan) if k == "features" else getattr(plan, k)) == v for k, v in original.items()
        )
        if spec and set(plan_features(plan)) == set(spec["features"]):
            pass  # already the current version (a fresh installation)
        elif untouched and spec:
            for k in ("description", "price_monthly", "price_yearly", "max_users", "max_projects", "sort"):
                setattr(plan, k, spec[k])
            plan.features = json.dumps(spec["features"])
        elif plan.key not in ("trial", "enterprise"):
            have = set(plan_features(plan)) | set(FORMERLY_FREE)
            if "approvals" in have:
                have.add("approvals_advanced")  # strict sign-off came with approvals before
            plan.features = json.dumps([f for f in FEATURES if f in have])
        if spec and plan.key in ("trial", "free", "starter", "professional", "business", "enterprise"):
            plan.sort = spec["sort"]
    db.flush()


def _grandfather_addons(db: Session) -> None:
    """Once: workspaces that existed before add-ons keep, free of charge, the add-ons for features they
    could already use, so nobody loses anything they had."""
    if not _once(db, "addons_grandfathered"):
        return
    catalogue = all_addons(db)
    for org in db.scalars(select(Organization)):
        if org.plan and org.plan.key == "trial":
            continue  # the trial has everything; a plan chosen later decides
        have = set(plan_features(org.plan))
        grant = [a.key for a in catalogue
                 if set(addon_features(a)) & set(FORMERLY_FREE) - have and a.key in ("client_portal", "time_budgets", "test_management", "resource_planning")]
        if grant:
            org.addons = ",".join(sorted(set(split_keys(org.addons)) | set(grant)))
            org.free_addons = ",".join(sorted(set(split_keys(org.free_addons)) | set(grant)))
    db.flush()


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
    new = [f for f in ("security", "approvals_advanced", "time_tracking", "tests", "client_portal", "portfolio") if f not in known]
    if new:
        for plan in db.scalars(select(Plan).where(Plan.key.in_(("trial", "enterprise")))):
            plan.features = json.dumps([f for f in FEATURES if f in set(plan_features(plan)) | set(new)])
        value = ",".join(sorted((known | set(new)) - {""}))
        if done:
            done.value = value
        else:
            db.add(PlatformSetting(key="features_added", value=value))

    _seed_addons(db)
    _upgrade_plans(db)

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

    _grandfather_addons(db)

    # There must always be someone who runs the platform: the longest-standing administrator.
    if not db.scalar(select(User.id).where(User.is_platform_admin.is_(True)).limit(1)):
        first_admin = db.scalar(select(User).where(User.role == "admin", User.is_active).order_by(User.id).limit(1))
        if first_admin:
            first_admin.is_platform_admin = True
    db.commit()
