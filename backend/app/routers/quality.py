"""Sign-off checklists, test management, client feedback, security controls and the status page."""
import ipaddress
import json
import time
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import signoff
from ..access import request_ip
from ..audit import audit
from ..database import get_db
from ..models import (
    Feature,
    HealthCheck,
    Incident,
    Issue,
    Milestone,
    Notification,
    Organization,
    ShareFeedback,
    ShareLink,
    SignoffCheck,
    SignoffCriterion,
    TestCase,
    TestResult,
    User,
    UserSession,
    utcnow,
)
from ..saas import get_org, get_settings, has_feature, require_feature
from ..security import get_current_user, parse_allowlist, require_admin, require_platform_admin
from ..serializers import dt, user_brief
from .projects import get_project, log_activity

router = APIRouter(prefix="/api", tags=["quality"])


# ═════════════ Sign-off checklists ═════════════


class CriterionIn(BaseModel):
    id: int | None = None
    target_type: Literal["feature", "milestone"]
    stage: str = Field(max_length=20)
    text: str = Field(min_length=1, max_length=200)
    kind: Literal["manual", "all_issues_done", "tests_passed"] = "manual"


class CriteriaIn(BaseModel):
    criteria: list[CriterionIn] = Field(max_length=200)


def criterion_out(c: SignoffCriterion) -> dict:
    return {"id": c.id, "target_type": c.target_type, "stage": c.stage, "text": c.text, "kind": c.kind}


@router.get("/projects/{project_id}/signoff-criteria")
def list_criteria(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_project(db, project_id, user)
    rows = db.scalars(
        select(SignoffCriterion).where(SignoffCriterion.project_id == project_id).order_by(SignoffCriterion.position, SignoffCriterion.id)
    ).all()
    return [criterion_out(c) for c in rows]


@router.put("/projects/{project_id}/signoff-criteria")
def save_criteria(project_id: int, data: CriteriaIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Replace the project's checklists. Existing lines keep their ticks."""
    project = get_project(db, project_id, user, manage=True)
    require_feature(db, user, "approvals_advanced")
    existing = {c.id: c for c in db.scalars(select(SignoffCriterion).where(SignoffCriterion.project_id == project.id))}
    kept = set()
    for position, item in enumerate(data.criteria):
        stages = signoff.STAGES[item.target_type]
        if item.stage not in stages or item.stage == stages[-1]:
            raise HTTPException(422, f"“{item.stage}” is not a stage that can be signed off")
        if item.kind == "tests_passed" and item.target_type != "feature":
            raise HTTPException(422, "Test results can only be required for features")
        row = existing.get(item.id) if item.id else None
        if row is None:
            row = SignoffCriterion(project_id=project.id)
            db.add(row)
        else:
            kept.add(row.id)
        row.target_type, row.stage, row.kind, row.position = item.target_type, item.stage, item.kind, position
        row.text = item.text.strip()
    for row_id, row in existing.items():
        if row_id not in kept:
            db.delete(row)
    log_activity(db, project.id, user, "changed the sign-off checklists")
    db.commit()
    return list_criteria(project_id, user, db)


class CheckIn(BaseModel):
    criterion_id: int
    target_id: int
    done: bool


@router.post("/signoff-checks")
def tick(data: CheckIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    criterion = db.get(SignoffCriterion, data.criterion_id)
    if not criterion:
        raise HTTPException(404, "Checklist line not found")
    section = "features" if criterion.target_type == "feature" else "milestones"
    project = get_project(db, criterion.project_id, user, section=section)
    if criterion.kind != "manual":
        raise HTTPException(400, "This line is checked automatically")
    model = Feature if criterion.target_type == "feature" else Milestone
    obj = db.get(model, data.target_id)
    if not obj or obj.project_id != project.id:
        raise HTTPException(404, "Not found in this project")
    if obj.stage != criterion.stage:
        raise HTTPException(409, "This checklist belongs to a different stage")
    check = db.scalar(select(SignoffCheck).where(SignoffCheck.criterion_id == criterion.id, SignoffCheck.target_id == obj.id))
    if data.done and not check:
        db.add(SignoffCheck(criterion_id=criterion.id, target_id=obj.id, checked_by_id=user.id, checked_by_name=user.full_name))
    elif not data.done and check:
        db.delete(check)
    if criterion.target_type == "milestone":
        db.flush()
        signoff.sync_milestones(db, project, [obj.id], user)  # it may have been waiting for this tick
    db.commit()
    return signoff.state(db, criterion.target_type, obj)


# ═════════════ Test management ═════════════


class TestCaseIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    steps: str = Field(default="", max_length=10000)
    expected: str = Field(default="", max_length=5000)
    feature_id: int | None = None


class TestResultIn(BaseModel):
    status: Literal["passed", "failed", "blocked"]
    note: str = Field(default="", max_length=5000)
    raise_bug: bool = False


def case_out(c: TestCase, history: bool = False) -> dict:
    data = {
        "id": c.id, "project_id": c.project_id, "title": c.title, "steps": c.steps, "expected": c.expected,
        "feature_id": c.feature_id, "feature_title": c.feature.title if c.feature else None,
        "status": c.last_status, "last_run_at": dt(c.last_run_at), "last_run_by": c.last_run_by,
        "runs": len(c.results), "created_at": dt(c.created_at),
    }
    latest = c.results[0] if c.results else None
    data["last_note"] = latest.note if latest and c.last_status else ""
    data["bug_issue_id"] = latest.issue_id if latest and c.last_status == "failed" else None
    if history:
        data["results"] = [
            {"id": r.id, "status": r.status, "note": r.note, "tester": r.tester_name, "issue_id": r.issue_id, "created_at": dt(r.created_at)}
            for r in c.results[:30]
        ]
    return data


def _feature_in_project(db: Session, project_id: int, feature_id: int | None) -> None:
    if feature_id is not None:
        feature = db.get(Feature, feature_id)
        if not feature or feature.project_id != project_id:
            raise HTTPException(422, "Feature not found in this project")


def _case(db: Session, case_id: int, user: User) -> TestCase:
    case = db.get(TestCase, case_id)
    if not case or case.project is None:
        raise HTTPException(404, "Test case not found")
    get_project(db, case.project_id, user, section="features")
    require_feature(db, user, "tests")
    return case


@router.get("/projects/{project_id}/tests")
def list_tests(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_project(db, project_id, user, section="features")
    require_feature(db, user, "tests")
    cases = db.scalars(select(TestCase).where(TestCase.project_id == project_id).order_by(TestCase.feature_id, TestCase.id)).all()
    summary = {"total": len(cases), "passed": 0, "failed": 0, "blocked": 0, "not_run": 0}
    for c in cases:
        summary[c.last_status or "not_run"] += 1
    return {"cases": [case_out(c) for c in cases], "summary": summary}


@router.post("/projects/{project_id}/tests", status_code=201)
def create_test(project_id: int, data: TestCaseIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = get_project(db, project_id, user, section="features")
    require_feature(db, user, "tests")
    _feature_in_project(db, project.id, data.feature_id)
    case = TestCase(project_id=project.id, feature_id=data.feature_id, title=data.title.strip(), steps=data.steps, expected=data.expected, created_by_id=user.id)
    db.add(case)
    db.commit()
    return case_out(case)


@router.get("/tests/{case_id}")
def read_test(case_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return case_out(_case(db, case_id, user), history=True)


@router.patch("/tests/{case_id}")
def update_test(case_id: int, data: TestCaseIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    case = _case(db, case_id, user)
    _feature_in_project(db, case.project_id, data.feature_id)
    changed = (case.steps, case.expected) != (data.steps, data.expected)
    case.title, case.steps, case.expected, case.feature_id = data.title.strip(), data.steps, data.expected, data.feature_id
    if changed and case.last_status:
        case.last_status = ""  # what is being tested changed, so the old result no longer counts
    db.commit()
    return case_out(case)


@router.delete("/tests/{case_id}", status_code=204)
def delete_test(case_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    case = _case(db, case_id, user)
    db.delete(case)
    db.commit()


@router.post("/tests/{case_id}/results")
def record_result(case_id: int, data: TestResultIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Record a test run. A failed test can raise a bug in the same step."""
    case = _case(db, case_id, user)
    project = case.project
    result = TestResult(case_id=case.id, status=data.status, note=data.note.strip(), tester_id=user.id, tester_name=user.full_name)
    if data.status == "failed" and data.raise_bug:
        project.issue_counter += 1
        feature = case.feature
        bug = Issue(
            project_id=project.id, number=project.issue_counter, title=f"Test failed: {case.title}"[:200], type="bug",
            status="todo", priority="high", reporter_id=user.id,
            assignee_id=feature.owner_id if feature else None, feature_id=case.feature_id, labels="test-failure",
            description=(
                f"**Test case:** {case.title}\n\n**Steps:**\n{case.steps or '—'}\n\n"
                f"**Expected:**\n{case.expected or '—'}\n\n**What happened:**\n{data.note.strip() or '—'}"
            ),
        )
        db.add(bug)
        db.flush()
        result.issue_id = bug.id
        if bug.assignee_id and bug.assignee_id != user.id:
            db.add(Notification(user_id=bug.assignee_id, message=f"{user.full_name} raised a bug from a failed test: {case.title}"[:500], project_id=project.id, issue_id=bug.id))
            db.info.setdefault("notify_users", set()).add(bug.assignee_id)
    db.add(result)
    case.last_status = data.status
    case.last_run_at = utcnow()
    case.last_run_by = user.full_name
    log_activity(db, project.id, user, f"marked test “{case.title}” as {data.status}")
    db.commit()
    db.refresh(case)
    return case_out(case, history=True)


@router.post("/projects/{project_id}/tests/reset", status_code=204)
def reset_tests(project_id: int, feature_id: int | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Start a new test round: every case goes back to "not run". The history is kept."""
    project = get_project(db, project_id, user, section="features")
    require_feature(db, user, "tests")
    stmt = select(TestCase).where(TestCase.project_id == project.id)
    if feature_id is not None:
        stmt = stmt.where(TestCase.feature_id == feature_id)
    for case in db.scalars(stmt).all():
        case.last_status = ""
    log_activity(db, project.id, user, "started a new test round")
    db.commit()


# ═════════════ Client feedback on share links ═════════════

_feedback_times: dict[str, list[float]] = {}


class FeedbackIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    body: str = Field(default="", max_length=5000)
    kind: Literal["comment", "approval"] = "comment"
    target_type: Literal["project", "milestone", "feature"] = "project"
    target_id: int | None = None


def feedback_out(f: ShareFeedback, private: bool = False) -> dict:
    data = {
        "id": f.id, "author": f.author_name, "kind": f.kind, "target_type": f.target_type,
        "target_name": f.target_name, "body": f.body, "reply": f.reply, "reply_by": "The team" if f.reply else "",
        "created_at": dt(f.created_at),
    }
    if private:
        data.update({"resolved": f.resolved, "reply_by": f.reply_by, "link_label": f.link.label if f.link else "", "target_id": f.target_id})
    return data


def live_link(db: Session, token: str) -> ShareLink:
    link = db.scalar(select(ShareLink).where(ShareLink.token == token))
    if not link or link.revoked or link.project is None or (link.expires_at and link.expires_at < utcnow()):
        raise HTTPException(404, "This link is not valid any more")
    org = db.get(Organization, link.project.org_id)
    if org is None or org.suspended or not has_feature(db, org.id, "client_portal"):
        raise HTTPException(404, "This link is not valid any more")
    return link


@router.get("/public/share/{token}/feedback")
def read_feedback(token: str, db: Session = Depends(get_db)):
    link = live_link(db, token)
    rows = db.scalars(select(ShareFeedback).where(ShareFeedback.link_id == link.id).order_by(ShareFeedback.id.desc()).limit(50)).all()
    return {"allowed": bool(link.allow_feedback), "items": [feedback_out(f) for f in rows]}


@router.post("/public/share/{token}/feedback", status_code=201)
def leave_feedback(token: str, data: FeedbackIn, db: Session = Depends(get_db)):
    """A client comments on the project, or approves a milestone or feature, from the share page."""
    link = live_link(db, token)
    if not link.allow_feedback:
        raise HTTPException(403, "Comments are switched off for this link")
    recent = [t for t in _feedback_times.get(token, []) if time.time() - t < 3600]
    if len(recent) >= 20:
        raise HTTPException(429, "Too many messages for now. Try again later.")
    project = link.project
    sections = set(link.sections.split(","))
    target_name = project.name
    if data.target_type != "project":
        if f"{data.target_type}s" not in sections:
            raise HTTPException(422, "That item is not part of this page")
        model = Feature if data.target_type == "feature" else Milestone
        obj = db.get(model, data.target_id or 0)
        if not obj or obj.project_id != project.id:
            raise HTTPException(422, "That item is not part of this page")
        target_name = obj.title if data.target_type == "feature" else obj.name
    body = data.body.strip()
    if data.kind == "comment" and not body:
        raise HTTPException(422, "Write a message first")
    feedback = ShareFeedback(
        link_id=link.id, project_id=project.id, author_name=data.name.strip(), kind=data.kind,
        target_type=data.target_type, target_id=data.target_id if data.target_type != "project" else None,
        target_name=target_name[:200], body=body,
    )
    db.add(feedback)
    verb = "approved" if data.kind == "approval" else "commented on"
    message = f"Client {feedback.author_name} {verb} {'the project' if data.target_type == 'project' else f'{data.target_type} “{target_name}”'}"
    for person in signoff.approvers(db, project):
        db.add(Notification(user_id=person.id, message=message[:500], project_id=project.id))
        db.info.setdefault("notify_users", set()).add(person.id)
    from ..models import Activity

    db.add(Activity(project_id=project.id, user_id=None, message=message[:500]))
    db.commit()
    _feedback_times[token] = recent + [time.time()]
    return feedback_out(feedback)


class ReplyIn(BaseModel):
    reply: str | None = Field(default=None, max_length=5000)
    resolved: bool | None = None


@router.get("/projects/{project_id}/feedback")
def project_feedback(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_project(db, project_id, user)
    require_feature(db, user, "client_portal")
    rows = db.scalars(select(ShareFeedback).where(ShareFeedback.project_id == project_id).order_by(ShareFeedback.resolved, ShareFeedback.id.desc()).limit(200)).all()
    return [feedback_out(f, private=True) for f in rows]


@router.patch("/feedback/{feedback_id}")
def answer_feedback(feedback_id: int, data: ReplyIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    feedback = db.get(ShareFeedback, feedback_id)
    if not feedback:
        raise HTTPException(404, "Feedback not found")
    project = get_project(db, feedback.project_id, user)
    require_feature(db, user, "client_portal")
    if not signoff.is_approver(db, project, user):
        raise HTTPException(403, "Only the project owner or a manager can answer clients")
    if data.reply is not None:
        feedback.reply = data.reply.strip()
        feedback.reply_by = user.full_name
    if data.resolved is not None:
        feedback.resolved = data.resolved
    db.commit()
    return feedback_out(feedback, private=True)


# ═════════════ Sessions and security controls ═════════════


def session_out(s: UserSession, current_key: str | None = None) -> dict:
    return {
        "id": s.id, "ip": s.ip, "device": describe_agent(s.user_agent), "created_at": dt(s.created_at),
        "last_seen_at": dt(s.last_seen_at), "current": bool(current_key and s.key == current_key),
        "user": user_brief(s.user) if s.user else None,
    }


def describe_agent(agent: str) -> str:
    """A short, readable name for a browser's user-agent string."""
    a = agent or ""
    browser = next((name for mark, name in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")) if mark in a), "")
    system = next((name for mark, name in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"), ("Mac OS X", "Mac"), ("Linux", "Linux")) if mark in a), "")
    return " on ".join(p for p in (browser, system) if p) or (a[:60] or "Unknown device")


ACTIVE_FOR = timedelta(hours=12)


def _active(stmt):
    return stmt.where(UserSession.revoked.is_(False), UserSession.last_seen_at >= utcnow() - ACTIVE_FOR)


@router.get("/auth/sessions")
def my_sessions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.scalars(_active(select(UserSession).where(UserSession.user_id == user.id)).order_by(UserSession.last_seen_at.desc())).all()
    key = db.info.get("session_key")
    return [session_out(s, key) for s in rows]


@router.delete("/auth/sessions/{session_id}", status_code=204)
def end_my_session(session_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = db.get(UserSession, session_id)
    if not s or s.user_id != user.id:
        raise HTTPException(404, "Session not found")
    s.revoked = True
    db.commit()


@router.post("/auth/sessions/sign-out-others", status_code=204)
def end_other_sessions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    key = db.info.get("session_key")
    for s in db.scalars(select(UserSession).where(UserSession.user_id == user.id, UserSession.revoked.is_(False))).all():
        if s.key != key:
            s.revoked = True
    db.commit()


class SecurityIn(BaseModel):
    password_min_length: int = Field(ge=8, le=64)
    password_require_symbol: bool
    password_require_mixed_case: bool
    ip_allowlist: str = Field(default="", max_length=4000)
    require_two_factor: bool = False


def security_out(db: Session, org: Organization) -> dict:
    return {
        "password_min_length": org.password_min_length or 8,
        "password_require_symbol": bool(org.password_require_symbol),
        "password_require_mixed_case": bool(org.password_require_mixed_case),
        "ip_allowlist": org.ip_allowlist or "",
        "require_two_factor": bool(org.require_two_factor),
        "two_factor_users": db.scalar(select(func.count()).select_from(User).where(User.org_id == org.id, User.is_active, User.totp_enabled_at.is_not(None))),
        "active_users": db.scalar(select(func.count()).select_from(User).where(User.org_id == org.id, User.is_active)),
        "ip_allowlist_available": has_feature(db, org.id, "security"),
        "your_ip": request_ip.get(),
    }


@router.get("/admin/security")
def read_security(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    org = get_org(db, admin)
    rows = db.scalars(
        _active(select(UserSession).join(User, UserSession.user_id == User.id).where(User.org_id == org.id))
        .order_by(UserSession.last_seen_at.desc()).limit(300)
    ).all()
    key = db.info.get("session_key")
    return {**security_out(db, org), "sessions": [session_out(s, key) for s in rows]}


@router.put("/admin/security")
def save_security(data: SecurityIn, request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    org = get_org(db, admin)
    org.password_min_length = data.password_min_length
    org.password_require_symbol = data.password_require_symbol
    org.password_require_mixed_case = data.password_require_mixed_case
    if data.require_two_factor and not org.require_two_factor and admin.totp_enabled_at is None:
        raise HTTPException(422, "Turn on two-factor sign-in for your own account first (in your profile), so you are not locked out.")
    if data.require_two_factor != bool(org.require_two_factor):
        audit(db, admin, "security.two_factor_required" if data.require_two_factor else "security.two_factor_optional", "", request)
    org.require_two_factor = data.require_two_factor
    allow = "\n".join(line.strip() for line in data.ip_allowlist.splitlines() if line.strip())
    if allow != (org.ip_allowlist or ""):
        if allow:
            require_feature(db, admin, "security")
            try:
                networks = parse_allowlist(allow, strict=True)
            except ValueError as err:
                raise HTTPException(422, f"“{err}” is not a valid address or range. Use for example 203.0.113.7 or 203.0.113.0/24.")
            here = request_ip.get()
            try:
                inside = any(ipaddress.ip_address(here) in n for n in networks)
            except ValueError:
                inside = False
            if not inside:
                raise HTTPException(422, f"Your own address ({here}) is not in the list, so saving it would lock you out. Add it first.")
        org.ip_allowlist = allow
    audit(db, admin, "security.updated", "Password policy or allowed addresses changed", request)
    db.commit()
    return security_out(db, org)


class ModulesIn(BaseModel):
    modules: dict[str, bool]


@router.get("/admin/modules")
def read_modules(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    from ..saas import MODULES, hidden_modules

    hidden = hidden_modules(get_org(db, admin))
    return [{"key": key, "label": label, "on": key not in hidden} for key, label in MODULES.items()]


@router.put("/admin/modules")
def save_modules(data: ModulesIn, request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Show or hide optional parts of the app for everyone in the workspace."""
    from ..saas import MODULES, hidden_modules

    unknown = [k for k in data.modules if k not in MODULES]
    if unknown:
        raise HTTPException(422, f"Unknown module: {unknown[0]}")
    org = get_org(db, admin)
    hidden = hidden_modules(org)
    for key, on in data.modules.items():
        (hidden.discard if on else hidden.add)(key)
    org.hidden_modules = ",".join(k for k in MODULES if k in hidden)
    audit(db, admin, "workspace.modules", ", ".join(sorted(hidden)) or "everything shown", request)
    db.commit()
    return read_modules(admin, db)


@router.post("/admin/sessions/{session_id}/end", status_code=204)
def end_session(session_id: int, request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    s = db.get(UserSession, session_id)
    if not s or s.user is None or s.user.org_id != admin.org_id:
        raise HTTPException(404, "Session not found")
    s.revoked = True
    audit(db, admin, "session.ended", s.user.username, request)
    db.commit()


@router.post("/users/{user_id}/reset-2fa", status_code=204)
def reset_two_factor(user_id: int, request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """For someone who lost their phone and their recovery codes. They set it up again at next sign-in
    if the workspace requires it."""
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if target.id == admin.id:
        raise HTTPException(400, "Turn off your own two-factor sign-in from your profile")
    target.totp_secret = None
    target.totp_pending_secret = None
    target.totp_enabled_at = None
    target.totp_last_step = None
    target.recovery_codes = ""
    target.token_version = (target.token_version or 0) + 1  # sign them out everywhere
    for s in db.scalars(select(UserSession).where(UserSession.user_id == target.id, UserSession.revoked.is_(False))).all():
        s.revoked = True
    audit(db, admin, "2fa.reset_by_admin", target.username, request)
    db.commit()


@router.post("/users/{user_id}/sign-out", status_code=204)
def sign_out_everywhere(user_id: int, request: Request, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Force someone out of every browser and device."""
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    target.token_version = (target.token_version or 0) + 1
    for s in db.scalars(select(UserSession).where(UserSession.user_id == target.id, UserSession.revoked.is_(False))).all():
        s.revoked = True
    audit(db, admin, "session.forced_out", target.username, request)
    db.commit()


# ═════════════ Status page and uptime ═════════════

CHECK_SECONDS = 60
GAP_SECONDS = 150  # a silence longer than this between checks counts as downtime


class IncidentIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    impact: Literal["minor", "major", "maintenance"] = "minor"
    text: str = Field(default="", max_length=5000)


class IncidentUpdateIn(BaseModel):
    status: Literal["investigating", "identified", "monitoring", "resolved"]
    text: str = Field(default="", max_length=5000)


def incident_out(i: Incident) -> dict:
    try:
        updates = json.loads(i.updates or "[]")
    except ValueError:
        updates = []
    return {
        "id": i.id, "title": i.title, "impact": i.impact, "status": i.status,
        "started_at": dt(i.started_at), "resolved_at": dt(i.resolved_at), "updates": updates,
    }


def day_uptime(checks: list[HealthCheck], start: datetime, end: datetime) -> float | None:
    """Share of [start, end) the service was up, from the minute-by-minute self-checks."""
    span = (end - start).total_seconds()
    if span <= 0 or not checks:
        return None
    down = 0.0
    previous = start
    for check in checks:
        gap = (check.checked_at - previous).total_seconds()
        if gap > GAP_SECONDS:
            down += gap - CHECK_SECONDS
        if not check.ok:
            down += CHECK_SECONDS
        previous = check.checked_at
    tail = (end - previous).total_seconds()
    if tail > GAP_SECONDS:
        down += tail - CHECK_SECONDS
    return round(max(0.0, min(1.0, 1 - down / span)) * 100, 2)


def status_summary(db: Session, days: int = 90) -> dict:
    now = utcnow()
    first = db.scalar(select(func.min(HealthCheck.checked_at)))
    latest = db.scalar(select(HealthCheck).order_by(HealthCheck.id.desc()).limit(1))
    since = now - timedelta(days=days)
    rows = db.scalars(select(HealthCheck).where(HealthCheck.checked_at >= since).order_by(HealthCheck.checked_at)).all()
    by_day: dict = {}
    for row in rows:
        by_day.setdefault(row.checked_at.date(), []).append(row)
    out_days = []
    total_up, total_span = 0.0, 0.0
    for n in range(days - 1, -1, -1):
        day = (now - timedelta(days=n)).date()
        start = datetime.combine(day, datetime.min.time())
        end = min(start + timedelta(days=1), now)
        if first is None or end <= first:
            out_days.append({"date": day.isoformat(), "uptime": None})
            continue
        start = max(start, first)
        value = day_uptime(by_day.get(day, []), start, end) if by_day.get(day) else 0.0
        span = (end - start).total_seconds()
        if value is not None and span > 0:
            total_up += value * span
            total_span += span
        out_days.append({"date": day.isoformat(), "uptime": value})
    open_incidents = db.scalars(select(Incident).where(Incident.status != "resolved").order_by(Incident.id.desc())).all()
    recent = db.scalars(select(Incident).where(Incident.status == "resolved").order_by(Incident.id.desc()).limit(10)).all()
    healthy = bool(latest and latest.ok and (now - latest.checked_at).total_seconds() < GAP_SECONDS)
    if any(i.impact == "major" for i in open_incidents):
        state = "major"
    elif any(i.impact == "maintenance" for i in open_incidents):
        state = "maintenance"
    elif open_incidents or not healthy:
        state = "degraded"
    else:
        state = "operational"
    return {
        "state": state,
        "checked_at": dt(latest.checked_at) if latest else None,
        "response_ms": round(latest.db_ms, 1) if latest else None,
        "uptime": round(total_up / total_span, 2) if total_span else None,
        "monitoring_since": dt(first),
        "days": out_days,
        "open_incidents": [incident_out(i) for i in open_incidents],
        "past_incidents": [incident_out(i) for i in recent],
    }


@router.get("/public/status")
def public_status(db: Session = Depends(get_db)):
    settings = get_settings(db)
    return {**status_summary(db), "company_name": settings["company_name"], "support_email": settings["support_email"]}


@router.get("/platform/status")
def platform_status(_: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    failures = db.scalars(select(HealthCheck).where(HealthCheck.ok.is_(False)).order_by(HealthCheck.id.desc()).limit(20)).all()
    return {
        **status_summary(db),
        "failed_checks": [{"at": dt(f.checked_at), "detail": f.detail} for f in failures],
    }


@router.post("/platform/incidents", status_code=201)
def open_incident(data: IncidentIn, request: Request, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    first = {"at": dt(utcnow()), "status": "investigating", "text": data.text.strip()}
    incident = Incident(title=data.title.strip(), impact=data.impact, updates=json.dumps([first]))
    db.add(incident)
    audit(db, owner, "platform.incident_opened", incident.title, request)
    db.commit()
    return incident_out(incident)


@router.post("/platform/incidents/{incident_id}/updates")
def update_incident(incident_id: int, data: IncidentUpdateIn, owner: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    incident = db.get(Incident, incident_id)
    if not incident:
        raise HTTPException(404, "Incident not found")
    updates = incident_out(incident)["updates"]
    updates.append({"at": dt(utcnow()), "status": data.status, "text": data.text.strip()})
    incident.updates = json.dumps(updates)
    incident.status = data.status
    incident.resolved_at = utcnow() if data.status == "resolved" else None
    db.commit()
    return incident_out(incident)


@router.delete("/platform/incidents/{incident_id}", status_code=204)
def delete_incident(incident_id: int, _: User = Depends(require_platform_admin), db: Session = Depends(get_db)):
    incident = db.get(Incident, incident_id)
    if incident:
        db.delete(incident)
        db.commit()
