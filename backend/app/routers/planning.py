"""Features (what the project delivers), releases (deployments) and notifications."""
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from ..access import section_filter
from ..database import get_db
from ..trash import soft_delete
from ..models import (
    Feature,
    Issue,
    Milestone,
    Notification,
    PasswordResetRequest,
    Project,
    Release,
    Risk,
    User,
    Approval,
    project_members,
    utcnow,
)
from ..security import get_current_user
from ..serializers import dt, feature_out, issue_out, release_out
from .projects import can_manage, get_project, log_activity, notify

router = APIRouter(prefix="/api", tags=["planning"])

FeatureStage = Literal[
    "proposed", "planned", "design", "development", "testing", "deployment", "released"
]
STAGES = ["proposed", "planned", "design", "development", "testing", "deployment", "released"]
Priority = Literal["low", "medium", "high", "urgent"]
Environment = Literal["development", "staging", "production"]
ReleaseStatus = Literal["planned", "in_progress", "deployed", "failed", "rolled_back"]


class FeatureCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)
    acceptance_criteria: str = Field(default="", max_length=20000)
    stage: FeatureStage = "planned"
    priority: Priority = "medium"
    owner_id: int | None = None
    release_id: int | None = None
    milestone_id: int | None = None
    start_date: date | None = None
    target_date: date | None = None


class FeatureUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20000)
    acceptance_criteria: str | None = Field(default=None, max_length=20000)
    stage: FeatureStage | None = None
    priority: Priority | None = None
    owner_id: int | None = None
    release_id: int | None = None
    milestone_id: int | None = None
    start_date: date | None = None
    target_date: date | None = None


class ReleaseCreate(BaseModel):
    version: str = Field(min_length=1, max_length=60)
    environment: Environment = "production"
    status: ReleaseStatus = "planned"
    planned_date: date | None = None
    notes: str = Field(default="", max_length=20000)
    feature_ids: list[int] = []


class ReleaseUpdate(BaseModel):
    version: str | None = Field(default=None, min_length=1, max_length=60)
    environment: Environment | None = None
    status: ReleaseStatus | None = None
    planned_date: date | None = None
    notes: str | None = Field(default=None, max_length=20000)
    feature_ids: list[int] | None = None


def _label(value: str) -> str:
    return value.replace("_", " ")


def _check_owner(project: Project, owner_id: int | None):
    if owner_id is None:
        return
    if all(m.id != owner_id for m in project.members) and project.owner_id != owner_id:
        raise HTTPException(422, "Owner must be a member of the project")


def _check_milestone(db: Session, project: Project, milestone_id: int | None):
    if milestone_id is not None:
        from ..models import Milestone

        milestone = db.get(Milestone, milestone_id)
        if not milestone or milestone.project_id != project.id:
            raise HTTPException(422, "Milestone not found in this project")


def _check_release(db: Session, project: Project, release_id: int | None):
    if release_id is None:
        return
    release = db.get(Release, release_id)
    if not release or release.project_id != project.id:
        raise HTTPException(422, "Release does not belong to this project")


def _check_dates(start: date | None, end: date | None):
    if start and end and end < start:
        raise HTTPException(422, "Target date cannot be before the start date")


def _get_feature(db: Session, feature_id: int, user: User) -> Feature:
    feature = db.get(Feature, feature_id)
    if not feature:
        raise HTTPException(404, "Feature not found")
    get_project(db, feature.project_id, user, section="features")
    return feature


def _get_release(db: Session, release_id: int, user: User) -> Release:
    release = db.get(Release, release_id)
    if not release:
        raise HTTPException(404, "Release not found")
    get_project(db, release.project_id, user, section="releases")
    return release


# ───────────── Features ─────────────


@router.get("/projects/{project_id}/features")
def list_features(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    project = get_project(db, project_id, user, section="features")
    ordered = sorted(
        project.features,
        key=lambda f: (STAGES.index(f.stage), f.target_date or date.max, f.id),
    )
    return [feature_out(f) for f in ordered]


@router.post("/projects/{project_id}/features", status_code=201)
def create_feature(
    project_id: int,
    data: FeatureCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, section="features")
    _check_owner(project, data.owner_id)
    _check_release(db, project, data.release_id)
    _check_milestone(db, project, data.milestone_id)
    _check_dates(data.start_date, data.target_date)
    from .. import signoff

    if not signoff.initial_stage_allowed(db, project, user, "feature", data.stage):
        raise HTTPException(409, "New features start as proposed or planned. Later stages need a sign-off.")
    feature = Feature(project_id=project.id, **data.model_dump())
    feature.title = feature.title.strip()
    db.add(feature)
    db.flush()
    log_activity(db, project.id, user, f"added feature “{feature.title}”")
    signoff.sync_milestones(db, project, [feature.milestone_id], user)
    from .delivery import watch

    watch(db, user.id, feature_id=feature.id)
    watch(db, feature.owner_id, feature_id=feature.id)
    notify(
        db, feature.owner_id, user, f"made you the owner of feature “{feature.title}”",
        project.id, feature_id=feature.id,
    )
    db.commit()
    return feature_out(feature)


@router.get("/features/{feature_id}")
def read_feature(
    feature_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    feature = _get_feature(db, feature_id, user)
    issues = sorted(feature.issues, key=lambda i: (i.status == "done", i.id))
    can_see_issues = section_filter(db, user)(feature.project, "issues")
    return {**feature_out(feature), "issues": [issue_out(i) for i in issues] if can_see_issues else []}


@router.patch("/features/{feature_id}")
def update_feature(
    feature_id: int,
    data: FeatureUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    feature = _get_feature(db, feature_id, user)
    project = feature.project
    fields = data.model_dump(exclude_unset=True)
    for name in ("title", "description", "acceptance_criteria", "stage", "priority"):
        if name in fields and fields[name] is None:
            del fields[name]

    if "owner_id" in fields and fields["owner_id"] != feature.owner_id:
        _check_owner(project, fields["owner_id"])
        notify(
            db, fields["owner_id"], user, f"made you the owner of feature “{feature.title}”",
            project.id, feature_id=feature.id,
        )
    if "release_id" in fields:
        _check_release(db, project, fields["release_id"])
    old_milestone_id = feature.milestone_id
    if "milestone_id" in fields:
        _check_milestone(db, project, fields["milestone_id"])
    new_stage = fields.pop("stage", None)
    if new_stage and new_stage != feature.stage:
        from .. import signoff
        from .delivery import notify_watchers

        # Enforces the lifecycle: one stage at a time, signed off by the owner or a manager.
        signoff.change_stage(db, project, user, "feature", feature, new_stage)
        notify_watchers(db, user, f"moved feature “{feature.title}” to {feature.stage}", project.id,
                        feature_id=feature.id, skip={feature.owner_id})
    for name, value in fields.items():
        setattr(feature, name, value.strip() if name == "title" else value)
    _check_dates(feature.start_date, feature.target_date)
    feature.updated_at = utcnow()
    if feature.milestone_id != old_milestone_id:
        from .. import signoff

        db.flush()
        # Both the milestone it left and the one it joined follow their features.
        signoff.sync_milestones(db, project, [old_milestone_id, feature.milestone_id], user)
    db.commit()
    return feature_out(feature)


@router.delete("/features/{feature_id}", status_code=204)
def delete_feature(
    feature_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    feature = _get_feature(db, feature_id, user)
    if not (can_manage(feature.project, user) or feature.owner_id == user.id):
        raise HTTPException(403, "Only the feature owner, project owner or an administrator can delete this")
    log_activity(db, feature.project_id, user, f"deleted feature “{feature.title}”")
    soft_delete(feature, user)  # recoverable from the recycle bin for 30 days
    db.commit()


# ───────────── Releases ─────────────


def _set_release_features(db: Session, release: Release, feature_ids: list[int]):
    features = (
        db.scalars(
            select(Feature).where(
                Feature.id.in_(feature_ids), Feature.project_id == release.project_id
            )
        ).all()
        if feature_ids
        else []
    )
    if len(features) != len(set(feature_ids)):
        raise HTTPException(422, "Every feature must belong to this project")
    release.features = list(features)


def _mark_deployed(db: Session, release: Release, user: User):
    release.deployed_at = utcnow()
    shipped = [f for f in release.features if f.stage != "released"]
    from .. import signoff

    # With sign-offs on, a release only finishes features that have been signed off up to deployment.
    if signoff.gated(db, release.project):
        shipped = []  # each feature reaches "released" through its own approved sign-off
    if release.environment == "production":
        for feature in shipped:
            feature.stage = "released"
            feature.updated_at = utcnow()
            db.flush()
            signoff.sync_milestones(db, release.project, [feature.milestone_id], user)
            notify(
                db, feature.owner_id, user,
                f"released feature “{feature.title}” in {release.version}",
                release.project_id, feature_id=feature.id,
            )
    log_activity(
        db, release.project_id, user, f"deployed {release.version} to {release.environment}"
    )


@router.get("/projects/{project_id}/releases")
def list_releases(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    project = get_project(db, project_id, user, section="releases")
    ordered = sorted(
        project.releases,
        key=lambda r: (r.status == "deployed", r.planned_date or date.max, -r.id),
    )
    return [release_out(r) for r in ordered]


@router.post("/projects/{project_id}/releases", status_code=201)
def create_release(
    project_id: int,
    data: ReleaseCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_project(db, project_id, user, section="releases")
    release = Release(
        project_id=project.id,
        version=data.version.strip(),
        environment=data.environment,
        status=data.status,
        planned_date=data.planned_date,
        notes=data.notes,
    )
    db.add(release)
    db.flush()
    _set_release_features(db, release, data.feature_ids)
    log_activity(db, project.id, user, f"planned release {release.version}")
    if release.status == "deployed":
        _mark_deployed(db, release, user)
    db.commit()
    return release_out(release)


@router.patch("/releases/{release_id}")
def update_release(
    release_id: int,
    data: ReleaseUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    release = _get_release(db, release_id, user)
    fields = data.model_dump(exclude_unset=True)
    for name in ("version", "environment", "status", "notes", "feature_ids"):
        if name in fields and fields[name] is None:
            del fields[name]
    if "feature_ids" in fields:
        _set_release_features(db, release, fields.pop("feature_ids"))
    old_status = release.status
    for name, value in fields.items():
        setattr(release, name, value.strip() if name == "version" else value)
    if release.status != old_status:
        if release.status == "deployed":
            _mark_deployed(db, release, user)
        else:
            if old_status == "deployed":
                release.deployed_at = None
            log_activity(
                db, release.project_id, user,
                f"marked release {release.version} as {_label(release.status)}",
            )
    db.commit()
    return release_out(release)


@router.delete("/releases/{release_id}", status_code=204)
def delete_release(
    release_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    release = _get_release(db, release_id, user)
    if not can_manage(release.project, user):
        raise HTTPException(403, "Only the project owner or an administrator can delete a release")
    log_activity(db, release.project_id, user, f"deleted release {release.version}")
    soft_delete(release, user)  # recoverable from the recycle bin for 30 days
    db.commit()


# ───────────── Notifications ─────────────

SOON_DAYS = 3
SEVERITY_ORDER = {"overdue": 0, "today": 1, "soon": 2, "info": 3}


def pending_items(db: Session, user: User) -> list[dict]:
    """Things that need this user's attention right now. Computed live, never stored."""
    today = date.today()
    horizon = today + timedelta(days=SOON_DAYS)

    def severity(day: date) -> str:
        return "overdue" if day < today else "today" if day == today else "soon"

    def base(project: Project) -> dict:
        return {"project_id": project.id, "project_name": project.name, "color": project.color}

    closed = ("completed", "archived")
    items: list[dict] = []

    # Issues assigned to me that are late or due shortly.
    issues = db.scalars(
        select(Issue).where(
            Issue.assignee_id == user.id,
            Issue.status != "done",
            Issue.due_date.is_not(None),
            Issue.due_date <= horizon,
        )
    ).all()
    for i in issues:
        if i.project.status in closed:
            continue
        items.append({
            **base(i.project), "kind": "issue", "id": i.id,
            "title": f"{i.project.key}-{i.number} {i.title}",
            "date": i.due_date.isoformat(), "severity": severity(i.due_date),
        })

    # Features I own.
    features = db.scalars(
        select(Feature).where(
            Feature.owner_id == user.id,
            Feature.stage != "released",
            Feature.target_date.is_not(None),
            Feature.target_date <= horizon,
        )
    ).all()
    for f in features:
        if f.project.status in closed:
            continue
        items.append({
            **base(f.project), "kind": "feature", "id": f.id, "title": f.title,
            "date": f.target_date.isoformat(), "severity": severity(f.target_date),
        })

    # Deadlines on projects I belong to.
    my_projects = db.scalars(
        select(Project).where(
            Project.status.not_in(closed),
            or_(
                Project.owner_id == user.id,
                Project.id.in_(
                    select(project_members.c.project_id).where(
                        project_members.c.user_id == user.id
                    )
                ),
            ),
        )
    ).all()
    allowed = section_filter(db, user)
    for p in my_projects:
        if p.due_date and p.due_date <= horizon:
            items.append({
                **base(p), "kind": "project", "id": p.id, "title": f"{p.name} deadline",
                "date": p.due_date.isoformat(), "severity": severity(p.due_date),
            })
        for m in p.milestones if allowed(p, "milestones") else []:
            if m.status == "open" and m.due_date and m.due_date <= horizon:
                items.append({
                    **base(p), "kind": "milestone", "id": m.id, "title": m.name,
                    "date": m.due_date.isoformat(), "severity": severity(m.due_date),
                })
        for r in p.releases if allowed(p, "releases") else []:
            if r.status in ("planned", "in_progress") and r.planned_date and r.planned_date <= horizon:
                items.append({
                    **base(p), "kind": "release", "id": r.id,
                    "title": f"Release {r.version} to {r.environment}",
                    "date": r.planned_date.isoformat(), "severity": severity(r.planned_date),
                })
            if r.status == "failed":
                items.append({
                    **base(p), "kind": "release", "id": r.id,
                    "title": f"Release {r.version} failed and needs attention",
                    "date": None, "severity": "overdue",
                })

    risks = db.scalars(
        select(Risk).where(Risk.owner_id == user.id, Risk.status.in_(("open", "occurred")))
    ).all()
    score = {"low": 1, "medium": 2, "high": 3}
    for r in risks:
        if r.project.status in closed:
            continue
        review_due = r.review_date is not None and r.review_date <= horizon
        high = score[r.probability] * score[r.impact] >= 6
        if r.status == "occurred" or high or review_due:
            items.append({
                **base(r.project), "kind": "risk", "id": r.id,
                "title": ("Risk has occurred: " if r.status == "occurred" else "High risk: " if high else "Review risk: ") + r.title,
                "date": r.review_date.isoformat() if review_due else None,
                "severity": "overdue" if r.status == "occurred" else severity(r.review_date) if review_due else "info",
            })

    from .. import signoff

    for approval in db.scalars(select(Approval).where(Approval.status == "pending")).all():
        if approval.project is None:
            continue
        # Addressed to me, or open to the owner and managers of a project where I am one.
        if not signoff.may_decide(db, approval.project, approval, user):
            continue
        waited = (utcnow() - approval.created_at).days
        late = waited >= (approval.project.signoff_remind_days or 2)
        items.append({
            **base(approval.project), "kind": "approval", "id": approval.id,
            "title": (f"Overdue {waited} days: " if late else "Approval requested: ") + approval.title,
            "date": None, "severity": "overdue" if late else "today",
        })

    if user.role == "admin":
        waiting = db.scalars(
            select(PasswordResetRequest)
            .join(User, PasswordResetRequest.user_id == User.id)
            .where(PasswordResetRequest.status == "pending", User.org_id == user.org_id)
        ).all()
        if waiting:
            count = len(waiting)
            items.append({
                "kind": "reset", "id": 0, "project_id": None, "project_name": None,
                "color": "#f59e0b", "date": None, "severity": "info",
                "title": f"{count} password reset request{'' if count == 1 else 's'} waiting",
            })

    if user.role == "admin":
        from ..saas import GRACE_WARNING_DAYS, get_org, license_status

        org = get_org(db, user)
        state = license_status(org)
        days = (org.valid_until.date() - today).days if org.valid_until else None
        notice = None
        if state == "suspended":
            notice = ("This workspace is suspended", "overdue")
        elif state == "expired":
            notice = ("Your license has expired — the workspace is read-only", "overdue")
        elif days is not None and days <= GRACE_WARNING_DAYS:
            what = "free trial" if org.is_trial else "license"
            notice = (f"Your {what} ends {'today' if days == 0 else f'in {days} day' + ('' if days == 1 else 's')}", "today" if days <= 2 else "soon")
        if notice:
            items.append({
                "kind": "license", "id": 0, "project_id": None, "project_name": None, "color": "#f59e0b",
                "date": None, "severity": notice[1], "title": notice[0],
            })
    if user.is_platform_admin:
        from ..models import LicenseRequest

        waiting = db.scalar(select(func.count()).select_from(LicenseRequest).where(LicenseRequest.status == "pending"))
        if waiting:
            items.append({
                "kind": "platform", "id": 0, "project_id": None, "project_name": None, "color": "#6366f1",
                "date": None, "severity": "today",
                "title": f"{waiting} license request{'' if waiting == 1 else 's'} waiting for activation",
            })

    items.sort(key=lambda x: (SEVERITY_ORDER[x["severity"]], x["date"] or "", x["title"].lower()))
    return items


@router.get("/notifications")
def notifications(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    pending = pending_items(db, user)
    updates = db.scalars(
        select(Notification)
        .where(Notification.user_id == user.id)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(30)
    ).all()
    unread = sum(1 for n in updates if not n.is_read)
    return {
        "pending": pending,
        "updates": [
            {
                "id": n.id,
                "message": n.message,
                "project_id": n.project_id,
                "issue_id": n.issue_id,
                "feature_id": n.feature_id,
                "is_read": n.is_read,
                "created_at": dt(n.created_at),
            }
            for n in updates
        ],
        "unread": unread,
        "count": len(pending) + unread,
    }


@router.post("/notifications/read-all")
def mark_all_read(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.is_read.is_(False))
        .values(is_read=True)
    )
    db.commit()
    return {"ok": True}


@router.post("/notifications/{notification_id}/read")
def mark_read(
    notification_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    note = db.get(Notification, notification_id)
    if not note or note.user_id != user.id:
        raise HTTPException(404, "Notification not found")
    note.is_read = True
    db.commit()
    return {"ok": True}
