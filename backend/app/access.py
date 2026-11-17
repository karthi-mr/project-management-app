"""Role-based access: global roles and per-project member permissions.

Global roles (users.role)
    admin    – everything, including user management and every project
    manager  – can create projects (and owns the ones they create)
    member   – works only in projects they have been added to

Project roles (project_members.role)
    owner        – the creator; full control of the project (implicit, not stored)
    manager      – like a contributor, and can sign off stages and approve requests
    contributor  – can create and change work in the sections they may see
    tester       – like a contributor; the role tells the team who verifies the work
    viewer       – read-only in the sections they may see

project_members.sections is "all" or a comma separated list of the sections a member may see.
"""
from contextvars import ContextVar

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Project, User, project_members

SECTIONS = ["features", "issues", "milestones", "releases", "risks", "docs", "reports", "activity"]
PROJECT_ROLES = ("manager", "contributor", "tester", "viewer")
GLOBAL_ROLES = ("admin", "manager", "member")

# Set per request by middleware so write access can be inferred from the HTTP method.
request_method: ContextVar[str] = ContextVar("request_method", default="GET")
request_path: ContextVar[str] = ContextVar("request_path", default="")
request_ip: ContextVar[str] = ContextVar("request_ip", default="")
request_agent: ContextVar[str] = ContextVar("request_agent", default="")


def is_write_request() -> bool:
    return request_method.get() in ("POST", "PUT", "PATCH", "DELETE")


def parse_sections(raw: str | None) -> set[str]:
    if not raw or raw == "all":
        return set(SECTIONS)
    return {s for s in raw.split(",") if s in SECTIONS}


def pack_sections(sections: list[str] | None) -> str:
    if sections is None:
        return "all"
    chosen = [s for s in SECTIONS if s in set(sections)]
    return "all" if len(chosen) == len(SECTIONS) else ",".join(chosen)


def member_rows(db: Session, project_id: int) -> dict[int, dict]:
    rows = db.execute(
        select(project_members.c.user_id, project_members.c.role, project_members.c.sections).where(
            project_members.c.project_id == project_id
        )
    ).all()
    return {r.user_id: {"role": r.role, "sections": parse_sections(r.sections)} for r in rows}


def access(db: Session, project: Project, user: User) -> dict | None:
    """What this user may do in this project, or None when they cannot see it at all."""
    if project.org_id != user.org_id:
        return None  # another workspace's project
    if user.role == "admin":
        # Administrators manage everything, but sign-offs belong to the project's owner and managers.
        role = db.scalar(
            select(project_members.c.role).where(
                project_members.c.project_id == project.id, project_members.c.user_id == user.id
            )
        )
        approves = project.owner_id == user.id or role == "manager"
        return {"role": "admin", "can_manage": True, "can_edit": True, "can_approve": approves, "sections": set(SECTIONS)}
    if project.owner_id == user.id:
        return {"role": "owner", "can_manage": True, "can_edit": True, "can_approve": True, "sections": set(SECTIONS)}
    row = db.execute(
        select(project_members.c.role, project_members.c.sections).where(
            project_members.c.project_id == project.id, project_members.c.user_id == user.id
        )
    ).first()
    if not row:
        return None
    return {
        "role": row.role if row.role in PROJECT_ROLES else "contributor",
        "can_manage": False,
        "can_edit": row.role != "viewer",
        "can_approve": row.role == "manager",
        "sections": parse_sections(row.sections),
    }


def section_filter(db: Session, user: User):
    """Return allowed(project, section) -> bool, memoised for one request."""
    cache: dict[int, set[str]] = {}

    def allowed(project: Project, section: str) -> bool:
        if project.id not in cache:
            acc = access(db, project, user)
            cache[project.id] = acc["sections"] if acc else set()
        return section in cache[project.id]

    return allowed
