"""Uploads, per-project workflows and custom fields, time entries and timesheets."""
import json
import secrets
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Feature, Issue, Project, ProjectField, StoredFile, TimeEntry, User, utcnow
from ..saas import has_feature, require_feature
from ..security import get_current_user
from ..serializers import user_brief
from ..workflow import COLOR, MAX_STATUSES, project_statuses, slugify
from .issues import _get_issue
from .projects import can_manage, get_project, log_activity, visible_projects_query

router = APIRouter(prefix="/api", tags=["workspace"])

# ───────────── Image uploads ─────────────

MAX_UPLOAD = 5 * 1024 * 1024
FILE_URL = "/api/files/"


def sniff_image(data: bytes) -> str | None:
    """Identify the image type from its first bytes; the browser-supplied type is not trusted."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def valid_file_url(url: str | None) -> bool:
    return url is None or (url.startswith(FILE_URL) and len(url) <= 200 and "/" not in url[len(FILE_URL):])


@router.post("/files", status_code=201)
async def upload_file(
    request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Upload one image as the raw request body. Returns the URL to use in <img> or Markdown."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD:
        raise HTTPException(413, "Images can be at most 5 MB")
    data = await request.body()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "Images can be at most 5 MB")
    content_type = sniff_image(data)
    if not content_type:
        raise HTTPException(415, "Only PNG, JPEG, GIF and WebP images can be uploaded")
    stored = StoredFile(
        key=secrets.token_urlsafe(24),
        content_type=content_type,
        size=len(data),
        data=data,
        uploader_id=user.id,
    )
    db.add(stored)
    db.commit()
    return {"url": f"{FILE_URL}{stored.key}", "content_type": content_type, "size": stored.size}


@router.get("/files/{key}")
def read_file(key: str, db: Session = Depends(get_db)):
    # The key is a long random token, so the URL itself is the permission (an <img> tag
    # cannot send the sign-in header).
    stored = db.scalar(select(StoredFile).where(StoredFile.key == key))
    if not stored:
        raise HTTPException(404, "File not found")
    return Response(
        content=stored.data,
        media_type=stored.content_type,
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "inline",
            "Content-Security-Policy": "default-src 'none'",
        },
    )


# ───────────── Workflow (custom issue statuses) ─────────────


class StatusIn(BaseModel):
    key: str | None = Field(default=None, max_length=20)
    label: str = Field(min_length=1, max_length=30)
    color: str = Field(pattern=COLOR.pattern)


class WorkflowIn(BaseModel):
    statuses: list[StatusIn] = Field(min_length=2, max_length=MAX_STATUSES)


@router.put("/projects/{project_id}/workflow")
def update_workflow(
    project_id: int,
    data: WorkflowIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, manage=True)
    require_feature(db, user, "customization")
    current = {s["key"] for s in project_statuses(project)}
    taken: set[str] = set()
    statuses: list[dict] = []
    for item in data.statuses:
        label = item.label.strip()
        key = item.key if item.key in current and item.key not in taken else slugify(label, taken | current)
        taken.add(key)
        statuses.append({"key": key, "label": label, "color": item.color})
    if sum(1 for s in statuses if s["key"] == "done") != 1:
        raise HTTPException(422, "The workflow must keep its final “done” status")
    if len({s["label"].lower() for s in statuses}) != len(statuses):
        raise HTTPException(422, "Status names must be different from each other")
    # Completed work stays last so boards read left to right.
    statuses.sort(key=lambda s: s["key"] == "done")

    removed = current - {s["key"] for s in statuses}
    moved = 0
    if removed:
        fallback = next(s["key"] for s in statuses if s["key"] != "done")
        for issue in project.issues:
            if issue.status in removed:
                issue.status = fallback
                moved += 1
    project.workflow = json.dumps(statuses)
    log_activity(
        db, project.id, user,
        "changed the issue workflow" + (f" ({moved} issue(s) moved to {statuses[0]['label']})" if moved else ""),
    )
    db.commit()
    return {"statuses": statuses, "moved": moved}


@router.delete("/projects/{project_id}/workflow")
def reset_workflow(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    project = get_project(db, project_id, user, manage=True)
    project.workflow = None
    keys = {s["key"] for s in project_statuses(project)}
    moved = 0
    for issue in project.issues:
        if issue.status not in keys:
            issue.status = "todo"
            moved += 1
    log_activity(db, project.id, user, "reset the issue workflow to the default")
    db.commit()
    return {"statuses": project_statuses(project), "moved": moved}


# ───────────── Custom fields ─────────────

FieldType = Literal["text", "number", "date", "select", "checkbox"]


class FieldIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    type: FieldType = "text"
    options: list[str] = Field(default=[], max_length=30)


class FieldUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    options: list[str] | None = Field(default=None, max_length=30)


def field_out(f: ProjectField) -> dict:
    return {
        "id": f.id,
        "name": f.name,
        "type": f.type,
        "options": json.loads(f.options) if f.options else [],
    }


def _clean_options(options: list[str]) -> str:
    cleaned = list(dict.fromkeys(o.strip()[:60] for o in options if o.strip()))
    return json.dumps(cleaned)


@router.get("/projects/{project_id}/fields")
def list_fields(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return [field_out(f) for f in get_project(db, project_id, user).fields]


@router.post("/projects/{project_id}/fields", status_code=201)
def create_field(
    project_id: int,
    data: FieldIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, manage=True)
    require_feature(db, user, "customization")
    if len(project.fields) >= 20:
        raise HTTPException(422, "A project can have at most 20 custom fields")
    if data.type == "select" and not [o for o in data.options if o.strip()]:
        raise HTTPException(422, "A choice field needs at least one option")
    field = ProjectField(
        project_id=project.id,
        name=data.name.strip(),
        type=data.type,
        options=_clean_options(data.options) if data.type == "select" else "",
        position=max((f.position for f in project.fields), default=0) + 1,
    )
    db.add(field)
    db.commit()
    return field_out(field)


def _get_field(db: Session, field_id: int, user: User) -> ProjectField:
    field = db.get(ProjectField, field_id)
    if not field:
        raise HTTPException(404, "Field not found")
    get_project(db, field.project_id, user, manage=True)
    return field


@router.patch("/fields/{field_id}")
def update_field(
    field_id: int,
    data: FieldUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    field = _get_field(db, field_id, user)
    if data.name is not None:
        field.name = data.name.strip()
    if data.options is not None and field.type == "select":
        field.options = _clean_options(data.options)
    db.commit()
    return field_out(field)


@router.delete("/fields/{field_id}", status_code=204)
def delete_field(
    field_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    field = _get_field(db, field_id, user)
    key = str(field.id)
    for issue in db.scalars(select(Issue).where(Issue.project_id == field.project_id)):
        if issue.custom and key in issue.custom:
            values = json.loads(issue.custom)
            values.pop(key, None)
            issue.custom = json.dumps(values) if values else ""
    db.delete(field)
    db.commit()


def clean_custom_values(project: Project, incoming: dict, current: dict) -> dict:
    """Validate {field id: value} against the project's field definitions and merge into current."""
    fields = {str(f.id): f for f in project.fields}
    result = {k: v for k, v in current.items() if k in fields}
    for raw_key, value in incoming.items():
        field = fields.get(str(raw_key))
        if not field:
            raise HTTPException(422, "Unknown custom field")
        key = str(field.id)
        if value is None or value == "":
            result.pop(key, None)
            continue
        if field.type == "number":
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(422, f"{field.name} must be a number")
        elif field.type == "checkbox":
            value = bool(value)
            if not value:
                result.pop(key, None)
                continue
        elif field.type == "date":
            try:
                value = date.fromisoformat(str(value)).isoformat()
            except ValueError:
                raise HTTPException(422, f"{field.name} must be a date")
        elif field.type == "select":
            if value not in (json.loads(field.options) if field.options else []):
                raise HTTPException(422, f"“{value}” is not an option for {field.name}")
        else:
            value = str(value)[:500]
        result[key] = value
    return result


# ───────────── Time entries and timesheets ─────────────


class TimeIn(BaseModel):
    day: date
    hours: float = Field(gt=0, le=24)
    note: str = Field(default="", max_length=300)


def time_out(t: TimeEntry) -> dict:
    return {
        "id": t.id,
        "issue_id": t.issue_id,
        "feature_id": t.feature_id,
        "user": user_brief(t.user),
        "day": t.day.isoformat(),
        "hours": t.hours,
        "note": t.note,
    }


def _recalculate(db: Session, issue: Issue) -> None:
    total = db.scalar(select(func.sum(TimeEntry.hours)).where(TimeEntry.issue_id == issue.id))
    issue.spent_hours = round(total, 2) if total else None


@router.get("/issues/{issue_id}/time")
def list_time(issue_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    issue = _get_issue(db, issue_id, user)
    require_feature(db, user, "time_tracking")
    entries = sorted(issue.time_entries, key=lambda t: (t.day, t.id), reverse=True)
    return [time_out(t) for t in entries]


@router.post("/issues/{issue_id}/time", status_code=201)
def log_time(
    issue_id: int,
    data: TimeIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    issue = _get_issue(db, issue_id, user)
    require_feature(db, user, "time_tracking")
    if data.day > date.today() + timedelta(days=1):
        raise HTTPException(422, "Time cannot be logged for a future date")
    entry = TimeEntry(
        issue_id=issue.id, user_id=user.id, day=data.day, hours=round(data.hours, 2),
        note=data.note.strip(), rate=user.hourly_rate,  # keep the rate at the time, for budgets
    )
    db.add(entry)
    db.flush()
    _recalculate(db, issue)
    issue.updated_at = utcnow()
    log_activity(db, issue.project_id, user, f"logged {entry.hours:g}h", issue.id)
    db.commit()
    return time_out(entry)


def _get_feature(db: Session, feature_id: int, user: User) -> Feature:
    feature = db.get(Feature, feature_id)
    if not feature:
        raise HTTPException(404, "Feature not found")
    get_project(db, feature.project_id, user, section="features")
    return feature


def feature_time(db: Session, feature: Feature, user: User) -> dict:
    """Time on a feature: logged on it directly, plus everything logged on its issues. The cost is
    shown only to people who may see budgets, because it reveals hourly rates."""
    from .delivery import entry_rate

    direct = sorted(db.scalars(select(TimeEntry).where(TimeEntry.feature_id == feature.id)).all(), key=lambda t: (t.day, t.id), reverse=True)
    on_issues = db.scalars(
        select(TimeEntry).join(Issue, TimeEntry.issue_id == Issue.id).where(Issue.feature_id == feature.id)
    ).all()
    project = feature.project
    see_cost = (user.role == "admin" or project.owner_id == user.id) and has_feature(db, project.org_id, "budgets")
    result = {
        "entries": [time_out(t) for t in direct],
        "direct_hours": round(sum(t.hours for t in direct), 2),
        "issue_hours": round(sum(t.hours for t in on_issues), 2),
    }
    result["total_hours"] = round(result["direct_hours"] + result["issue_hours"], 2)
    if see_cost:
        priced = [(t.hours, entry_rate(t)) for t in [*direct, *on_issues]]
        result["cost"] = round(sum(h * r for h, r in priced if r is not None), 2)
        result["unpriced_hours"] = round(sum(h for h, r in priced if r is None), 2)
        result["currency"] = project.currency or "USD"
    return result


@router.get("/features/{feature_id}/time")
def list_feature_time(feature_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    feature = _get_feature(db, feature_id, user)
    require_feature(db, user, "time_tracking")
    return feature_time(db, feature, user)


@router.post("/features/{feature_id}/time", status_code=201)
def log_feature_time(feature_id: int, data: TimeIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Work on the feature itself that is not one of its issues: design, analysis, reviews, meetings."""
    feature = _get_feature(db, feature_id, user)
    require_feature(db, user, "time_tracking")
    get_project(db, feature.project_id, user, section="features", write=True)
    if data.day > date.today() + timedelta(days=1):
        raise HTTPException(422, "Time cannot be logged for a future date")
    entry = TimeEntry(
        feature_id=feature.id, user_id=user.id, day=data.day, hours=round(data.hours, 2),
        note=data.note.strip(), rate=user.hourly_rate,
    )
    db.add(entry)
    feature.updated_at = utcnow()
    log_activity(db, feature.project_id, user, f"logged {entry.hours:g}h on feature “{feature.title}”")
    db.commit()
    return time_out(entry)


@router.delete("/time/{entry_id}", status_code=204)
def delete_time(entry_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    entry = db.get(TimeEntry, entry_id)
    if not entry:
        raise HTTPException(404, "Time entry not found")
    if entry.feature_id is not None:
        feature = _get_feature(db, entry.feature_id, user)
        if entry.user_id != user.id and not can_manage(feature.project, user):
            raise HTTPException(403, "You can only remove your own time entries")
        db.delete(entry)
        db.commit()
        return
    issue = _get_issue(db, entry.issue_id, user)
    if entry.user_id != user.id and not can_manage(issue.project, user):
        raise HTTPException(403, "You can only remove your own time entries")
    db.delete(entry)
    db.flush()
    _recalculate(db, issue)
    db.commit()


@router.get("/timesheet")
def timesheet(
    start: date,
    end: date,
    user_id: int | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Time logged between two dates. Everyone sees their own; administrators can view anyone's."""
    require_feature(db, user, "time_tracking")
    if end < start or (end - start).days > 92:
        raise HTTPException(422, "Choose a range of at most three months")
    target = user.id if user_id is None else user_id
    if target != user.id and user.role != "admin":
        raise HTTPException(403, "Only administrators can view other people's timesheets")
    if target != user.id and db.get(User, target) is None:
        raise HTTPException(404, "User not found")
    visible = [p.id for p in db.scalars(visible_projects_query(user)).all()]
    from .delivery import time_entries_query

    entries = db.scalars(
        time_entries_query(visible)
        .where(TimeEntry.user_id == target, TimeEntry.day >= start, TimeEntry.day <= end)
        .order_by(TimeEntry.day, TimeEntry.id)
    ).all()

    def where(t: TimeEntry) -> dict:
        if t.issue is not None:
            project = t.issue.project
            return {"issue_key": f"{project.key}-{t.issue.number}", "issue_title": t.issue.title, "feature_title": None, "project": project}
        project = t.feature.project
        return {"issue_key": None, "issue_title": None, "feature_title": t.feature.title, "project": project}

    rows = []
    for t in entries:
        info = where(t)
        project = info.pop("project")
        rows.append({**time_out(t), **info, "project_id": project.id, "project_name": project.name, "project_color": project.color})
    return rows


def import_legacy_time(db: Session) -> None:
    """One-off: turn the old single 'spent hours' number into a time entry so nothing is lost."""
    issues = db.scalars(
        select(Issue).where(Issue.spent_hours.is_not(None), Issue.spent_hours > 0)
    ).all()
    created = False
    for issue in issues:
        if issue.time_entries:
            continue
        db.add(
            TimeEntry(
                issue_id=issue.id,
                user_id=issue.assignee_id or issue.reporter_id,
                day=issue.updated_at.date(),
                hours=min(issue.spent_hours, 10000),
                note="Carried over from the previous time field",
            )
        )
        created = True
    if created:
        db.commit()
