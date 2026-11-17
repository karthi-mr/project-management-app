"""Everything around the product: public pages, client share links, data export, onboarding,
coupons, announcements, the support inbox and the owner's usage analytics."""
import json
import secrets
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..database import Base, get_db
from ..models import (
    Announcement,
    Coupon,
    Invoice,
    Issue,
    LicenseRequest,
    Notification,
    Organization,
    Project,
    ShareLink,
    SupportMessage,
    SupportTicket,
    User,
    utcnow,
)
from ..saas import get_org, get_settings, license_status, purge_organization
from ..security import get_current_user, require_admin, require_platform_admin, verify_password
from ..serializers import dt, user_brief
from .projects import get_project

router = APIRouter(prefix="/api", tags=["growth"])

SHARE_SECTIONS = ("milestones", "features", "releases", "issues")


# ───────────── Public pages ─────────────


@router.get("/public/legal")
def legal(db: Session = Depends(get_db)):
    s = get_settings(db)
    return {
        "company_name": s["company_name"], "support_email": s["support_email"],
        "terms": s["terms_text"], "privacy": s["privacy_text"],
    }


@router.get("/public/workspace/{slug}")
def workspace_brand(slug: str, db: Session = Depends(get_db)):
    """Name, logo and colour for a workspace's own sign-in page."""
    org = db.scalar(select(Organization).where(Organization.slug == slug.lower()))
    if not org or org.suspended:
        raise HTTPException(404, "Workspace not found")
    return {"name": org.name, "logo_url": org.logo_url, "brand_color": org.brand_color, "slug": org.slug}


# ───────────── Client share links ─────────────


class ShareIn(BaseModel):
    label: str = Field(default="", max_length=120)
    sections: list[Literal["milestones", "features", "releases", "issues"]] = ["milestones", "features", "releases"]
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)
    allow_feedback: bool = True


def share_out(link: ShareLink) -> dict:
    expired = link.expires_at is not None and link.expires_at < utcnow()
    return {
        "id": link.id, "token": link.token, "label": link.label,
        "sections": [s for s in link.sections.split(",") if s],
        "expires_at": dt(link.expires_at), "expired": expired, "views": link.views,
        "allow_feedback": bool(link.allow_feedback),
        "last_viewed_at": dt(link.last_viewed_at), "created_by": user_brief(link.created_by),
        "created_at": dt(link.created_at),
    }


@router.get("/projects/{project_id}/share-links")
def list_share_links(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_project(db, project_id, user, manage=True, write=False)
    rows = db.scalars(select(ShareLink).where(ShareLink.project_id == project_id, ShareLink.revoked.is_(False)).order_by(ShareLink.id.desc())).all()
    return [share_out(r) for r in rows]


@router.post("/projects/{project_id}/share-links", status_code=201)
def create_share_link(project_id: int, data: ShareIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = get_project(db, project_id, user, manage=True)
    if not data.sections:
        raise HTTPException(422, "Choose at least one thing to share")
    link = ShareLink(
        project_id=project.id, token=secrets.token_urlsafe(24), label=data.label.strip(),
        sections=",".join(s for s in SHARE_SECTIONS if s in data.sections),
        expires_at=utcnow() + timedelta(days=data.expires_in_days) if data.expires_in_days else None,
        created_by_id=user.id, allow_feedback=data.allow_feedback,
    )
    db.add(link)
    from .projects import log_activity

    log_activity(db, project.id, user, f"created a client share link{f' “{link.label}”' if link.label else ''}")
    db.commit()
    return share_out(link)


@router.delete("/share-links/{link_id}", status_code=204)
def revoke_share_link(link_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    link = db.get(ShareLink, link_id)
    if not link or link.project is None:
        raise HTTPException(404, "Link not found")
    get_project(db, link.project_id, user, manage=True)
    link.revoked = True
    db.commit()


@router.get("/public/share/{token}")
def shared_project(token: str, db: Session = Depends(get_db)):
    """What a client sees: read-only progress, with no names of people and no internal notes."""
    link = db.scalar(select(ShareLink).where(ShareLink.token == token))
    if not link or link.revoked or link.project is None or (link.expires_at and link.expires_at < utcnow()):
        raise HTTPException(404, "This link is not valid any more")
    project = link.project
    org = db.get(Organization, project.org_id)
    if org is None or org.suspended:
        raise HTTPException(404, "This link is not valid any more")
    link.views = (link.views or 0) + 1
    link.last_viewed_at = utcnow()
    sections = set(link.sections.split(","))
    issues = list(project.issues)
    done = sum(1 for i in issues if i.status == "done")

    def progress(items) -> int:
        items = list(items)
        return round(sum(1 for i in items if i.status == "done") * 100 / len(items)) if items else 0

    data = {
        "workspace": {"name": org.name, "logo_url": org.logo_url, "brand_color": org.brand_color},
        "project": {
            "name": project.name, "description": project.description, "color": project.color,
            "logo_url": project.logo_url, "status": project.status, "phase": project.phase,
            "start_date": project.start_date.isoformat() if project.start_date else None,
            "due_date": project.due_date.isoformat() if project.due_date else None,
            "progress": round(done * 100 / len(issues)) if issues else 0,
            "issue_count": len(issues), "done_count": done,
        },
        "sections": [s for s in SHARE_SECTIONS if s in sections],
        "allow_feedback": bool(link.allow_feedback),
        "updated_at": dt(utcnow()),
    }
    if "milestones" in sections:
        data["milestones"] = [
            {"id": m.id, "name": m.name, "stage": m.stage, "status": m.status, "progress": progress(m.issues),
             "start_date": m.start_date.isoformat() if m.start_date else None,
             "due_date": m.due_date.isoformat() if m.due_date else None}
            for m in sorted(project.milestones, key=lambda m: (m.due_date or date.max, m.id))
        ]
    if "features" in sections:
        data["features"] = [
            {"id": f.id, "title": f.title, "stage": f.stage, "priority": f.priority, "progress": progress(f.issues),
             "target_date": f.target_date.isoformat() if f.target_date else None,
             "release": f.release.version if f.release else None}
            for f in sorted(project.features, key=lambda f: (f.target_date or date.max, f.id))
        ]
    if "releases" in sections:
        data["releases"] = [
            {"version": r.version, "environment": r.environment, "status": r.status,
             "planned_date": r.planned_date.isoformat() if r.planned_date else None,
             "deployed_at": dt(r.deployed_at)}
            for r in sorted(project.releases, key=lambda r: (r.planned_date or date.max, r.id))
        ]
    if "issues" in sections:
        counts: dict[str, int] = defaultdict(int)
        for i in issues:
            counts[i.status] += 1
        data["issues"] = {
            "by_status": counts,
            "open": [
                {"key": f"{project.key}-{i.number}", "title": i.title, "type": i.type, "status": i.status,
                 "priority": i.priority, "due_date": i.due_date.isoformat() if i.due_date else None}
                for i in sorted(issues, key=lambda i: (i.due_date or date.max, i.number)) if i.status != "done"
            ][:100],
        }
    db.commit()
    return data


# ───────────── Your data: export and delete ─────────────


def _rows(db: Session, table, column, ids) -> list[dict]:
    if not ids:
        return []
    out = []
    for row in db.execute(select(table).where(column.in_(ids))).mappings():
        out.append({k: (v.isoformat() if isinstance(v, (datetime, date)) else v) for k, v in row.items() if not isinstance(v, (bytes, memoryview))})
    return out


@router.get("/billing/export")
def export_workspace(request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Everything this workspace has stored, as one JSON file. Passwords are never included."""
    org = get_org(db, admin)
    tables = Base.metadata.tables
    user_ids = list(db.scalars(select(User.id).where(User.org_id == org.id)))
    project_ids = list(db.scalars(select(Project.id).where(Project.org_id == org.id).execution_options(include_deleted=True)))
    issue_ids = list(db.scalars(select(Issue.id).where(Issue.project_id.in_(project_ids)).execution_options(include_deleted=True))) if project_ids else []

    data: dict = {
        "exported_at": dt(utcnow()),
        "workspace": {"name": org.name, "plan": org.plan.name if org.plan else None, "created_at": dt(org.created_at)},
    }
    secret = {"password_hash", "token_version", "preferences"}
    data["users"] = [{k: v for k, v in row.items() if k not in secret} for row in _rows(db, tables["users"], tables["users"].c.id, user_ids)]
    data["projects"] = _rows(db, tables["projects"], tables["projects"].c.id, project_ids)
    skip = {"users", "projects", "files", "notifications", "share_links", "automation_runs"}
    for name, table in sorted(tables.items()):
        if name in skip:
            continue
        if "project_id" in table.c:
            data[name] = _rows(db, table, table.c.project_id, project_ids)
        elif "issue_id" in table.c:
            data[name] = _rows(db, table, table.c.issue_id, issue_ids)
    data["invoices"] = _rows(db, tables["invoices"], tables["invoices"].c.org_id, [org.id])
    audit(db, admin, "workspace.exported", org.name, request)
    db.commit()
    filename = f"trackly-export-{date.today().isoformat()}.json"
    return Response(
        content=json.dumps(data, indent=1, default=str),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class DeleteWorkspaceIn(BaseModel):
    name: str = Field(max_length=120)
    password: str = Field(max_length=200)


@router.post("/billing/delete-workspace", status_code=204)
def delete_workspace(data: DeleteWorkspaceIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Permanently delete this workspace and everything in it."""
    org = get_org(db, admin)
    if admin.is_platform_admin:
        raise HTTPException(400, "The platform owner's workspace cannot be deleted")
    if data.name.strip() != org.name:
        raise HTTPException(422, "Type the workspace name exactly to confirm")
    if not verify_password(data.password, admin.password_hash):
        raise HTTPException(403, "That password is not correct")
    name = org.name
    owners = db.scalars(select(User).where(User.is_platform_admin.is_(True)).execution_options(all_orgs=True)).all()
    for owner in owners:
        db.add(Notification(user_id=owner.id, message=f"The workspace {name} was deleted by its administrator"))
    db.info.pop("org_id", None)
    purge_organization(db, org)
    db.commit()


# ───────────── Onboarding ─────────────


@router.get("/onboarding")
def onboarding(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """A short getting-started checklist for the administrators of a new workspace."""
    org = get_org(db, user)
    if user.role != "admin" or org.onboarding_done:
        return {"show": False, "steps": []}
    projects = db.scalars(select(Project).where(Project.org_id == org.id)).all()
    own_projects = [p for p in projects if not p.name.endswith("(example)")]
    people = db.scalar(select(func.count()).select_from(User).where(User.org_id == org.id))
    own_issue = db.scalar(
        select(func.count()).select_from(Issue).where(Issue.project_id.in_([p.id for p in own_projects]))
    ) if own_projects else 0
    requested = db.scalar(select(func.count()).select_from(LicenseRequest).where(LicenseRequest.org_id == org.id))
    steps = [
        {"key": "explore", "title": "Look around the example project", "hint": "See features, issues and milestones working together.",
         "done": True, "to": f"/projects/{projects[0].id}" if projects else "/projects"},
        {"key": "project", "title": "Create your first project", "hint": "Start empty or from a template.",
         "done": bool(own_projects), "to": "/projects"},
        {"key": "invite", "title": "Add your team", "hint": "Create accounts for the people you work with.",
         "done": people > 1, "to": "/users"},
        {"key": "issue", "title": "Add an issue to your project", "hint": "Track the first piece of work.",
         "done": bool(own_issue), "to": f"/projects/{own_projects[0].id}?tab=board" if own_projects else "/projects"},
        {"key": "brand", "title": "Add your logo", "hint": "Make the workspace yours on the Billing page.",
         "done": bool(org.logo_url), "to": "/billing"},
        {"key": "plan", "title": "Choose a plan", "hint": "Before the trial ends, so nothing is interrupted.",
         "done": bool(requested) or not org.is_trial, "to": "/billing"},
    ]
    return {"show": True, "steps": steps, "done": sum(1 for s in steps if s["done"]), "total": len(steps)}


@router.post("/onboarding/dismiss", status_code=204)
def dismiss_onboarding(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    get_org(db, admin).onboarding_done = True
    db.commit()


# ───────────── Announcements ─────────────


class AnnouncementIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(default="", max_length=5000)
    level: Literal["info", "warning"] = "info"
    audience: Literal["all", "admins"] = "all"
    active: bool = True
    expires_in_days: int | None = Field(default=None, ge=1, le=365)


def announcement_out(a: Announcement) -> dict:
    return {
        "id": a.id, "title": a.title, "body": a.body, "level": a.level, "audience": a.audience,
        "active": a.active, "expires_at": dt(a.expires_at), "created_at": dt(a.created_at),
        "live": a.active and (a.expires_at is None or a.expires_at > utcnow()),
    }


@router.get("/announcements")
def announcements(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Announcement).where(Announcement.active.is_(True)).order_by(Announcement.id.desc()).limit(20)).all()
    now = utcnow()
    return [
        announcement_out(a) for a in rows
        if (a.expires_at is None or a.expires_at > now) and (a.audience == "all" or user.role == "admin")
    ]


@router.get("/platform/announcements")
def all_announcements(_: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    return [announcement_out(a) for a in db.scalars(select(Announcement).order_by(Announcement.id.desc()).limit(100)).all()]


@router.post("/platform/announcements", status_code=201)
def create_announcement(data: AnnouncementIn, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    a = Announcement(
        title=data.title.strip(), body=data.body.strip(), level=data.level, audience=data.audience, active=data.active,
        expires_at=utcnow() + timedelta(days=data.expires_in_days) if data.expires_in_days else None,
    )
    db.add(a)
    audit(db, owner, "platform.announcement", a.title, request)
    db.commit()
    return announcement_out(a)


@router.patch("/platform/announcements/{announcement_id}")
def toggle_announcement(announcement_id: int, data: dict, _: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    a = db.get(Announcement, announcement_id)
    if not a:
        raise HTTPException(404, "Announcement not found")
    if isinstance(data.get("active"), bool):
        a.active = data["active"]
    db.commit()
    return announcement_out(a)


@router.delete("/platform/announcements/{announcement_id}", status_code=204)
def delete_announcement(announcement_id: int, _: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    a = db.get(Announcement, announcement_id)
    if a:
        db.delete(a)
        db.commit()


# ───────────── Coupons ─────────────


class CouponIn(BaseModel):
    code: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    description: str = Field(default="", max_length=200)
    percent_off: float = Field(default=0, ge=0, le=100)
    amount_off: float = Field(default=0, ge=0, le=1e9)
    max_uses: int | None = Field(default=None, ge=1, le=1000000)
    expires_on: date | None = None
    active: bool = True


def coupon_out(c: Coupon) -> dict:
    return {
        "id": c.id, "code": c.code, "description": c.description, "percent_off": c.percent_off,
        "amount_off": c.amount_off, "max_uses": c.max_uses, "used": c.used,
        "expires_on": c.expires_at.date().isoformat() if c.expires_at else None, "active": c.active,
        "usable": c.active and (c.expires_at is None or c.expires_at > utcnow()) and (c.max_uses is None or c.used < c.max_uses),
    }


def _apply_coupon(c: Coupon, data: CouponIn) -> None:
    if not data.percent_off and not data.amount_off:
        raise HTTPException(422, "Give the coupon a percentage or an amount off")
    c.description = data.description.strip()
    c.percent_off = data.percent_off
    c.amount_off = data.amount_off
    c.max_uses = data.max_uses
    c.expires_at = datetime.combine(data.expires_on, datetime.max.time()).replace(microsecond=0) if data.expires_on else None
    c.active = data.active


@router.get("/platform/coupons")
def list_coupons(_: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    return [coupon_out(c) for c in db.scalars(select(Coupon).order_by(Coupon.id.desc())).all()]


@router.post("/platform/coupons", status_code=201)
def create_coupon(data: CouponIn, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    code = data.code.upper()
    if db.scalar(select(Coupon.id).where(Coupon.code == code)):
        raise HTTPException(409, "That code already exists")
    coupon = Coupon(code=code)
    _apply_coupon(coupon, data)
    db.add(coupon)
    audit(db, owner, "platform.coupon_created", code, request)
    db.commit()
    return coupon_out(coupon)


@router.put("/platform/coupons/{coupon_id}")
def update_coupon(coupon_id: int, data: CouponIn, _: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    coupon = db.get(Coupon, coupon_id)
    if not coupon:
        raise HTTPException(404, "Coupon not found")
    _apply_coupon(coupon, data)
    db.commit()
    return coupon_out(coupon)


@router.delete("/platform/coupons/{coupon_id}", status_code=204)
def delete_coupon(coupon_id: int, _: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    coupon = db.get(Coupon, coupon_id)
    if coupon:
        db.delete(coupon)
        db.commit()


# ───────────── Support inbox ─────────────


class TicketIn(BaseModel):
    subject: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=1, max_length=10000)


class ReplyIn(BaseModel):
    body: str = Field(min_length=1, max_length=10000)


def ticket_out(t: SupportTicket, full: bool = False) -> dict:
    last = t.messages[-1] if t.messages else None
    data = {
        "id": t.id, "subject": t.subject, "status": t.status, "user_name": t.user_name,
        "org_id": t.org_id, "org_name": t.organization.name if t.organization else None,
        "created_at": dt(t.created_at), "updated_at": dt(t.updated_at), "message_count": len(t.messages),
        "last_from_staff": bool(last and last.from_staff),
        "preview": (last.body[:140] if last else ""),
    }
    if full:
        data["messages"] = [
            {"id": m.id, "author": m.author_name, "from_staff": m.from_staff, "body": m.body, "created_at": dt(m.created_at)}
            for m in t.messages
        ]
    return data


def _my_ticket(db: Session, ticket_id: int, user: User) -> SupportTicket:
    ticket = db.get(SupportTicket, ticket_id)
    if not ticket or ticket.org_id != user.org_id or (user.role != "admin" and ticket.user_id != user.id):
        raise HTTPException(404, "Conversation not found")
    return ticket


def _notify_staff(db: Session, message: str) -> None:
    for owner in db.scalars(select(User).where(User.is_platform_admin.is_(True), User.is_active).execution_options(all_orgs=True)).all():
        db.add(Notification(user_id=owner.id, message=message[:500]))
        db.info.setdefault("notify_users", set()).add(owner.id)


@router.get("/support/tickets")
def my_tickets(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    stmt = select(SupportTicket).where(SupportTicket.org_id == user.org_id)
    if user.role != "admin":
        stmt = stmt.where(SupportTicket.user_id == user.id)
    settings = get_settings(db)
    return {
        "tickets": [ticket_out(t) for t in db.scalars(stmt.order_by(SupportTicket.updated_at.desc()).limit(100)).all()],
        "support_email": settings["support_email"],
    }


@router.post("/support/tickets", status_code=201)
def open_ticket(data: TicketIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    org = get_org(db, user)
    ticket = SupportTicket(org_id=org.id, user_id=user.id, user_name=user.full_name, subject=data.subject.strip())
    ticket.messages.append(SupportMessage(author_id=user.id, author_name=user.full_name, body=data.body.strip()))
    db.add(ticket)
    _notify_staff(db, f"Support: {user.full_name} ({org.name}) asked “{ticket.subject}”")
    db.commit()
    return ticket_out(ticket, full=True)


@router.get("/support/tickets/{ticket_id}")
def read_ticket(ticket_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return ticket_out(_my_ticket(db, ticket_id, user), full=True)


@router.post("/support/tickets/{ticket_id}/reply")
def reply_ticket(ticket_id: int, data: ReplyIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ticket = _my_ticket(db, ticket_id, user)
    ticket.messages.append(SupportMessage(author_id=user.id, author_name=user.full_name, body=data.body.strip()))
    ticket.status = "open"
    ticket.updated_at = utcnow()
    _notify_staff(db, f"Support: {user.full_name} replied on “{ticket.subject}”")
    db.commit()
    return ticket_out(ticket, full=True)


@router.post("/support/tickets/{ticket_id}/close")
def close_my_ticket(ticket_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ticket = _my_ticket(db, ticket_id, user)
    ticket.status = "closed"
    ticket.updated_at = utcnow()
    db.commit()
    return ticket_out(ticket, full=True)


@router.get("/platform/support")
def inbox(status: Literal["open", "answered", "closed"] | None = None, _: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    stmt = select(SupportTicket)
    if status:
        stmt = stmt.where(SupportTicket.status == status)
    rows = db.scalars(stmt.order_by(SupportTicket.status != "open", SupportTicket.updated_at.desc()).limit(200)).all()
    return {
        "tickets": [ticket_out(t) for t in rows],
        "open": db.scalar(select(func.count()).select_from(SupportTicket).where(SupportTicket.status == "open")),
    }


@router.get("/platform/support/{ticket_id}")
def inbox_ticket(ticket_id: int, _: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    ticket = db.get(SupportTicket, ticket_id)
    if not ticket:
        raise HTTPException(404, "Conversation not found")
    return ticket_out(ticket, full=True)


@router.post("/platform/support/{ticket_id}/reply")
def staff_reply(ticket_id: int, data: ReplyIn, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    ticket = db.get(SupportTicket, ticket_id)
    if not ticket:
        raise HTTPException(404, "Conversation not found")
    ticket.messages.append(SupportMessage(author_id=owner.id, author_name="Support", from_staff=True, body=data.body.strip()))
    ticket.status = "answered"
    ticket.updated_at = utcnow()
    if ticket.user_id:
        db.add(Notification(user_id=ticket.user_id, message=f"Support replied to “{ticket.subject}”"[:500]))
        db.info.setdefault("notify_users", set()).add(ticket.user_id)
    db.commit()
    return ticket_out(ticket, full=True)


@router.post("/platform/support/{ticket_id}/status")
def staff_status(ticket_id: int, data: dict, _: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    ticket = db.get(SupportTicket, ticket_id)
    if not ticket:
        raise HTTPException(404, "Conversation not found")
    if data.get("status") not in ("open", "answered", "closed"):
        raise HTTPException(422, "Unknown status")
    ticket.status = data["status"]
    ticket.updated_at = utcnow()
    db.commit()
    return ticket_out(ticket, full=True)


# ───────────── Owner analytics ─────────────


@router.get("/platform/analytics")
def analytics(_: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    now = utcnow()
    orgs = db.scalars(select(Organization)).all()
    last_seen = dict(db.execute(select(User.org_id, func.max(User.last_login)).group_by(User.org_id)).all())
    users = dict(db.execute(select(User.org_id, func.count()).where(User.is_active).group_by(User.org_id)).all())
    project_org = dict(db.execute(select(Project.id, Project.org_id)).all())
    month_ago = now - timedelta(days=30)
    issues_30: dict[int, int] = defaultdict(int)
    for project_id, count in db.execute(
        select(Issue.project_id, func.count()).where(Issue.created_at >= month_ago).group_by(Issue.project_id)
    ).all():
        issues_30[project_org.get(project_id)] += count
    paid_orgs = set(db.scalars(select(Invoice.org_id).distinct()))
    requested = set(db.scalars(select(LicenseRequest.org_id).where(LicenseRequest.status == "pending")))

    # Sign-ups per week for the last 12 weeks, oldest first.
    monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    weeks = []
    for n in range(11, -1, -1):
        start = monday - timedelta(weeks=n)
        end = start + timedelta(weeks=1)
        weeks.append({"week": start.date().isoformat(), "signups": sum(1 for o in orgs if start <= o.created_at < end)})

    def seen_within(org, days):
        seen = last_seen.get(org.id)
        return bool(seen and seen >= now - timedelta(days=days))

    finished_trials = [o for o in orgs if o.id in paid_orgs or (o.is_trial and o.valid_until and o.valid_until < now)]
    converted = [o for o in finished_trials if o.id in paid_orgs]

    def row(o):
        seen = last_seen.get(o.id)
        return {
            "id": o.id, "name": o.name, "status": license_status(o), "plan": o.plan.name if o.plan else None,
            "users": users.get(o.id, 0), "issues_30_days": issues_30.get(o.id, 0), "last_activity": dt(seen),
            "days_left": (o.valid_until.date() - now.date()).days if o.valid_until else None,
            "idle_days": (now - seen).days if seen else None,
        }

    cold = [
        o for o in orgs
        if license_status(o) == "trial" and o.id not in requested and (not seen_within(o, 4) or (o.valid_until - now).days <= 3)
    ]
    at_risk = [o for o in orgs if license_status(o) == "active" and o.valid_until is not None and not seen_within(o, 14)]
    return {
        "weeks": weeks,
        "active_7_days": sum(1 for o in orgs if seen_within(o, 7)),
        "active_30_days": sum(1 for o in orgs if seen_within(o, 30)),
        "workspaces": len(orgs),
        "trials_finished": len(finished_trials),
        "trials_converted": len(converted),
        "conversion_rate": round(len(converted) * 100 / len(finished_trials)) if finished_trials else None,
        "cold_trials": [row(o) for o in sorted(cold, key=lambda o: o.valid_until or now)][:20],
        "paying_but_quiet": [row(o) for o in at_risk][:20],
        "most_active": sorted((row(o) for o in orgs), key=lambda r: -r["issues_30_days"])[:10],
    }
