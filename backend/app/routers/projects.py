import json
import re
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, insert, or_, select, update
from sqlalchemy.orm import Session

from ..access import (
    PROJECT_ROLES,
    SECTIONS,
    access,
    is_write_request,
    member_rows,
    pack_sections,
    section_filter,
)
from ..audit import audit
from ..database import get_db
from ..trash import soft_delete
from ..models import (
    Activity,
    Milestone,
    Notification,
    Project,
    ProjectTemplate,
    User,
    project_members,
)
from ..saas import check_project_available, get_org
from ..templates import DEFAULT_PHASE_CHECKS, add_phase_checks, apply_template
from ..security import get_current_user
from .. import signoff as signoff_module
from ..serializers import activity_out, milestone_out, project_out, user_brief

router = APIRouter(prefix="/api", tags=["projects"])

ProjectStatus = Literal["planning", "active", "on_hold", "completed", "archived"]
ProjectPhase = Literal["planning", "design", "development", "testing", "deployment", "live"]
COLOR = r"^#[0-9a-fA-F]{6}$"


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    key: str = Field(min_length=2, max_length=10)
    description: str = Field(default="", max_length=5000)
    status: ProjectStatus = "active"
    phase: ProjectPhase = "planning"
    color: str = Field(default="#6366f1", pattern=COLOR)
    start_date: date | None = None
    due_date: date | None = None
    member_ids: list[int] = []
    template_id: int | None = None
    signoff_mode: Literal["off", "simple", "strict"] = "simple"


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=5000)
    status: ProjectStatus | None = None
    phase: ProjectPhase | None = None
    logo_url: str | None = Field(default=None, max_length=200)
    signoff_required: bool | None = None  # older clients: True = strict, False = off
    signoff_mode: Literal["off", "simple", "strict"] | None = None
    signoff_remind_days: int | None = Field(default=None, ge=1, le=60)
    signoff_escalate_days: int | None = Field(default=None, ge=1, le=120)
    budget: float | None = Field(default=None, ge=0, le=1e12)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    color: str | None = Field(default=None, pattern=COLOR)
    start_date: date | None = None
    due_date: date | None = None


class MemberIn(BaseModel):
    user_id: int
    role: Literal["manager", "contributor", "tester", "viewer"] = "contributor"
    sections: list[str] | None = None  # None = every section


class MemberUpdate(BaseModel):
    role: Literal["manager", "contributor", "tester", "viewer"] | None = None
    sections: list[str] | None = None


class OwnerIn(BaseModel):
    user_id: int


class MilestoneCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    start_date: date | None = None
    due_date: date | None = None


class MilestoneUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    start_date: date | None = None
    due_date: date | None = None
    status: Literal["open", "closed"] | None = None
    stage: Literal["planned", "design", "development", "testing", "deployment", "completed"] | None = None


def visible_projects_query(user: User):
    stmt = select(Project)
    if user.role != "admin":
        stmt = stmt.where(
            or_(
                Project.owner_id == user.id,
                Project.id.in_(
                    select(project_members.c.project_id).where(
                        project_members.c.user_id == user.id
                    )
                ),
            )
        )
    return stmt


def acc_manage_budget(project: Project, user: User) -> bool:
    return user.role == "admin" or project.owner_id == user.id


def can_manage(project: Project, user: User) -> bool:
    return user.role == "admin" or project.owner_id == user.id


def get_project(
    db: Session,
    project_id: int,
    user: User,
    manage: bool = False,
    section: str | None = None,
    write: bool | None = None,
) -> Project:
    """Load a project and enforce the caller's permissions.

    section – the part of the project being touched; members only reach sections granted to them.
    write   – whether this changes data. Left as None it is inferred from the HTTP method, so
              every POST/PATCH/DELETE endpoint is read-only for viewers without extra code.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    acc = access(db, project, user)
    if acc is None:
        raise HTTPException(404, "Project not found")
    if manage and not acc["can_manage"]:
        raise HTTPException(403, "Only the project owner or an administrator can do this")
    if section and section not in acc["sections"]:
        raise HTTPException(403, "You do not have access to this part of the project")
    if (is_write_request() if write is None else write) and not acc["can_edit"]:
        raise HTTPException(403, "You have read-only access to this project")
    return project


def log_activity(db: Session, project_id: int, user: User, message: str, issue_id: int | None = None):
    db.add(
        Activity(project_id=project_id, user_id=user.id, issue_id=issue_id, message=message[:500])
    )


def notify(
    db: Session,
    recipient_id: int | None,
    actor: User,
    message: str,
    project_id: int | None = None,
    issue_id: int | None = None,
    feature_id: int | None = None,
):
    """Queue a notification for another user (never for the person who did the action)."""
    if recipient_id is None or recipient_id == actor.id:
        return
    # Tell the recipient's open browser tabs once this is committed (see main.py).
    db.info.setdefault("notify_users", set()).add(recipient_id)
    db.add(
        Notification(
            user_id=recipient_id,
            message=f"{actor.full_name} {message}"[:500],
            project_id=project_id,
            issue_id=issue_id,
            feature_id=feature_id,
        )
    )


def _out(db: Session, project: Project, user: User) -> dict:
    acc = access(db, project, user) or {"role": None, "can_manage": False, "can_edit": False, "can_approve": False, "sections": set()}
    from .. import signoff
    rows = member_rows(db, project.id)
    members = []
    for m in project.members:
        row = rows.get(m.id, {"role": "contributor", "sections": set(SECTIONS)})
        is_owner = project.owner_id == m.id
        members.append({
            **user_brief(m),
            "role": "owner" if is_owner else row["role"],
            "sections": SECTIONS if is_owner else [s for s in SECTIONS if s in row["sections"]],
        })
    members.sort(key=lambda m: (m["role"] != "owner", m["full_name"].lower()))
    return {
        **project_out(project),
        "members": members,
        "my_role": acc["role"],
        "can_manage": acc["can_manage"],
        "can_edit": acc["can_edit"],
        "can_approve": acc["can_approve"],
        "signoff_required": bool(project.signoff_required),
        "signoff_mode": signoff.mode(project),
        "signoff_remind_days": project.signoff_remind_days or 2,
        "signoff_escalate_days": project.signoff_escalate_days or 5,
        "signoff_gated": signoff.gated(db, project),
        "approver_ids": [a.id for a in signoff.approvers(db, project)],
        "sections": [s for s in SECTIONS if s in acc["sections"]],
    }


def _set_member(db: Session, project_id: int, user_id: int, role: str | None, sections: list[str] | None, set_sections: bool):
    values = {}
    if role is not None:
        values["role"] = role
    if set_sections:
        if sections is not None and any(s not in SECTIONS for s in sections):
            raise HTTPException(422, "Unknown section")
        values["sections"] = pack_sections(sections)
    if values:
        db.execute(
            update(project_members)
            .where(project_members.c.project_id == project_id, project_members.c.user_id == user_id)
            .values(**values)
        )


@router.get("/projects")
def list_projects(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    projects = db.scalars(visible_projects_query(user).order_by(Project.name)).all()
    return [_out(db, p, user) for p in projects]


@router.get("/roadmap")
def roadmap(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every visible project with its milestones, for the portfolio timeline."""
    projects = db.scalars(visible_projects_query(user).order_by(Project.name)).all()
    allowed = section_filter(db, user)
    return [
        {
            **_out(db, p, user),
            "milestones": [
                milestone_out(m)
                for m in sorted(p.milestones, key=lambda m: (m.due_date or date.max, m.id))
            ]
            if allowed(p, "milestones")
            else [],
        }
        for p in projects
        if p.status != "archived"
    ]


@router.post("/projects", status_code=201)
def create_project(
    data: ProjectCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    if user.role not in ("admin", "manager"):
        raise HTTPException(403, "Only administrators and managers can create projects")
    key = data.key.strip().upper()
    if not re.fullmatch(r"[A-Z][A-Z0-9]{1,9}", key):
        raise HTTPException(422, "Key must be 2-10 letters or digits and start with a letter")
    clash = db.scalar(select(Project).where(Project.key == key).execution_options(include_deleted=True))
    if clash:
        where = " by a project in the recycle bin" if clash.deleted_at else ""
        raise HTTPException(409, f"Project key {key} is already in use{where}")
    if data.start_date and data.due_date and data.due_date < data.start_date:
        raise HTTPException(422, "Due date cannot be before the start date")

    check_project_available(db, get_org(db, user))
    if data.signoff_mode == "strict":
        from ..saas import require_feature

        require_feature(db, user, "approvals_advanced")
    project = Project(
        org_id=user.org_id,
        name=data.name.strip(),
        key=key,
        description=data.description,
        status=data.status,
        phase=data.phase,
        color=data.color,
        start_date=data.start_date,
        due_date=data.due_date,
        owner_id=user.id,
        signoff_mode=data.signoff_mode,
        signoff_required=data.signoff_mode != "off",
    )
    member_ids = set(data.member_ids) | {user.id}
    project.members = list(
        db.scalars(select(User).where(User.id.in_(member_ids), User.is_active)).all()
    )
    template = None
    if data.template_id is not None:
        template = db.get(ProjectTemplate, data.template_id)
        if not template or template.org_id not in (None, user.org_id):
            raise HTTPException(404, "Template not found")
    db.add(project)
    db.flush()
    if template:
        apply_template(db, project, json.loads(template.data), user)
    else:
        add_phase_checks(db, project, DEFAULT_PHASE_CHECKS)
    log_activity(db, project.id, user, f"created project {project.name}")
    for member in project.members:
        notify(db, member.id, user, f"added you to the project {project.name}", project.id)
    db.commit()
    return _out(db, project, user)


@router.get("/projects/{project_id}")
def read_project(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return _out(db, get_project(db, project_id, user), user)


@router.patch("/projects/{project_id}")
def update_project(
    project_id: int,
    data: ProjectUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, manage=True)
    fields = data.model_dump(exclude_unset=True)
    if "budget" in fields and not acc_manage_budget(project, user):
        raise HTTPException(403, "Only the project owner or an administrator can set the budget")
    if fields.get("budget") is not None:
        from ..saas import require_feature

        require_feature(db, user, "budgets")
    for name in ("name", "description", "status", "phase", "color", "currency", "signoff_required", "signoff_mode", "signoff_remind_days", "signoff_escalate_days"):
        if fields.get(name) is None:
            fields.pop(name, None)
    if fields.get("logo_url") and not fields["logo_url"].startswith("/api/files/"):
        raise HTTPException(422, "Upload the logo first")
    if fields.get("phase") and fields["phase"] != project.phase:
        log_activity(db, project.id, user, f"moved the project to the {fields['phase']} phase")
    if fields.get("status") and fields["status"] != project.status:
        log_activity(db, project.id, user, f"changed project status to {fields['status'].replace('_', ' ')}")
    # Strict request-and-approve, reminders and escalation come with Approvals Pro.
    advanced = (fields.get("signoff_mode") == "strict" and signoff_module.mode(project) != "strict") or (
        fields.get("signoff_required") and signoff_module.mode(project) == "off") or any(
        name in fields for name in ("signoff_remind_days", "signoff_escalate_days"))
    if advanced:
        from ..saas import require_feature

        require_feature(db, user, "approvals_advanced")
    # The mode and the older on/off flag always agree.
    if "signoff_mode" in fields:
        fields["signoff_required"] = fields["signoff_mode"] != "off"
    elif "signoff_required" in fields:
        fields["signoff_mode"] = "strict" if fields["signoff_required"] else "off"
    if "signoff_mode" in fields and fields["signoff_mode"] != signoff_module.mode(project):
        log_activity(db, project.id, user, f"set stage sign-off to {fields['signoff_mode']}")
    for name, value in fields.items():
        setattr(project, name, value.strip() if name == "name" else value)
    if project.start_date and project.due_date and project.due_date < project.start_date:
        raise HTTPException(422, "Due date cannot be before the start date")
    db.commit()
    return _out(db, project, user)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(
    project_id: int,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, manage=True)
    audit(db, user, "project.deleted", f"{project.key} {project.name}", request)
    soft_delete(project, user)  # recoverable from the recycle bin for 30 days
    db.commit()


@router.post("/projects/{project_id}/members")
def add_member(
    project_id: int,
    data: MemberIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, manage=True)
    member = db.get(User, data.user_id)
    if not member or not member.is_active:
        raise HTTPException(404, "User not found")
    if all(m.id != member.id for m in project.members):
        project.members.append(member)
        db.flush()
        log_activity(db, project.id, user, f"added {member.full_name} to the project as {data.role}")
        notify(db, member.id, user, f"added you to the project {project.name}", project.id)
    _set_member(db, project.id, member.id, data.role, data.sections, True)
    db.commit()
    return _out(db, project, user)


@router.patch("/projects/{project_id}/members/{user_id}")
def update_member(
    project_id: int,
    user_id: int,
    data: MemberUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change a member's project role and the sections they may see."""
    project = get_project(db, project_id, user, manage=True)
    if project.owner_id == user_id:
        raise HTTPException(400, "The project owner always has full access")
    member = next((m for m in project.members if m.id == user_id), None)
    if not member:
        raise HTTPException(404, "That user is not a member of this project")
    fields = data.model_dump(exclude_unset=True)
    _set_member(db, project.id, user_id, fields.get("role"), fields.get("sections"), "sections" in fields)
    log_activity(db, project.id, user, f"changed {member.full_name}'s access to the project")
    db.commit()
    return _out(db, project, user)


@router.post("/projects/{project_id}/owner")
def transfer_ownership(
    project_id: int,
    data: OwnerIn,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, manage=True)
    new_owner = db.get(User, data.user_id)
    if not new_owner or not new_owner.is_active:
        raise HTTPException(404, "User not found")
    if all(m.id != new_owner.id for m in project.members):
        project.members.append(new_owner)
        db.flush()
    project.owner_id = new_owner.id
    _set_member(db, project.id, new_owner.id, "contributor", None, True)
    log_activity(db, project.id, user, f"made {new_owner.full_name} the project owner")
    notify(db, new_owner.id, user, f"made you the owner of {project.name}", project.id)
    audit(db, user, "project.owner_changed", f"{project.key} → {new_owner.username}", request)
    db.commit()
    return _out(db, project, user)


@router.delete("/projects/{project_id}/members/{user_id}")
def remove_member(
    project_id: int,
    user_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, manage=True)
    if project.owner_id == user_id:
        raise HTTPException(400, "The project owner cannot be removed")
    member = next((m for m in project.members if m.id == user_id), None)
    if member:
        project.members.remove(member)
        for issue in project.issues:
            if issue.assignee_id == user_id:
                issue.assignee_id = None
        log_activity(db, project.id, user, f"removed {member.full_name} from the project")
        db.commit()
    return _out(db, project, user)


@router.get("/projects/{project_id}/activity")
def project_activity(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    project = get_project(db, project_id, user, section="activity")
    rows = db.scalars(
        select(Activity)
        .where(Activity.project_id == project.id)
        .order_by(Activity.created_at.desc(), Activity.id.desc())
        .limit(100)
    ).all()
    return [activity_out(a) for a in rows]


@router.get("/projects/{project_id}/milestones")
def list_milestones(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    project = get_project(db, project_id, user, section="milestones")
    ordered = sorted(
        project.milestones, key=lambda m: (m.status == "closed", m.due_date or date.max, m.id)
    )
    return [milestone_out(m) for m in ordered]


@router.post("/projects/{project_id}/milestones", status_code=201)
def create_milestone(
    project_id: int,
    data: MilestoneCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, section="milestones")
    milestone = Milestone(
        project_id=project.id,
        name=data.name.strip(),
        description=data.description,
        start_date=data.start_date,
        due_date=data.due_date,
    )
    _check_dates(milestone.start_date, milestone.due_date)
    db.add(milestone)
    log_activity(db, project.id, user, f"created milestone {milestone.name}")
    db.commit()
    return milestone_out(milestone)


def _check_dates(start: date | None, due: date | None):
    if start and due and due < start:
        raise HTTPException(422, "Due date cannot be before the start date")


def _get_milestone(db: Session, milestone_id: int, user: User) -> Milestone:
    milestone = db.get(Milestone, milestone_id)
    if not milestone:
        raise HTTPException(404, "Milestone not found")
    get_project(db, milestone.project_id, user, section="milestones")
    return milestone


@router.patch("/milestones/{milestone_id}")
def update_milestone(
    milestone_id: int,
    data: MilestoneUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    milestone = _get_milestone(db, milestone_id, user)
    fields = data.model_dump(exclude_unset=True)
    for name in ("name", "description", "status", "stage"):
        if fields.get(name) is None:
            fields.pop(name, None)
    from .. import signoff

    # Closing or reopening is a stage change: the lifecycle rules decide whether it is allowed.
    status = fields.pop("status", None)
    stage = fields.pop("stage", None)
    if stage is None and status and status != milestone.status:
        stage = "completed" if status == "closed" else "deployment"
    if stage and stage != milestone.stage:
        signoff.change_stage(db, milestone.project, user, "milestone", milestone, stage)
    for name, value in fields.items():
        setattr(milestone, name, value)
    _check_dates(milestone.start_date, milestone.due_date)
    db.commit()
    return milestone_out(milestone)


@router.delete("/milestones/{milestone_id}", status_code=204)
def delete_milestone(
    milestone_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    milestone = _get_milestone(db, milestone_id, user)
    log_activity(db, milestone.project_id, user, f"deleted milestone {milestone.name}")
    soft_delete(milestone, user)  # recoverable from the recycle bin for 30 days
    db.commit()
