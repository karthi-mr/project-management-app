import calendar
import json
import re
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..access import section_filter
from ..database import get_db
from ..trash import soft_delete
from .. import automation
from ..models import Activity, ChecklistItem, Comment, Feature, Issue, Milestone, Project, Sprint, User, utcnow
from ..security import get_current_user
from ..workflow import DEFAULT_STATUSES, default_status, status_keys, status_meta
from ..serializers import activity_out, comment_out, issue_out, project_out, user_brief
from .projects import can_manage, get_project, log_activity, notify, visible_projects_query


def watch(*args, **kwargs):  # late import: delivery imports this module
    from .delivery import watch as _watch

    return _watch(*args, **kwargs)


def notify_watchers(*args, **kwargs):
    from .delivery import notify_watchers as _notify_watchers

    return _notify_watchers(*args, **kwargs)


router = APIRouter(prefix="/api", tags=["issues"])

IssueType = Literal["task", "bug", "story", "epic"]
IssuePriority = Literal["low", "medium", "high", "urgent"]
Recurrence = Literal["", "daily", "weekly", "monthly"]
MENTION = re.compile(r"(?<![\w@])@([a-z0-9._-]{3,50})", re.IGNORECASE)
PRIORITIES = ["urgent", "high", "medium", "low"]


class IssueCreate(BaseModel):
    project_id: int
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)
    type: IssueType = "task"
    status: str | None = Field(default=None, max_length=20)  # None = the workflow default
    priority: IssuePriority = "medium"
    assignee_id: int | None = None
    milestone_id: int | None = None
    feature_id: int | None = None
    start_date: date | None = None
    due_date: date | None = None
    estimate_hours: float | None = Field(default=None, ge=0, le=10000)
    labels: list[str] = []
    recurrence: Recurrence = ""
    sprint_id: int | None = None
    checklist: list[str] = Field(default=[], max_length=30)  # sub-tasks, e.g. from a template


class IssueUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20000)
    type: IssueType | None = None
    status: str | None = Field(default=None, max_length=20)
    priority: IssuePriority | None = None
    custom: dict | None = None
    assignee_id: int | None = None
    milestone_id: int | None = None
    feature_id: int | None = None
    start_date: date | None = None
    due_date: date | None = None
    estimate_hours: float | None = Field(default=None, ge=0, le=10000)
    blocked_by_ids: list[int] | None = None
    labels: list[str] | None = None
    recurrence: Recurrence | None = None
    sprint_id: int | None = None
    position: float | None = None


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=10000)


def _clean_labels(labels: list[str]) -> str:
    seen: list[str] = []
    for raw in labels:
        label = raw.replace(",", " ").strip().lower()[:30]
        if label and label not in seen:
            seen.append(label)
    return ",".join(seen[:9])  # 9 labels of 30 characters fit the 300-character column


def _check_assignee(project: Project, assignee_id: int | None):
    if assignee_id is None:
        return
    if all(m.id != assignee_id for m in project.members) and project.owner_id != assignee_id:
        raise HTTPException(422, "Assignee must be a member of the project")


def _check_milestone(db: Session, project: Project, milestone_id: int | None):
    if milestone_id is None:
        return
    milestone = db.get(Milestone, milestone_id)
    if not milestone or milestone.project_id != project.id:
        raise HTTPException(422, "Milestone does not belong to this project")


def _shift(day: date | None, recurrence: str) -> date | None:
    if day is None:
        return None
    if recurrence == "daily":
        return day + timedelta(days=1)
    if recurrence == "weekly":
        return day + timedelta(days=7)
    year, month = (day.year + 1, 1) if day.month == 12 else (day.year, day.month + 1)
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def _spawn_next_occurrence(db: Session, issue: Issue, user: User) -> Issue:
    """A recurring issue was completed: create the next one and hand the recurrence on to it."""
    project = issue.project
    recurrence = issue.recurrence
    due = _shift(issue.due_date or date.today(), recurrence)
    # Never schedule the next occurrence in the past.
    while due < date.today():
        due = _shift(due, recurrence)
    start = None
    if issue.start_date and issue.due_date:
        start = due - (issue.due_date - issue.start_date)
    project.issue_counter += 1
    max_pos = db.scalar(
        select(func.max(Issue.position)).where(
            Issue.project_id == project.id, Issue.status == default_status(project)
        )
    )
    nxt = Issue(
        project_id=project.id,
        number=project.issue_counter,
        title=issue.title,
        description=issue.description,
        type=issue.type,
        status=default_status(project),
        priority=issue.priority,
        assignee_id=issue.assignee_id,
        reporter_id=issue.reporter_id,
        milestone_id=issue.milestone_id,
        feature_id=issue.feature_id,
        start_date=start,
        due_date=due,
        estimate_hours=issue.estimate_hours,
        labels=issue.labels,
        recurrence=recurrence,
        position=(max_pos or 0) + 1000,
    )
    nxt.checklist = [ChecklistItem(text=c.text) for c in issue.checklist]
    db.add(nxt)
    issue.recurrence = ""
    db.flush()
    log_activity(db, project.id, user, f"created the next {recurrence} occurrence", nxt.id)
    notify(
        db, nxt.assignee_id, user,
        f"completed a recurring issue; the next one is {project.key}-{nxt.number} “{nxt.title}”",
        project.id, nxt.id,
    )
    return nxt


def _check_sprint(db: Session, project: Project, sprint_id: int | None):
    if sprint_id is None:
        return
    sprint = db.get(Sprint, sprint_id)
    if not sprint or sprint.project_id != project.id:
        raise HTTPException(422, "Sprint does not belong to this project")
    if sprint.status == "completed":
        raise HTTPException(422, "That sprint is already completed")


def _check_feature(db: Session, project: Project, feature_id: int | None):
    if feature_id is None:
        return
    feature = db.get(Feature, feature_id)
    if not feature or feature.project_id != project.id:
        raise HTTPException(422, "Feature does not belong to this project")


def _resolve_dependencies(db: Session, issue: Issue, ids: list[int]) -> list[Issue]:
    """Validate the issues this one depends on: same project, no self reference, no cycles."""
    blockers: list[Issue] = []
    for dep_id in dict.fromkeys(ids):
        dep = db.get(Issue, dep_id)
        if not dep or dep.project_id != issue.project_id:
            raise HTTPException(422, "Dependencies must be issues in the same project")
        if dep.id == issue.id:
            raise HTTPException(422, "An issue cannot depend on itself")
        # Walk upstream from the blocker; reaching this issue would close a loop.
        stack, seen = [dep], set()
        while stack:
            node = stack.pop()
            if node.id == issue.id:
                raise HTTPException(
                    422, f"{dep.project.key}-{dep.number} already depends on this issue (circular dependency)"
                )
            if node.id not in seen:
                seen.add(node.id)
                stack.extend(node.blocked_by)
        blockers.append(dep)
    return blockers


def schedule_items(projects: list[Project], start: date, end: date, allowed=None) -> list[dict]:
    """Every dated deadline between start and end inclusive.

    allowed(project, section) limits the result to what the caller may see in each project.
    """
    allowed = allowed or (lambda project, section: True)
    items: list[dict] = []
    for p in projects:
        base = {"project_id": p.id, "project_name": p.name, "project_key": p.key, "color": p.color}
        if p.due_date and start <= p.due_date <= end:
            items.append({
                **base, "kind": "project", "id": p.id, "title": f"{p.name} deadline",
                "date": p.due_date.isoformat(), "done": p.status in ("completed", "archived"),
            })
        for m in p.milestones if allowed(p, "milestones") else []:
            if m.due_date and start <= m.due_date <= end:
                items.append({
                    **base, "kind": "milestone", "id": m.id, "title": m.name,
                    "date": m.due_date.isoformat(), "done": m.status == "closed",
                })
        for f in p.features if allowed(p, "features") else []:
            if f.target_date and start <= f.target_date <= end:
                items.append({
                    **base, "kind": "feature", "id": f.id, "title": f.title,
                    "date": f.target_date.isoformat(), "done": f.stage == "released",
                })
        for r in p.releases if allowed(p, "releases") else []:
            if r.planned_date and start <= r.planned_date <= end:
                items.append({
                    **base, "kind": "release", "id": r.id,
                    "title": f"Release {r.version} ({r.environment})",
                    "date": r.planned_date.isoformat(), "done": r.status == "deployed",
                })
        for i in p.issues if allowed(p, "issues") else []:
            if i.due_date and start <= i.due_date <= end:
                items.append({
                    **base, "kind": "issue", "id": i.id, "title": i.title,
                    "key": f"{p.key}-{i.number}", "date": i.due_date.isoformat(),
                    "done": i.status == "done", "priority": i.priority, "type": i.type,
                    "assignee": user_brief(i.assignee),
                })
    order = {"project": 0, "release": 1, "milestone": 2, "feature": 3, "issue": 4}
    items.sort(key=lambda x: (x["date"], order[x["kind"]], x["title"].lower()))
    return items


@router.get("/issues/key/{key}")
def issue_by_key(key: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Find an issue by its key (APP-12), for links typed in chat."""
    import re as _re

    m = _re.fullmatch(r"([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})", key.strip())
    if not m:
        raise HTTPException(404, "Issue not found")
    project = db.scalar(select(Project).where(func.upper(Project.key) == m.group(1).upper()))
    issue = db.scalar(select(Issue).where(Issue.project_id == project.id, Issue.number == int(m.group(2)))) if project else None
    if issue is None:
        raise HTTPException(404, "Issue not found")
    return issue_out(_get_issue(db, issue.id, user))


def _get_issue(db: Session, issue_id: int, user: User) -> Issue:
    issue = db.get(Issue, issue_id)
    if not issue:
        raise HTTPException(404, "Issue not found")
    get_project(db, issue.project_id, user, section="issues")
    return issue


def _label(value: str) -> str:
    return value.replace("_", " ")


@router.get("/issues")
def list_issues(
    project_id: int | None = None,
    assignee_id: int | None = None,
    mine: bool = False,
    status: str | None = Query(default=None, max_length=20),
    priority: IssuePriority | None = None,
    type: IssueType | None = None,
    milestone_id: int | None = None,
    feature_id: int | None = None,
    sprint_id: int | None = None,  # 0 = issues in no sprint (the backlog)
    open_only: bool = False,
    q: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=500, ge=1, le=1000),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Issue).join(Project)
    if project_id is not None:
        get_project(db, project_id, user, section="issues")
        stmt = stmt.where(Issue.project_id == project_id)
    else:
        allowed = section_filter(db, user)
        visible = [
            p.id for p in db.scalars(visible_projects_query(user)).all() if allowed(p, "issues")
        ]
        stmt = stmt.where(Issue.project_id.in_(visible))
    if mine:
        stmt = stmt.where(Issue.assignee_id == user.id)
    elif assignee_id is not None:
        stmt = stmt.where(Issue.assignee_id == assignee_id)
    if status:
        stmt = stmt.where(Issue.status == status)
    if priority:
        stmt = stmt.where(Issue.priority == priority)
    if type:
        stmt = stmt.where(Issue.type == type)
    if milestone_id is not None:
        stmt = stmt.where(Issue.milestone_id == milestone_id)
    if feature_id is not None:
        stmt = stmt.where(Issue.feature_id == feature_id)
    if sprint_id is not None:
        stmt = stmt.where(Issue.sprint_id == sprint_id) if sprint_id else stmt.where(Issue.sprint_id.is_(None))
    if open_only:
        stmt = stmt.where(Issue.status != "done")
    if q and q.strip():
        term = q.strip()
        like = f"%{term}%"
        conds = [Issue.title.ilike(like), Issue.description.ilike(like), Issue.labels.ilike(like)]
        if "-" in term:
            key, _, num = term.rpartition("-")
            if num.isdigit():
                conds.append((func.upper(Project.key) == key.upper()) & (Issue.number == int(num)))
        stmt = stmt.where(or_(*conds))
    stmt = stmt.order_by(Issue.position, Issue.id).limit(limit)
    return [issue_out(i) for i in db.scalars(stmt).all()]


@router.post("/issues", status_code=201)
def create_issue(
    data: IssueCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    project = get_project(db, data.project_id, user, section="issues")
    if data.start_date and data.due_date and data.due_date < data.start_date:
        raise HTTPException(422, "Due date cannot be before the start date")
    _check_assignee(project, data.assignee_id)
    _check_milestone(db, project, data.milestone_id)
    _check_feature(db, project, data.feature_id)
    _check_sprint(db, project, data.sprint_id)
    status = data.status or default_status(project)
    if status not in status_keys(project):
        raise HTTPException(422, "That status is not part of this project's workflow")

    project.issue_counter += 1
    max_pos = db.scalar(
        select(func.max(Issue.position)).where(
            Issue.project_id == project.id, Issue.status == status
        )
    )
    issue = Issue(
        project_id=project.id,
        number=project.issue_counter,
        title=data.title.strip(),
        description=data.description,
        type=data.type,
        status=status,
        priority=data.priority,
        assignee_id=data.assignee_id,
        reporter_id=user.id,
        milestone_id=data.milestone_id,
        feature_id=data.feature_id,
        start_date=data.start_date,
        due_date=data.due_date,
        estimate_hours=data.estimate_hours,
        labels=_clean_labels(data.labels),
        recurrence=data.recurrence,
        sprint_id=data.sprint_id,
        position=(max_pos or 0) + 1000,
        completed_at=utcnow() if status == "done" else None,
    )
    db.add(issue)
    db.flush()
    log_activity(db, project.id, user, f"created {issue.type} “{issue.title}”", issue.id)
    for text in data.checklist:
        if text.strip():
            db.add(ChecklistItem(issue_id=issue.id, text=text.strip()[:300]))
    watch(db, user.id, issue_id=issue.id)
    watch(db, issue.assignee_id, issue_id=issue.id)
    db.flush()
    automation.on_issue_created(db, issue)
    notify(
        db, issue.assignee_id, user,
        f"assigned you {project.key}-{issue.number} “{issue.title}”", project.id, issue.id,
    )
    db.commit()
    return issue_out(issue)


@router.get("/issues/{issue_id}")
def read_issue(
    issue_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    issue = _get_issue(db, issue_id, user)
    activity = db.scalars(
        select(Activity)
        .where(Activity.issue_id == issue.id)
        .order_by(Activity.created_at.desc(), Activity.id.desc())
        .limit(50)
    ).all()
    return {
        **issue_out(issue),
        "comments": [comment_out(c) for c in issue.comments],
        "checklist": [{"id": c.id, "text": c.text, "done": c.done} for c in issue.checklist],
        "activity": [activity_out(a) for a in activity],
    }


@router.patch("/issues/{issue_id}")
def update_issue(
    issue_id: int,
    data: IssueUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    issue = _get_issue(db, issue_id, user)
    project = issue.project
    fields = data.model_dump(exclude_unset=True)
    # These columns are not nullable; ignore explicit nulls.
    for name in ("title", "description", "type", "status", "priority", "labels", "position", "recurrence"):
        if name in fields and fields[name] is None:
            del fields[name]

    old_status = issue.status
    old_assignee = issue.assignee_id
    changes: list[str] = []
    if "recurrence" in fields and fields["recurrence"] != issue.recurrence:
        issue.recurrence = fields["recurrence"]
        changes.append(f"set to repeat {issue.recurrence}" if issue.recurrence else "stopped repeating")
    if "title" in fields and fields["title"].strip() != issue.title:
        issue.title = fields["title"].strip()
        changes.append("renamed the issue")
    if "description" in fields and fields["description"] != issue.description:
        issue.description = fields["description"]
        changes.append("updated the description")
    for name in ("type", "priority"):
        if name in fields and fields[name] != getattr(issue, name):
            changes.append(f"changed {name} from {getattr(issue, name)} to {fields[name]}")
            setattr(issue, name, fields[name])
    if "status" in fields and fields["status"] != issue.status:
        if fields["status"] not in status_keys(project):
            raise HTTPException(422, "That status is not part of this project's workflow")
        changes.append(
            f"moved from {status_meta(project, issue.status)['label']} "
            f"to {status_meta(project, fields['status'])['label']}"
        )
        issue.status = fields["status"]
        issue.completed_at = utcnow() if issue.status == "done" else None
        if "position" not in fields:
            max_pos = db.scalar(
                select(func.max(Issue.position)).where(
                    Issue.project_id == project.id, Issue.status == issue.status
                )
            )
            issue.position = (max_pos or 0) + 1000
    if "position" in fields:
        issue.position = fields["position"]
    if "assignee_id" in fields and fields["assignee_id"] != issue.assignee_id:
        _check_assignee(project, fields["assignee_id"])
        issue.assignee_id = fields["assignee_id"]
        who = db.get(User, issue.assignee_id) if issue.assignee_id else None
        changes.append(f"assigned to {who.full_name}" if who else "removed the assignee")
        notify(
            db, issue.assignee_id, user,
            f"assigned you {project.key}-{issue.number} “{issue.title}”", project.id, issue.id,
        )
    if "milestone_id" in fields and fields["milestone_id"] != issue.milestone_id:
        _check_milestone(db, project, fields["milestone_id"])
        issue.milestone_id = fields["milestone_id"]
        changes.append("changed the milestone")
    if "due_date" in fields and fields["due_date"] != issue.due_date:
        issue.due_date = fields["due_date"]
        changes.append(
            f"set due date to {issue.due_date.isoformat()}" if issue.due_date else "cleared the due date"
        )
    if "sprint_id" in fields and fields["sprint_id"] != issue.sprint_id:
        _check_sprint(db, project, fields["sprint_id"])
        issue.sprint_id = fields["sprint_id"]
        sprint = db.get(Sprint, issue.sprint_id) if issue.sprint_id else None
        changes.append(f"added to sprint “{sprint.name}”" if sprint else "removed from the sprint")
    if "feature_id" in fields and fields["feature_id"] != issue.feature_id:
        _check_feature(db, project, fields["feature_id"])
        issue.feature_id = fields["feature_id"]
        changes.append("changed the feature")
    if "start_date" in fields and fields["start_date"] != issue.start_date:
        issue.start_date = fields["start_date"]
        changes.append(
            f"set start date to {issue.start_date.isoformat()}" if issue.start_date else "cleared the start date"
        )
    if issue.start_date and issue.due_date and issue.due_date < issue.start_date:
        raise HTTPException(422, "Due date cannot be before the start date")
    if fields.get("custom") is not None:
        from .workspace import clean_custom_values  # local import: workspace imports this module

        before = json.loads(issue.custom) if issue.custom else {}
        after = clean_custom_values(project, fields["custom"], before)
        if after != before:
            issue.custom = json.dumps(after) if after else ""
            changes.append("updated custom fields")
    if fields.get("blocked_by_ids") is not None:
        blockers = _resolve_dependencies(db, issue, fields["blocked_by_ids"])
        if {b.id for b in blockers} != {b.id for b in issue.blocked_by}:
            issue.blocked_by = blockers
            changes.append("updated dependencies")
    if "estimate_hours" in fields and fields["estimate_hours"] != issue.estimate_hours:
        issue.estimate_hours = fields["estimate_hours"]
        changes.append("updated the estimate")
    if "labels" in fields:
        cleaned = _clean_labels(fields["labels"])
        if cleaned != issue.labels:
            issue.labels = cleaned
            changes.append("updated labels")

    if changes:
        if issue.assignee_id and issue.assignee_id != old_assignee:
            watch(db, issue.assignee_id, issue_id=issue.id)
        ref = f"{project.key}-{issue.number}"
        summary = changes[0] if len(changes) == 1 else f"{changes[0]} (+{len(changes) - 1} more change{'s' if len(changes) > 2 else ''})"
        # The new assignee already got an "assigned you" notification.
        notify_watchers(db, user, f"updated {ref}: {summary}", project.id, issue_id=issue.id,
                        skip={issue.assignee_id} if issue.assignee_id != old_assignee else set())
        if issue.status != old_status:
            db.flush()
            automation.on_status_changed(db, issue, old_status)
    if issue.status == "done" and issue.recurrence and any(c.startswith("moved from") for c in changes):
        _spawn_next_occurrence(db, issue, user)
    if changes:
        issue.updated_at = utcnow()
        for change in changes:
            log_activity(db, project.id, user, change, issue.id)
    db.commit()
    db.refresh(issue)
    return issue_out(issue)


@router.delete("/issues/{issue_id}", status_code=204)
def delete_issue(
    issue_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    issue = _get_issue(db, issue_id, user)
    if not (can_manage(issue.project, user) or issue.reporter_id == user.id):
        raise HTTPException(403, "Only the reporter, project owner or an administrator can delete this issue")
    log_activity(
        db, issue.project_id, user, f"deleted {issue.project.key}-{issue.number} “{issue.title}”"
    )
    soft_delete(issue, user)  # recoverable from the recycle bin for 30 days
    db.commit()


@router.post("/issues/{issue_id}/comments", status_code=201)
def add_comment(
    issue_id: int,
    data: CommentIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    issue = _get_issue(db, issue_id, user)
    comment = Comment(issue_id=issue.id, author_id=user.id, body=data.body.strip())
    db.add(comment)
    issue.updated_at = utcnow()
    log_activity(db, issue.project_id, user, "commented", issue.id)
    watch(db, user.id, issue_id=issue.id)
    ref = f"{issue.project.key}-{issue.number} “{issue.title}”"
    names = {m.lower().rstrip("._-") for m in MENTION.findall(comment.body)}
    mentioned = {m.id for m in issue.project.members if m.username.lower() in names}
    for recipient in mentioned:
        notify(db, recipient, user, f"mentioned you on {ref}", issue.project_id, issue.id)
    direct = ({issue.assignee_id, issue.reporter_id} - mentioned) - {None}
    for recipient in direct:
        notify(db, recipient, user, f"commented on {ref}", issue.project_id, issue.id)
    notify_watchers(db, user, f"commented on {ref}", issue.project_id, issue_id=issue.id, skip=direct | mentioned)
    db.commit()
    return comment_out(comment)


@router.delete("/comments/{comment_id}", status_code=204)
def delete_comment(
    comment_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    comment = db.get(Comment, comment_id)
    if not comment:
        raise HTTPException(404, "Comment not found")
    issue = _get_issue(db, comment.issue_id, user)
    if comment.author_id != user.id and not can_manage(issue.project, user):
        raise HTTPException(403, "You can only delete your own comments")
    db.delete(comment)
    db.commit()


@router.get("/schedule")
def schedule(
    start: date,
    end: date,
    project_id: int | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if end < start or (end - start).days > 400:
        raise HTTPException(422, "Choose a range of at most 400 days")
    if project_id is not None:
        projects = [get_project(db, project_id, user)]
    else:
        projects = db.scalars(visible_projects_query(user)).all()
    return schedule_items(
        [p for p in projects if p.status != "archived"], start, end, section_filter(db, user)
    )


def _status_breakdown(issues: list[Issue]) -> list[dict]:
    """Issue counts per status. Projects can have different workflows, so group by label."""
    order: list[str] = []
    rows: dict[str, dict] = {}
    for meta in DEFAULT_STATUSES:
        rows[meta["label"].lower()] = {**meta, "count": 0}
        order.append(meta["label"].lower())
    for issue in issues:
        meta = status_meta(issue.project, issue.status)
        # Completed work is one bucket, whatever a project calls its final status.
        name = "done" if issue.status == "done" else meta["label"].lower()
        if name not in rows:
            rows[name] = {**meta, "count": 0}
            order.insert(len(order) - 1, name)  # custom statuses sit before Done
        rows[name]["count"] += 1
    return [rows[name] for name in order if rows[name]["count"] or name in {m["label"].lower() for m in DEFAULT_STATUSES}]


@router.get("/dashboard")
def dashboard(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    projects = db.scalars(visible_projects_query(user).order_by(Project.name)).all()
    allowed = section_filter(db, user)
    project_ids = [p.id for p in projects]
    issue_project_ids = [p.id for p in projects if allowed(p, "issues")]
    issues = (
        db.scalars(select(Issue).where(Issue.project_id.in_(issue_project_ids))).all()
        if issue_project_ids
        else []
    )
    today = date.today()
    week_ago = utcnow() - timedelta(days=7)
    open_issues = [i for i in issues if i.status != "done"]
    my_open = [i for i in open_issues if i.assignee_id == user.id]

    def due_key(i: Issue):
        return (i.due_date or date.max, PRIORITIES.index(i.priority), i.id)

    recent = (
        db.scalars(
            select(Activity)
            .where(Activity.project_id.in_([p.id for p in projects if allowed(p, "activity")] or [0]))
            .order_by(Activity.created_at.desc(), Activity.id.desc())
            .limit(12)
        ).all()
        if project_ids
        else []
    )

    # Issues completed per day for the last 14 days.
    days = [today - timedelta(days=n) for n in range(13, -1, -1)]
    completed_by_day = {d: 0 for d in days}
    created_by_day = {d: 0 for d in days}
    for i in issues:
        if i.completed_at and i.completed_at.date() in completed_by_day:
            completed_by_day[i.completed_at.date()] += 1
        if i.created_at.date() in created_by_day:
            created_by_day[i.created_at.date()] += 1

    return {
        "stats": {
            "projects": len([p for p in projects if p.status not in ("completed", "archived")]),
            "open_issues": len(open_issues),
            "my_open_issues": len(my_open),
            "overdue": len([i for i in open_issues if i.due_date and i.due_date < today]),
            "completed_this_week": len(
                [i for i in issues if i.completed_at and i.completed_at >= week_ago]
            ),
        },
        "by_status": _status_breakdown(issues),
        "by_priority": [
            {"key": p, "count": len([i for i in open_issues if i.priority == p])}
            for p in PRIORITIES
        ],
        "trend": [
            {
                "date": d.isoformat(),
                "created": created_by_day[d],
                "completed": completed_by_day[d],
            }
            for d in days
        ],
        "my_issues": [issue_out(i) for i in sorted(my_open, key=due_key)[:8]],
        "deadlines": [
            d
            for d in schedule_items(
                [p for p in projects if p.status != "archived"],
                today - timedelta(days=365),
                today + timedelta(days=14),
                allowed,
            )
            if not d["done"]
        ][:10],
        "projects": [project_out(p) for p in projects if p.status != "archived"][:8],
        "activity": [activity_out(a) for a in recent],
    }
