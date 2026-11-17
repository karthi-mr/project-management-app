"""Checklists, documents, phase checklists, risks, templates, saved filters and the audit log."""
import json
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..database import get_db
from ..trash import soft_delete
from ..models import (
    AuditLog,
    ChecklistItem,
    Document,
    PhaseCheck,
    ProjectTemplate,
    Risk,
    SavedFilter,
    User,
    utcnow,
)
from ..saas import require_feature
from ..security import get_current_user, require_admin
from ..serializers import dt, user_brief
from ..templates import DEFAULT_PHASE_CHECKS, add_phase_checks, snapshot_project
from .issues import _get_issue
from .projects import ProjectPhase, can_manage, get_project, log_activity, notify

router = APIRouter(prefix="/api", tags=["extras"])

Level = Literal["low", "medium", "high"]
RiskStatus = Literal["open", "mitigating", "occurred", "closed"]
LEVEL_SCORE = {"low": 1, "medium": 2, "high": 3}


# ───────────── Issue checklists ─────────────


class ChecklistIn(BaseModel):
    text: str = Field(min_length=1, max_length=300)


class ChecklistUpdate(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=300)
    done: bool | None = None


def checklist_out(c: ChecklistItem) -> dict:
    return {"id": c.id, "text": c.text, "done": c.done}


@router.post("/issues/{issue_id}/checklist", status_code=201)
def add_checklist_item(
    issue_id: int,
    data: ChecklistIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    issue = _get_issue(db, issue_id, user)
    item = ChecklistItem(issue_id=issue.id, text=data.text.strip())
    db.add(item)
    issue.updated_at = utcnow()
    db.commit()
    return checklist_out(item)


def _get_checklist_item(db: Session, item_id: int, user: User) -> ChecklistItem:
    item = db.get(ChecklistItem, item_id)
    if not item:
        raise HTTPException(404, "Checklist item not found")
    _get_issue(db, item.issue_id, user)
    return item


@router.patch("/checklist/{item_id}")
def update_checklist_item(
    item_id: int,
    data: ChecklistUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    item = _get_checklist_item(db, item_id, user)
    if data.text is not None:
        item.text = data.text.strip()
    if data.done is not None:
        item.done = data.done
    db.commit()
    return checklist_out(item)


@router.delete("/checklist/{item_id}", status_code=204)
def delete_checklist_item(
    item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    db.delete(_get_checklist_item(db, item_id, user))
    db.commit()


# ───────────── Documents ─────────────


class DocumentIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=200000)


class DocumentUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=200000)


def document_out(d: Document) -> dict:
    return {
        "id": d.id,
        "project_id": d.project_id,
        "title": d.title,
        "content": d.content,
        "updated_by": user_brief(d.updated_by),
        "created_at": dt(d.created_at),
        "updated_at": dt(d.updated_at),
    }


@router.get("/projects/{project_id}/documents")
def list_documents(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    project = get_project(db, project_id, user, section="docs")
    return [document_out(d) for d in sorted(project.documents, key=lambda d: d.title.lower())]


@router.post("/projects/{project_id}/documents", status_code=201)
def create_document(
    project_id: int,
    data: DocumentIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, section="docs")
    doc = Document(
        project_id=project.id,
        title=data.title.strip(),
        content=data.content,
        author_id=user.id,
        updated_by_id=user.id,
    )
    db.add(doc)
    log_activity(db, project.id, user, f"created document “{doc.title}”")
    db.commit()
    return document_out(doc)


def _get_document(db: Session, doc_id: int, user: User) -> Document:
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    get_project(db, doc.project_id, user, section="docs")
    return doc


@router.patch("/documents/{doc_id}")
def update_document(
    doc_id: int,
    data: DocumentUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc = _get_document(db, doc_id, user)
    if data.title is not None:
        doc.title = data.title.strip()
    if data.content is not None:
        doc.content = data.content
    doc.updated_by_id = user.id
    doc.updated_at = utcnow()
    db.commit()
    db.refresh(doc)
    return document_out(doc)


@router.delete("/documents/{doc_id}", status_code=204)
def delete_document(
    doc_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    doc = _get_document(db, doc_id, user)
    log_activity(db, doc.project_id, user, f"deleted document “{doc.title}”")
    soft_delete(doc, user)  # recoverable from the recycle bin for 30 days
    db.commit()


# ───────────── Phase checklists (exit criteria) ─────────────


class PhaseCheckIn(BaseModel):
    phase: ProjectPhase
    text: str = Field(min_length=1, max_length=300)


class PhaseCheckUpdate(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=300)
    done: bool | None = None


def phase_check_out(c: PhaseCheck) -> dict:
    return {
        "id": c.id,
        "phase": c.phase,
        "text": c.text,
        "done": c.done,
        "done_by": user_brief(c.done_by) if c.done else None,
        "done_at": dt(c.done_at) if c.done else None,
    }


@router.get("/projects/{project_id}/phase-checks")
def list_phase_checks(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    project = get_project(db, project_id, user)
    return [phase_check_out(c) for c in project.phase_checks]


@router.post("/projects/{project_id}/phase-checks", status_code=201)
def create_phase_check(
    project_id: int,
    data: PhaseCheckIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user)
    check = PhaseCheck(project_id=project.id, phase=data.phase, text=data.text.strip())
    db.add(check)
    db.commit()
    return phase_check_out(check)


@router.post("/projects/{project_id}/phase-checks/defaults")
def add_default_phase_checks(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Add the suggested checklist to every phase that has no items yet."""
    project = get_project(db, project_id, user)
    used = {c.phase for c in project.phase_checks}
    missing = {p: items for p, items in DEFAULT_PHASE_CHECKS.items() if p not in used}
    add_phase_checks(db, project, missing)
    db.commit()
    db.refresh(project)
    return [phase_check_out(c) for c in project.phase_checks]


def _get_phase_check(db: Session, check_id: int, user: User) -> PhaseCheck:
    check = db.get(PhaseCheck, check_id)
    if not check:
        raise HTTPException(404, "Checklist item not found")
    get_project(db, check.project_id, user)
    return check


@router.patch("/phase-checks/{check_id}")
def update_phase_check(
    check_id: int,
    data: PhaseCheckUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    check = _get_phase_check(db, check_id, user)
    if data.text is not None:
        check.text = data.text.strip()
    if data.done is not None and data.done != check.done:
        check.done = data.done
        check.done_by_id = user.id if data.done else None
        check.done_at = utcnow() if data.done else None
        if data.done:
            log_activity(db, check.project_id, user, f"completed {check.phase} checklist item “{check.text}”")
    db.commit()
    db.refresh(check)
    return phase_check_out(check)


@router.delete("/phase-checks/{check_id}", status_code=204)
def delete_phase_check(
    check_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    db.delete(_get_phase_check(db, check_id, user))
    db.commit()


# ───────────── Risks ─────────────


class RiskIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)
    mitigation: str = Field(default="", max_length=20000)
    probability: Level = "medium"
    impact: Level = "medium"
    status: RiskStatus = "open"
    owner_id: int | None = None
    review_date: date | None = None


class RiskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20000)
    mitigation: str | None = Field(default=None, max_length=20000)
    probability: Level | None = None
    impact: Level | None = None
    status: RiskStatus | None = None
    owner_id: int | None = None
    review_date: date | None = None


def risk_score(r: Risk) -> int:
    return LEVEL_SCORE[r.probability] * LEVEL_SCORE[r.impact]


def risk_out(r: Risk) -> dict:
    score = risk_score(r)
    return {
        "id": r.id,
        "project_id": r.project_id,
        "title": r.title,
        "description": r.description,
        "mitigation": r.mitigation,
        "probability": r.probability,
        "impact": r.impact,
        "score": score,
        "severity": "high" if score >= 6 else "medium" if score >= 3 else "low",
        "status": r.status,
        "owner": user_brief(r.owner),
        "review_date": r.review_date.isoformat() if r.review_date else None,
        "created_at": dt(r.created_at),
        "updated_at": dt(r.updated_at),
    }


def _check_member(project, user_id: int | None):
    if user_id is None:
        return
    if all(m.id != user_id for m in project.members) and project.owner_id != user_id:
        raise HTTPException(422, "Owner must be a member of the project")


@router.get("/projects/{project_id}/risks")
def list_risks(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    project = get_project(db, project_id, user, section="risks")
    ordered = sorted(
        project.risks, key=lambda r: (r.status == "closed", -risk_score(r), r.id)
    )
    return [risk_out(r) for r in ordered]


@router.post("/projects/{project_id}/risks", status_code=201)
def create_risk(
    project_id: int,
    data: RiskIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, section="risks")
    _check_member(project, data.owner_id)
    risk = Risk(project_id=project.id, **data.model_dump())
    risk.title = risk.title.strip()
    db.add(risk)
    log_activity(db, project.id, user, f"logged risk “{risk.title}”")
    notify(db, risk.owner_id, user, f"made you the owner of risk “{risk.title}”", project.id)
    db.commit()
    return risk_out(risk)


def _get_risk(db: Session, risk_id: int, user: User) -> Risk:
    risk = db.get(Risk, risk_id)
    if not risk:
        raise HTTPException(404, "Risk not found")
    get_project(db, risk.project_id, user, section="risks")
    return risk


@router.patch("/risks/{risk_id}")
def update_risk(
    risk_id: int,
    data: RiskUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    risk = _get_risk(db, risk_id, user)
    project = get_project(db, risk.project_id, user, section="risks")
    fields = data.model_dump(exclude_unset=True)
    for name in ("title", "description", "mitigation", "probability", "impact", "status"):
        if name in fields and fields[name] is None:
            del fields[name]
    if "owner_id" in fields and fields["owner_id"] != risk.owner_id:
        _check_member(project, fields["owner_id"])
        notify(db, fields["owner_id"], user, f"made you the owner of risk “{risk.title}”", project.id)
    if "status" in fields and fields["status"] != risk.status:
        log_activity(db, project.id, user, f"marked risk “{risk.title}” as {fields['status']}")
    for name, value in fields.items():
        setattr(risk, name, value.strip() if name == "title" else value)
    risk.updated_at = utcnow()
    db.commit()
    db.refresh(risk)
    return risk_out(risk)


@router.delete("/risks/{risk_id}", status_code=204)
def delete_risk(
    risk_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    risk = _get_risk(db, risk_id, user)
    log_activity(db, risk.project_id, user, f"removed risk “{risk.title}”")
    soft_delete(risk, user)  # recoverable from the recycle bin for 30 days
    db.commit()


# ───────────── Project templates ─────────────


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)


def template_out(t: ProjectTemplate, user: User) -> dict:
    data = json.loads(t.data)
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "builtin": t.builtin,
        "can_delete": user.is_platform_admin if t.builtin else (user.role == "admin" or t.created_by_id == user.id),
        "summary": {
            "features": len(data.get("features") or []),
            "milestones": len(data.get("milestones") or []),
            "documents": len(data.get("documents") or []),
            "risks": len(data.get("risks") or []),
            "phase_checks": sum(len(v) for v in (data.get("phase_checks") or {}).values()),
        },
    }


@router.get("/templates")
def list_templates(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(ProjectTemplate)
        .where(or_(ProjectTemplate.org_id == user.org_id, ProjectTemplate.org_id.is_(None)))
        .order_by(ProjectTemplate.builtin.desc(), ProjectTemplate.name)
    ).all()
    return [template_out(t, user) for t in rows]


@router.post("/projects/{project_id}/template", status_code=201)
def save_project_as_template(
    project_id: int,
    data: TemplateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, manage=True)
    template = ProjectTemplate(
        name=data.name.strip(),
        description=data.description.strip(),
        data=json.dumps(snapshot_project(project)),
        org_id=user.org_id,
        created_by_id=user.id,
    )
    db.add(template)
    db.commit()
    return template_out(template, user)


@router.delete("/templates/{template_id}", status_code=204)
def delete_template(
    template_id: int,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    template = db.get(ProjectTemplate, template_id)
    if not template or template.org_id not in (None, user.org_id):
        raise HTTPException(404, "Template not found")
    allowed = user.is_platform_admin if template.builtin else (user.role == "admin" or template.created_by_id == user.id)
    if not allowed:
        raise HTTPException(403, "Only the template's creator or an administrator can delete it")
    audit(db, user, "template.deleted", template.name, request)
    db.delete(template)
    db.commit()


# ───────────── Saved filters ─────────────


class SavedFilterIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    data: dict[str, str]


def saved_filter_out(f: SavedFilter) -> dict:
    return {"id": f.id, "name": f.name, "data": json.loads(f.data)}


@router.get("/projects/{project_id}/filters")
def list_saved_filters(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    get_project(db, project_id, user, section="issues", write=False)
    rows = db.scalars(
        select(SavedFilter)
        .where(SavedFilter.project_id == project_id, SavedFilter.user_id == user.id)
        .order_by(SavedFilter.name)
    ).all()
    return [saved_filter_out(f) for f in rows]


@router.post("/projects/{project_id}/filters", status_code=201)
def create_saved_filter(
    project_id: int,
    data: SavedFilterIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_project(db, project_id, user, section="issues", write=False)
    if len(json.dumps(data.data)) > 2000:
        raise HTTPException(422, "Filter is too large")
    saved = SavedFilter(
        user_id=user.id, project_id=project_id, name=data.name.strip(), data=json.dumps(data.data)
    )
    db.add(saved)
    db.commit()
    return saved_filter_out(saved)


@router.delete("/filters/{filter_id}", status_code=204)
def delete_saved_filter(
    filter_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    saved = db.get(SavedFilter, filter_id)
    if not saved or saved.user_id != user.id:
        raise HTTPException(404, "Saved filter not found")
    db.delete(saved)
    db.commit()


# ───────────── Audit log ─────────────


@router.get("/admin/audit")
def audit_log(
    q: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=200, ge=1, le=500),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    require_feature(db, admin, "audit_log")
    stmt = select(AuditLog).where(AuditLog.org_id == admin.org_id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(AuditLog.actor_name.ilike(like), AuditLog.action.ilike(like), AuditLog.detail.ilike(like))
        )
    rows = db.scalars(stmt.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit)).all()
    return [
        {
            "id": a.id,
            "actor": a.actor_name,
            "action": a.action,
            "detail": a.detail,
            "ip": a.ip,
            "created_at": dt(a.created_at),
        }
        for a in rows
    ]
