"""Sprints, issue templates, watchers, approvals, automation rules, budgets, workload,
portfolio and the recycle bin."""
import json
from collections import defaultdict
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .. import automation, signoff
from ..access import access, section_filter
from ..audit import audit
from ..database import get_db
from ..models import (
    Milestone,
    Approval,
    AutomationRule,
    Feature,
    Issue,
    IssueTemplate,
    Project,
    Release,
    Risk,
    Sprint,
    TimeEntry,
    User,
    Watch,
    project_members,
    utcnow,
)
from ..saas import has_feature, require_feature
from ..security import get_current_user, require_admin
from ..serializers import dt, issue_out, user_brief
from ..trash import KIND_OF, KINDS, RETENTION_DAYS, deleted_rows, get_deleted
from .projects import can_manage, get_project, log_activity, notify, visible_projects_query

router = APIRouter(prefix="/api", tags=["delivery"])

PHASES = ["planning", "design", "development", "testing", "deployment", "live"]


# ═════════════ Sprints ═════════════


class SprintIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    goal: str = Field(default="", max_length=2000)
    start_date: date | None = None
    end_date: date | None = None


class SprintUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    goal: str | None = Field(default=None, max_length=2000)
    start_date: date | None = None
    end_date: date | None = None


class SprintComplete(BaseModel):
    move_to: int | None = None  # another sprint for unfinished issues; None = back to the backlog


def sprint_out(s: Sprint) -> dict:
    issues = s.issues
    done = [i for i in issues if i.status == "done"]
    summary = json.loads(s.summary) if s.summary else None
    return {
        "id": s.id,
        "project_id": s.project_id,
        "name": s.name,
        "goal": s.goal,
        "start_date": s.start_date.isoformat() if s.start_date else None,
        "end_date": s.end_date.isoformat() if s.end_date else None,
        "status": s.status,
        "completed_at": dt(s.completed_at),
        "issue_count": len(issues),
        "done_count": len(done),
        "estimate_hours": round(sum(i.estimate_hours or 0 for i in issues), 2),
        "done_hours": round(sum(i.estimate_hours or 0 for i in done), 2),
        "progress": round(len(done) * 100 / len(issues)) if issues else 0,
        "summary": summary,
    }


def _check_sprint_dates(start: date | None, end: date | None):
    if start and end and end < start:
        raise HTTPException(422, "The sprint cannot end before it starts")


def _get_sprint(db: Session, sprint_id: int, user: User, write: bool | None = None) -> Sprint:
    sprint = db.get(Sprint, sprint_id)
    if not sprint:
        raise HTTPException(404, "Sprint not found")
    get_project(db, sprint.project_id, user, section="issues", write=write)
    return sprint


@router.get("/projects/{project_id}/sprints")
def list_sprints(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_project(db, project_id, user, section="issues")
    order = {"active": 0, "planned": 1, "completed": 2}
    sprints = db.scalars(select(Sprint).where(Sprint.project_id == project_id)).all()
    sprints = sorted(sprints, key=lambda s: (order.get(s.status, 3), (s.start_date or date.max) if s.status != "completed" else date.max - (s.end_date or date.min), s.id))
    return [sprint_out(s) for s in sprints]


@router.post("/projects/{project_id}/sprints", status_code=201)
def create_sprint(project_id: int, data: SprintIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = get_project(db, project_id, user, section="issues")
    require_feature(db, user, "sprints")
    _check_sprint_dates(data.start_date, data.end_date)
    sprint = Sprint(project_id=project.id, name=data.name.strip(), goal=data.goal, start_date=data.start_date, end_date=data.end_date)
    db.add(sprint)
    log_activity(db, project.id, user, f"planned sprint “{sprint.name}”")
    db.commit()
    return sprint_out(sprint)


@router.patch("/sprints/{sprint_id}")
def update_sprint(sprint_id: int, data: SprintUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sprint = _get_sprint(db, sprint_id, user)
    fields = data.model_dump(exclude_unset=True)
    for name in ("name", "goal"):
        if name in fields and fields[name] is None:
            del fields[name]
    for name, value in fields.items():
        setattr(sprint, name, value.strip() if name == "name" else value)
    _check_sprint_dates(sprint.start_date, sprint.end_date)
    db.commit()
    return sprint_out(sprint)


@router.post("/sprints/{sprint_id}/start")
def start_sprint(sprint_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sprint = _get_sprint(db, sprint_id, user)
    require_feature(db, user, "sprints")
    if sprint.status != "planned":
        raise HTTPException(400, "Only a planned sprint can be started")
    active = db.scalar(select(Sprint).where(Sprint.project_id == sprint.project_id, Sprint.status == "active"))
    if active:
        raise HTTPException(409, f"“{active.name}” is still running. Complete it before starting another sprint.")
    sprint.status = "active"
    sprint.start_date = sprint.start_date or date.today()
    if not sprint.end_date or sprint.end_date < sprint.start_date:
        sprint.end_date = sprint.start_date + timedelta(days=13)
    log_activity(db, sprint.project_id, user, f"started sprint “{sprint.name}” with {len(sprint.issues)} issue(s)")
    db.commit()
    return sprint_out(sprint)


@router.post("/sprints/{sprint_id}/complete")
def complete_sprint(sprint_id: int, data: SprintComplete, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sprint = _get_sprint(db, sprint_id, user)
    if sprint.status != "active":
        raise HTTPException(400, "Only the running sprint can be completed")
    target = None
    if data.move_to is not None:
        target = db.get(Sprint, data.move_to)
        if not target or target.project_id != sprint.project_id or target.status == "completed" or target.id == sprint.id:
            raise HTTPException(422, "Choose a planned sprint of this project")
    issues = list(sprint.issues)
    done = [i for i in issues if i.status == "done"]
    unfinished = [i for i in issues if i.status != "done"]
    sprint.summary = json.dumps({
        "committed": len(issues),
        "completed": len(done),
        "carried_over": len(unfinished),
        "completed_hours": round(sum(i.estimate_hours or 0 for i in done), 2),
    })
    for issue in unfinished:
        issue.sprint_id = target.id if target else None
    sprint.status = "completed"
    sprint.completed_at = utcnow()
    log_activity(
        db, sprint.project_id, user,
        f"completed sprint “{sprint.name}”: {len(done)} done, {len(unfinished)} moved to {target.name if target else 'the backlog'}",
    )
    db.commit()
    return sprint_out(sprint)


@router.delete("/sprints/{sprint_id}", status_code=204)
def delete_sprint(sprint_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sprint = _get_sprint(db, sprint_id, user)
    if sprint.status == "active":
        raise HTTPException(400, "Complete the sprint before deleting it")
    for issue in sprint.issues:
        issue.sprint_id = None
    log_activity(db, sprint.project_id, user, f"deleted sprint “{sprint.name}”")
    db.delete(sprint)
    db.commit()


# ═════════════ Issue templates ═════════════


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    title: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=20000)
    type: Literal["task", "bug", "story", "epic"] = "task"
    priority: Literal["low", "medium", "high", "urgent"] = "medium"
    labels: list[str] = Field(default=[], max_length=9)
    checklist: list[str] = Field(default=[], max_length=30)


def template_out(t: IssueTemplate) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "title": t.title,
        "description": t.description,
        "type": t.type,
        "priority": t.priority,
        "labels": [l for l in t.labels.split(",") if l],
        "checklist": json.loads(t.checklist) if t.checklist else [],
    }


def _template_fields(data: TemplateIn) -> dict:
    labels = []
    for raw in data.labels:
        label = raw.replace(",", " ").strip().lower()[:30]
        if label and label not in labels:
            labels.append(label)
    return {
        "name": data.name.strip(),
        "title": data.title.lstrip(),  # keep a trailing space, e.g. "Bug: "
        "description": data.description,
        "type": data.type,
        "priority": data.priority,
        "labels": ",".join(labels),
        "checklist": json.dumps([c.strip()[:300] for c in data.checklist if c.strip()]),
    }


DEFAULT_TEMPLATES = [
    TemplateIn(
        name="Bug report", title="Bug: ", type="bug", priority="high", labels=["bug"],
        description="## What happened\n\n## What should have happened\n\n## Steps to reproduce\n1. \n2. \n\n## Environment\n- Browser / device:\n- Version:\n",
        checklist=["Reproduced", "Root cause found", "Fix verified", "Regression test added"],
    ),
    TemplateIn(
        name="Feature request", title="", type="story", priority="medium", labels=["enhancement"],
        description="## Problem\nWho needs this, and why?\n\n## Proposed solution\n\n## Acceptance criteria\n- [ ] \n- [ ] \n",
        checklist=["Design reviewed", "Implemented", "Tested", "Documented"],
    ),
]


@router.get("/projects/{project_id}/issue-templates")
def list_issue_templates(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_project(db, project_id, user, section="issues", write=False)
    rows = db.scalars(select(IssueTemplate).where(IssueTemplate.project_id == project_id).order_by(IssueTemplate.name)).all()
    return [template_out(t) for t in rows]


@router.post("/projects/{project_id}/issue-templates", status_code=201)
def create_issue_template(project_id: int, data: TemplateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = get_project(db, project_id, user, manage=True)
    require_feature(db, user, "customization")
    template = IssueTemplate(project_id=project.id, **_template_fields(data))
    db.add(template)
    db.commit()
    return template_out(template)


@router.post("/projects/{project_id}/issue-templates/defaults")
def add_default_templates(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = get_project(db, project_id, user, manage=True)
    require_feature(db, user, "customization")
    existing = {t.lower() for t in db.scalars(select(IssueTemplate.name).where(IssueTemplate.project_id == project.id))}
    for data in DEFAULT_TEMPLATES:
        if data.name.lower() not in existing:
            db.add(IssueTemplate(project_id=project.id, **_template_fields(data)))
    db.commit()
    return list_issue_templates(project_id, user, db)


def _get_template(db: Session, template_id: int, user: User) -> IssueTemplate:
    template = db.get(IssueTemplate, template_id)
    if not template:
        raise HTTPException(404, "Template not found")
    get_project(db, template.project_id, user, manage=True)
    return template


@router.put("/issue-templates/{template_id}")
def update_issue_template(template_id: int, data: TemplateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    template = _get_template(db, template_id, user)
    for name, value in _template_fields(data).items():
        setattr(template, name, value)
    db.commit()
    return template_out(template)


@router.delete("/issue-templates/{template_id}", status_code=204)
def delete_issue_template(template_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.delete(_get_template(db, template_id, user))
    db.commit()


# ═════════════ Watchers ═════════════


def watch(db: Session, user_id: int | None, issue_id: int | None = None, feature_id: int | None = None) -> None:
    """Start watching unless already watching (safe to call repeatedly)."""
    if not user_id:
        return
    column, value = (Watch.issue_id, issue_id) if issue_id else (Watch.feature_id, feature_id)
    if db.scalar(select(Watch.id).where(Watch.user_id == user_id, column == value)):
        return
    pending = db.info.setdefault("pending_watches", set())
    if (user_id, issue_id, feature_id) in pending:
        return
    pending.add((user_id, issue_id, feature_id))
    db.add(Watch(user_id=user_id, issue_id=issue_id, feature_id=feature_id))


def watcher_ids(db: Session, issue_id: int | None = None, feature_id: int | None = None) -> list[int]:
    column, value = (Watch.issue_id, issue_id) if issue_id else (Watch.feature_id, feature_id)
    return list(db.scalars(select(Watch.user_id).where(column == value)))


def notify_watchers(db: Session, actor: User, message: str, project_id: int, issue_id=None, feature_id=None, skip=()):
    for user_id in set(watcher_ids(db, issue_id, feature_id)) - set(skip) - {actor.id}:
        notify(db, user_id, actor, message, project_id, issue_id=issue_id, feature_id=feature_id)


def _watch_target(db: Session, kind: str, item_id: int, user: User):
    if kind == "issue":
        issue = db.get(Issue, item_id)
        if not issue:
            raise HTTPException(404, "Issue not found")
        get_project(db, issue.project_id, user, section="issues", write=False)
        return {"issue_id": issue.id}
    if kind == "feature":
        feature = db.get(Feature, item_id)
        if not feature:
            raise HTTPException(404, "Feature not found")
        get_project(db, feature.project_id, user, section="features", write=False)
        return {"feature_id": feature.id}
    raise HTTPException(404, "Not found")


def watch_state(db: Session, user: User, issue_id=None, feature_id=None) -> dict:
    ids = watcher_ids(db, issue_id, feature_id)
    users = db.scalars(select(User).where(User.id.in_(ids or [0]))).all()
    return {"watching": user.id in ids, "watchers": [user_brief(u) for u in users]}


@router.get("/{kind}s/{item_id}/watchers")
def get_watchers(kind: Literal["issue", "feature"], item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return watch_state(db, user, **_watch_target(db, kind, item_id, user))


@router.post("/{kind}s/{item_id}/watch")
def start_watching(kind: Literal["issue", "feature"], item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    target = _watch_target(db, kind, item_id, user)
    watch(db, user.id, **target)
    db.commit()
    return watch_state(db, user, **target)


@router.delete("/{kind}s/{item_id}/watch")
def stop_watching(kind: Literal["issue", "feature"], item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    target = _watch_target(db, kind, item_id, user)
    column, value = (Watch.issue_id, target["issue_id"]) if "issue_id" in target else (Watch.feature_id, target["feature_id"])
    existing = db.scalar(select(Watch).where(Watch.user_id == user.id, column == value))
    if existing:
        db.delete(existing)
        db.commit()
    return watch_state(db, user, **target)


# ═════════════ Approvals ═════════════


class ApprovalIn(BaseModel):
    kind: Literal["feature", "release", "phase", "general"]
    target_id: int | None = None
    phase: Literal["planning", "design", "development", "testing", "deployment", "live"] | None = None
    title: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=5000)
    approver_id: int | None = None  # None = the owner or any manager may decide


class DecisionIn(BaseModel):
    decision: Literal["approved", "rejected"]
    note: str = Field(default="", max_length=5000)


KIND_LABELS = {
    "stage": "Stage sign-off", "phase": "Project phase", "feature": "Feature", "release": "Release go-live",
    "general": "Other approval",
}


def approval_out(a: Approval, can_decide: bool | None = None) -> dict:
    return {
        "kind_label": KIND_LABELS.get(a.kind, a.kind),
        "can_decide": can_decide,
        "id": a.id,
        "project_id": a.project_id,
        "project_name": a.project.name if a.project else None,
        "project_color": a.project.color if a.project else None,
        "kind": a.kind,
        "target_type": a.target_type,
        "stage": a.stage,
        "to_stage": a.to_stage,
        "target_id": a.target_id,
        "phase": a.phase,
        "title": a.title,
        "note": a.note,
        "requester": user_brief(a.requester),
        "approver": user_brief(a.approver),
        "status": a.status,
        "decision_note": a.decision_note,
        "created_at": dt(a.created_at),
        "decided_at": dt(a.decided_at),
    }


@router.get("/projects/{project_id}/approvals")
def list_approvals(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = get_project(db, project_id, user)
    rows = db.scalars(select(Approval).where(Approval.project_id == project_id).order_by(Approval.status != "pending", Approval.created_at.desc())).all()
    return [approval_out(a, signoff.may_decide(db, project, a, user)) for a in rows]


@router.get("/approvals/mine")
def my_approvals(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Requests waiting for my decision, and my own requests still open."""
    rows = db.scalars(
        select(Approval)
        .where(Approval.status == "pending")
        .order_by(Approval.created_at.desc())
    ).all()
    mine = []
    for a in rows:
        if a.project is None or a.project.org_id != user.org_id:
            continue
        can = signoff.may_decide(db, a.project, a, user)
        if can or a.requester_id == user.id:
            mine.append(approval_out(a, can))
    return mine


@router.post("/projects/{project_id}/approvals", status_code=201)
def request_approval(project_id: int, data: ApprovalIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = get_project(db, project_id, user)
    require_feature(db, user, "approvals")
    approver = None
    if data.approver_id is not None:
        approver = db.get(User, data.approver_id)
        if not approver or not approver.is_active or approver.id not in {a.id for a in signoff.approvers(db, project)}:
            raise HTTPException(422, "Approval requests go to the project owner or a project manager")
        if approver.id == user.id:
            raise HTTPException(422, "Ask someone else to approve")
    elif not [a for a in signoff.approvers(db, project) if a.id != user.id]:
        raise HTTPException(422, "There is nobody else who can approve. Add a manager to the project first.")
    title = data.title.strip()
    if data.kind == "feature":
        feature = db.get(Feature, data.target_id or 0)
        if not feature or feature.project_id != project.id:
            raise HTTPException(422, "Feature not found in this project")
        title = title or f"Approve feature “{feature.title}”"
    elif data.kind == "release":
        release = db.get(Release, data.target_id or 0)
        if not release or release.project_id != project.id:
            raise HTTPException(422, "Release not found in this project")
        title = title or f"Approve release {release.version} to {release.environment}"
    elif data.kind == "phase":
        if not data.phase:
            raise HTTPException(422, "Choose the phase to sign off")
        title = title or f"Sign off the {data.phase} phase"
    if not title:
        raise HTTPException(422, "Describe what needs approval")
    # The same thing cannot be asked for twice, and not again once it has been approved.
    same = select(Approval).where(Approval.project_id == project.id, Approval.kind == data.kind)
    if data.kind in ("feature", "release"):
        same = same.where(Approval.target_id == data.target_id, Approval.target_type.is_(None))
    elif data.kind == "phase":
        same = same.where(Approval.phase == data.phase)
    else:
        same = same.where(Approval.title == title[:200])
    previous = db.scalar(same.where(Approval.status.in_(("pending", "approved"))).order_by(Approval.id.desc()))
    if previous and previous.status == "pending":
        raise HTTPException(409, "This has already been requested and is waiting for a decision")
    if previous and data.kind != "general":
        who = f" by {previous.approver.full_name}" if previous.approver else ""
        raise HTTPException(409, f"This was already approved{who} on {previous.decided_at.date().isoformat()}")
    approval = Approval(
        project_id=project.id, kind=data.kind, target_id=data.target_id if data.kind in ("feature", "release") else None,
        phase=data.phase if data.kind == "phase" else None, title=title[:200], note=data.note,
        requester_id=user.id, approver_id=approver.id if approver else None,
    )
    db.add(approval)
    who = approver.full_name if approver else "the owner and managers"
    log_activity(db, project.id, user, f"asked {who} to approve: {approval.title}")
    for person in ([approver] if approver else signoff.approvers(db, project)):
        notify(db, person.id, user, f"asked you to approve: {approval.title}", project.id)
    db.commit()
    return approval_out(approval)


@router.post("/approvals/{approval_id}/decide")
def decide(approval_id: int, data: DecisionIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    approval = db.get(Approval, approval_id)
    if not approval or approval.project is None:
        raise HTTPException(404, "Approval not found")
    project = get_project(db, approval.project_id, user, write=False)
    if approval.status != "pending":
        raise HTTPException(400, "This request has already been decided")
    if approval.kind == "stage":
        signoff.decide(db, project, approval, user, data.decision, data.note.strip())
        db.commit()
        return approval_out(approval, False)
    # Every other kind follows the same rule as stage sign-offs.
    if not signoff.may_decide(db, project, approval, user):
        if approval.approver_id is not None:
            raise HTTPException(403, f"This request was sent to {approval.approver.full_name if approval.approver else 'someone else'}")
        if approval.requester_id == user.id and signoff.is_approver(db, project, user):
            raise HTTPException(403, "You asked for this, so the owner or another manager has to approve it")
        raise HTTPException(403, "Only the project owner or a project manager can decide")
    approval.approver_id = user.id
    approval.status = data.decision
    approval.decision_note = data.note.strip()
    approval.decided_at = utcnow()
    log_activity(db, approval.project_id, user, f"{data.decision} “{approval.title}”")
    notify(db, approval.requester_id, user, f"{data.decision} your request: {approval.title}", approval.project_id)
    db.commit()
    return approval_out(approval, False)


class SignoffIn(BaseModel):
    target_type: Literal["feature", "module", "milestone"]
    target_id: int
    note: str = Field(default="", max_length=5000)
    approver_id: int | None = None  # None = the owner and every manager; the first to answer decides
    approve: bool = False  # simple mode: an owner or manager signs off straight away


@router.post("/projects/{project_id}/signoffs", status_code=201)
def request_signoff(project_id: int, data: SignoffIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Ask for the current stage of a feature or milestone to be signed off, or sign it off."""
    project = get_project(db, project_id, user, section="milestones" if data.target_type == "milestone" else "features")
    require_feature(db, user, "approvals")
    from ..models import ProjectModule

    model = {"feature": Feature, "module": ProjectModule, "milestone": Milestone}[data.target_type]
    # Lock the row so two clicks at the same moment cannot both create a request.
    obj = db.get(model, data.target_id, with_for_update=True)
    if not obj or obj.project_id != project.id:
        raise HTTPException(404, "Not found in this project")
    if data.approve and not signoff.strict(project) and signoff.is_approver(db, project, user):
        approval = signoff.sign_off_now(db, project, user, data.target_type, obj, data.note.strip())
    else:
        approval = signoff.request(db, project, user, data.target_type, obj, data.note.strip(), data.approver_id)
    db.commit()
    return approval_out(approval)


@router.post("/approvals/{approval_id}/cancel")
def cancel_approval(approval_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    approval = db.get(Approval, approval_id)
    if not approval or approval.project is None:
        raise HTTPException(404, "Approval not found")
    project = get_project(db, approval.project_id, user, write=False)
    if approval.requester_id != user.id and not can_manage(project, user):
        raise HTTPException(403, "Only the requester or the project owner can cancel this")
    if approval.status != "pending":
        raise HTTPException(400, "This request has already been decided")
    approval.status = "cancelled"
    approval.decided_at = utcnow()
    db.commit()
    return approval_out(approval)


# ═════════════ Automation rules ═════════════


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    trigger: Literal["issue_created", "status_changed", "due_soon", "feature_done"]
    config: dict
    enabled: bool = True


def rule_out(r: AutomationRule) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "trigger": r.trigger,
        "config": automation.parse(r),
        "enabled": r.enabled,
        "runs": r.runs,
        "last_run_at": dt(r.last_run_at),
    }


@router.get("/projects/{project_id}/automations")
def list_rules(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_project(db, project_id, user, manage=True)
    return [rule_out(r) for r in db.scalars(select(AutomationRule).where(AutomationRule.project_id == project_id).order_by(AutomationRule.id))]


def _validated(project: Project, data: RuleIn) -> str:
    try:
        return json.dumps(automation.validate(project, data.trigger, data.config))
    except ValueError as err:
        raise HTTPException(422, str(err))


@router.post("/projects/{project_id}/automations", status_code=201)
def create_rule(project_id: int, data: RuleIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = get_project(db, project_id, user, manage=True)
    require_feature(db, user, "automation")
    if len(db.scalars(select(AutomationRule.id).where(AutomationRule.project_id == project.id)).all()) >= 30:
        raise HTTPException(422, "A project can have at most 30 rules")
    rule = AutomationRule(project_id=project.id, name=data.name.strip(), trigger=data.trigger, config=_validated(project, data), enabled=data.enabled, created_by_id=user.id)
    db.add(rule)
    log_activity(db, project.id, user, f"added automation rule “{rule.name}”")
    db.commit()
    return rule_out(rule)


def _get_rule(db: Session, rule_id: int, user: User) -> tuple[AutomationRule, Project]:
    rule = db.get(AutomationRule, rule_id)
    if not rule:
        raise HTTPException(404, "Rule not found")
    return rule, get_project(db, rule.project_id, user, manage=True)


@router.put("/automations/{rule_id}")
def update_rule(rule_id: int, data: RuleIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rule, project = _get_rule(db, rule_id, user)
    require_feature(db, user, "automation")
    rule.name, rule.trigger, rule.enabled = data.name.strip(), data.trigger, data.enabled
    rule.config = _validated(project, data)
    db.commit()
    return rule_out(rule)


@router.delete("/automations/{rule_id}", status_code=204)
def delete_rule(rule_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rule, _ = _get_rule(db, rule_id, user)
    db.delete(rule)
    db.commit()


# ═════════════ Budget and cost ═════════════


def entry_rate(entry: TimeEntry) -> float | None:
    """The rate stored when the time was logged; older entries use the person's current rate."""
    if entry.rate is not None:
        return entry.rate
    return entry.user.hourly_rate if entry.user else None


def time_entries_query(project_ids: list[int]):
    """Time logged in these projects: on their issues, or straight on their features."""
    return (
        select(TimeEntry)
        .outerjoin(Issue, TimeEntry.issue_id == Issue.id)
        .outerjoin(Feature, TimeEntry.feature_id == Feature.id)
        .where(or_(Issue.project_id.in_(project_ids or [0]), Feature.project_id.in_(project_ids or [0])))
    )


def entry_feature(entry: TimeEntry):
    """The feature a time entry counts towards: its own, or its issue's."""
    if entry.feature is not None:
        return entry.feature
    return entry.issue.feature if entry.issue is not None else None


def project_cost(db: Session, project: Project) -> dict:
    entries = db.scalars(time_entries_query([project.id])).all()
    hours = cost = unpriced = 0.0
    people: dict[int | None, dict] = {}
    features: dict[int | None, dict] = {}
    months: dict[str, dict] = defaultdict(lambda: {"hours": 0.0, "cost": 0.0})
    for e in entries:
        rate = entry_rate(e)
        hours += e.hours
        row = people.setdefault(e.user_id, {"user": user_brief(e.user), "hours": 0.0, "cost": 0.0, "unpriced_hours": 0.0})
        row["hours"] += e.hours
        month = months[e.day.strftime("%Y-%m")]
        month["hours"] += e.hours
        feature = entry_feature(e)
        frow = features.setdefault(feature.id if feature else None, {
            "feature": {"id": feature.id, "title": feature.title, "stage": feature.stage} if feature else None,
            "hours": 0.0, "direct_hours": 0.0, "cost": 0.0,
        })
        frow["hours"] += e.hours
        if e.feature_id:
            frow["direct_hours"] += e.hours
        if rate is None:
            unpriced += e.hours
            row["unpriced_hours"] += e.hours
        else:
            cost += e.hours * rate
            row["cost"] += e.hours * rate
            month["cost"] += e.hours * rate
            frow["cost"] += e.hours * rate
    budget = project.budget
    return {
        "budget": budget,
        "currency": project.currency or "USD",
        "hours": round(hours, 2),
        "cost": round(cost, 2),
        "unpriced_hours": round(unpriced, 2),
        "remaining": round(budget - cost, 2) if budget is not None else None,
        "used_percent": round(cost * 100 / budget) if budget else None,
        "people": sorted(
            ({**r, "hours": round(r["hours"], 2), "cost": round(r["cost"], 2), "unpriced_hours": round(r["unpriced_hours"], 2)} for r in people.values()),
            key=lambda r: -r["cost"],
        ),
        "months": [{"month": k, "hours": round(v["hours"], 2), "cost": round(v["cost"], 2)} for k, v in sorted(months.items())],
        # Where the money went, feature by feature (time on a feature's issues counts towards it);
        # "feature": null is work not linked to any feature.
        "features": sorted(
            ({**r, "hours": round(r["hours"], 2), "direct_hours": round(r["direct_hours"], 2), "cost": round(r["cost"], 2)} for r in features.values()),
            key=lambda r: (r["feature"] is None, -r["cost"], -r["hours"]),
        ),
    }


@router.get("/projects/{project_id}/budget")
def budget(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Cost figures reveal hourly rates, so only the project owner and administrators see them."""
    project = get_project(db, project_id, user, manage=True, write=False)
    require_feature(db, user, "budgets")
    return project_cost(db, project)


# ═════════════ Workload ═════════════


def _workdays(start: date, end: date) -> list[date]:
    days = [start + timedelta(days=n) for n in range((end - start).days + 1)]
    weekdays = [d for d in days if d.weekday() < 5]
    return weekdays or days


@router.get("/workload")
def workload(
    start: date | None = None,
    weeks: int = Query(default=6, ge=1, le=12),
    project_id: int | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Planned hours (remaining estimates spread over working days to the due date) and logged
    hours per person per week, against their weekly capacity."""
    require_feature(db, user, "workload")
    today = date.today()
    first = (start or today) - timedelta(days=(start or today).weekday())
    last = first + timedelta(days=7 * weeks - 1)
    allowed = section_filter(db, user)
    projects = [p for p in db.scalars(visible_projects_query(user)).all() if p.status != "archived" and allowed(p, "issues")]
    if project_id is not None:
        projects = [p for p in projects if p.id == project_id]
    project_ids = [p.id for p in projects]

    if user.role == "admin" and project_id is None:
        people = db.scalars(select(User).where(User.is_active).order_by(User.full_name)).all()
    else:
        member_ids = set(db.scalars(select(project_members.c.user_id).where(project_members.c.project_id.in_(project_ids or [0]))))
        member_ids |= {p.owner_id for p in projects if p.owner_id}
        people = db.scalars(select(User).where(User.id.in_(member_ids or [0]), User.is_active).order_by(User.full_name)).all()

    week_starts = [first + timedelta(days=7 * n) for n in range(weeks)]
    index = lambda d: (d - first).days // 7  # noqa: E731
    rows = {u.id: {"user": user_brief(u), "capacity": u.weekly_capacity or 40, "planned": [0.0] * weeks, "logged": [0.0] * weeks,
                   "unscheduled_hours": 0.0, "overdue_hours": 0.0, "open_issues": 0, "issues": []} for u in people}

    open_issues = db.scalars(
        select(Issue).where(Issue.project_id.in_(project_ids or [0]), Issue.status != "done", Issue.assignee_id.in_(list(rows) or [0]))
    ).all()
    for issue in open_issues:
        row = rows[issue.assignee_id]
        row["open_issues"] += 1
        remaining = max(0.0, (issue.estimate_hours or 0) - (issue.spent_hours or 0))
        row["issues"].append({
            "id": issue.id, "key": f"{issue.project.key}-{issue.number}", "title": issue.title,
            "due_date": issue.due_date.isoformat() if issue.due_date else None, "remaining": round(remaining, 2),
            "project_color": issue.project.color,
        })
        if not remaining:
            continue
        due = issue.due_date or (issue.sprint.end_date if getattr(issue, "sprint", None) and issue.sprint and issue.sprint.end_date else None)
        if not due:
            row["unscheduled_hours"] += remaining
            continue
        if due < today:
            row["overdue_hours"] += remaining
            # Overdue work still has to happen: count it in the current week.
            if first <= today <= last:
                row["planned"][index(today)] += remaining
            continue
        begin = max(issue.start_date or today, today)
        if begin > due:
            begin = due
        days = _workdays(begin, due)
        share = remaining / len(days)
        for d in days:
            if first <= d <= last:
                row["planned"][index(d)] += share

    entries = db.scalars(
        time_entries_query(project_ids).where(TimeEntry.day >= first, TimeEntry.day <= last, TimeEntry.user_id.in_(list(rows) or [0]))
    ).all()
    for e in entries:
        rows[e.user_id]["logged"][index(e.day)] += e.hours

    result = []
    for row in rows.values():
        row["planned"] = [round(v, 1) for v in row["planned"]]
        row["logged"] = [round(v, 1) for v in row["logged"]]
        row["unscheduled_hours"] = round(row["unscheduled_hours"], 1)
        row["overdue_hours"] = round(row["overdue_hours"], 1)
        row["issues"].sort(key=lambda i: i["due_date"] or "9999")
        result.append(row)
    return {"weeks": [w.isoformat() for w in week_starts], "people": result}


# ═════════════ Portfolio ═════════════


def project_health(project: Project, today: date, high_risks: int) -> str:
    issues = project.issues
    open_issues = [i for i in issues if i.status != "done"]
    if project.status == "completed":
        return "done"
    if project.due_date and project.due_date < today and open_issues:
        return "overdue"
    progress = (len(issues) - len(open_issues)) * 100 / len(issues) if issues else 0
    elapsed = None
    if project.start_date and project.due_date and project.due_date > project.start_date:
        elapsed = min(100, max(0, (today - project.start_date).days * 100 / (project.due_date - project.start_date).days))
    overdue = any(i.due_date and i.due_date < today for i in open_issues)
    if overdue or high_risks or (elapsed is not None and elapsed - progress > 20):
        return "risk"
    if not project.due_date:
        return "unplanned"
    return "track"


@router.get("/portfolio")
def portfolio(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    require_feature(db, user, "portfolio")
    today = date.today()
    allowed = section_filter(db, user)
    rows = []
    for p in db.scalars(visible_projects_query(user).order_by(Project.name)).all():
        if p.status == "archived":
            continue
        acc = access(db, p, user)
        issues = p.issues if allowed(p, "issues") else []
        open_issues = [i for i in issues if i.status != "done"]
        risks = [r for r in p.risks if r.status in ("open", "occurred")] if allowed(p, "risks") else []
        score = {"low": 1, "medium": 2, "high": 3}
        high = [r for r in risks if score[r.probability] * score[r.impact] >= 6]
        next_milestone = None
        if allowed(p, "milestones"):
            upcoming = sorted((m for m in p.milestones if m.status == "open" and m.due_date), key=lambda m: m.due_date)
            if upcoming:
                next_milestone = {"name": upcoming[0].name, "due_date": upcoming[0].due_date.isoformat()}
        costs = project_cost(db, p) if acc and acc["can_manage"] and has_feature(db, user.org_id, "budgets") else None
        rows.append({
            "id": p.id, "name": p.name, "key": p.key, "color": p.color, "logo_url": p.logo_url,
            "status": p.status, "phase": p.phase, "owner": user_brief(p.owner),
            "start_date": p.start_date.isoformat() if p.start_date else None,
            "due_date": p.due_date.isoformat() if p.due_date else None,
            "health": project_health(p, today, len(high)),
            "issue_count": len(issues), "open_issues": len(open_issues),
            "progress": round((len(issues) - len(open_issues)) * 100 / len(issues)) if issues else 0,
            "overdue_issues": sum(1 for i in open_issues if i.due_date and i.due_date < today),
            "open_risks": len(risks), "high_risks": len(high),
            "features_total": len(p.features) if allowed(p, "features") else None,
            "features_released": sum(1 for f in p.features if f.stage == "released") if allowed(p, "features") else None,
            "next_milestone": next_milestone,
            "estimate_hours": round(sum(i.estimate_hours or 0 for i in issues), 1),
            "spent_hours": round(sum(i.spent_hours or 0 for i in issues), 1),
            "budget": costs["budget"] if costs else None,
            "cost": costs["cost"] if costs else None,
            "currency": p.currency or "USD",
            "can_see_cost": costs is not None,
        })
    return rows


# ═════════════ Recycle bin ═════════════


def _title(obj) -> str:
    for attr in ("name", "title", "version"):
        if getattr(obj, attr, None):
            return getattr(obj, attr)
    return "Untitled"


def _project_of(db: Session, obj) -> Project | None:
    if isinstance(obj, Project):
        return obj
    return db.scalar(select(Project).where(Project.id == obj.project_id).execution_options(include_deleted=True))


def _trash_access(db: Session, obj, user: User) -> dict | None:
    project = _project_of(db, obj)
    if project is None:
        return None
    manager = user.role == "admin" or project.owner_id == user.id
    if not (manager or obj.deleted_by_id == user.id):
        return None
    return {"project": project, "can_purge": manager}


def trash_out(db: Session, obj, project: Project, can_purge: bool) -> dict:
    kind = KIND_OF[type(obj)]
    deleted_by = db.get(User, obj.deleted_by_id) if obj.deleted_by_id else None
    label = _title(obj)
    if kind == "issue":
        label = f"{project.key}-{obj.number} {obj.title}"
    return {
        "kind": kind,
        "id": obj.id,
        "title": label,
        "project": {"id": project.id, "name": project.name, "key": project.key, "color": project.color, "deleted": project.deleted_at is not None},
        "deleted_at": dt(obj.deleted_at),
        "expires_at": dt(obj.deleted_at + timedelta(days=RETENTION_DAYS)),
        "deleted_by": user_brief(deleted_by),
        "can_purge": can_purge,
    }


@router.get("/trash")
def list_trash(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    items = []
    for model in KINDS.values():
        for obj in deleted_rows(db, model):
            acc = _trash_access(db, obj, user)
            if acc:
                items.append(trash_out(db, obj, acc["project"], acc["can_purge"]))
    items.sort(key=lambda i: i["deleted_at"], reverse=True)
    return {"items": items, "retention_days": RETENTION_DAYS}


def _deleted_or_404(db: Session, kind: str, item_id: int, user: User):
    obj = get_deleted(db, kind, item_id)
    acc = _trash_access(db, obj, user) if obj is not None else None
    if not acc:
        raise HTTPException(404, "Item not found in the recycle bin")
    return obj, acc


@router.post("/trash/{kind}/{item_id}/restore")
def restore(kind: str, item_id: int, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj, acc = _deleted_or_404(db, kind, item_id, user)
    project = acc["project"]
    if kind != "project" and project.deleted_at is not None:
        raise HTTPException(409, f"Restore the project “{project.name}” first")
    if kind == "project":
        clash = db.scalar(select(Project).where(Project.key == project.key, Project.id != project.id))
        if clash:
            raise HTTPException(409, f"Another project now uses the key {project.key}")
    obj.deleted_at = None
    obj.deleted_by_id = None
    log_activity(db, project.id, user, f"restored {kind} “{_title(obj)}” from the recycle bin")
    if kind == "project":
        audit(db, user, "project.restored", f"{project.key} {project.name}", request)
    db.commit()
    return {"kind": kind, "id": item_id, "project_id": project.id}


@router.delete("/trash/{kind}/{item_id}", status_code=204)
def purge(kind: str, item_id: int, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj, acc = _deleted_or_404(db, kind, item_id, user)
    if not acc["can_purge"]:
        raise HTTPException(403, "Only the project owner or an administrator can delete permanently")
    if kind == "project":
        audit(db, user, "project.purged", f"{obj.key} {obj.name}", request)
    db.delete(obj)
    db.commit()


@router.delete("/trash", status_code=204)
def empty_trash(request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    from ..models import Document, Milestone  # noqa: F401  (all kinds come from KINDS)

    count = 0
    for model in (Issue, Feature, Release, Milestone, Document, Risk, Project):
        for obj in deleted_rows(db, model):
            if _project_of(db, obj) is None:  # belongs to another workspace
                continue
            db.delete(obj)
            count += 1
    audit(db, admin, "trash.emptied", f"{count} item(s)", request)
    db.commit()


# Helpers used by the issues router
__all__ = ["watch", "notify_watchers", "issue_out"]
