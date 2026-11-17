import json
from datetime import datetime

from .models import (
    Activity,
    Comment,
    Feature,
    Issue,
    Milestone,
    PasswordResetRequest,
    Project,
    Release,
    User,
)


def dt(value: datetime | None) -> str | None:
    return value.isoformat(timespec="seconds") + "Z" if value else None

from .workflow import project_statuses, status_meta


def _json(raw: str | None, fallback):
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except ValueError:
        return fallback


def user_brief(u: User | None) -> dict | None:
    if not u:
        return None
    return {
        "id": u.id,
        "username": u.username,
        "full_name": u.full_name,
        "avatar_color": u.avatar_color,
        "avatar_url": u.avatar_url,
    }


def user_full(u: User) -> dict:
    return {
        **user_brief(u),
        "email": u.email,
        "role": u.role,
        "org_id": u.org_id,
        "is_platform_admin": bool(u.is_platform_admin),
        "is_active": u.is_active,
        "must_change_password": u.must_change_password,
        "created_at": dt(u.created_at),
        "last_login": dt(u.last_login),
        "preferences": _json(u.preferences, {}),
        "hourly_rate": u.hourly_rate,
        "weekly_capacity": u.weekly_capacity if u.weekly_capacity is not None else 40,
    }


def project_out(p: Project) -> dict:
    total = len(p.issues)
    done = sum(1 for i in p.issues if i.status == "done")
    return {
        "id": p.id,
        "name": p.name,
        "key": p.key,
        "description": p.description,
        "status": p.status,
        "phase": p.phase,
        "color": p.color,
        "logo_url": p.logo_url,
        "currency": p.currency or "USD",
        "statuses": project_statuses(p),
        "fields": [
            {"id": f.id, "name": f.name, "type": f.type, "options": _json(f.options, [])}
            for f in p.fields
        ],
        "start_date": p.start_date.isoformat() if p.start_date else None,
        "due_date": p.due_date.isoformat() if p.due_date else None,
        "owner": user_brief(p.owner),
        "members": [user_brief(m) for m in p.members],
        "issue_count": total,
        "done_count": done,
        "open_count": total - done,
        "progress": round(done * 100 / total) if total else 0,
        "created_at": dt(p.created_at),
    }


def _lifecycle(target_type: str, obj) -> dict:
    """Next stage and any sign-off waiting, for a feature or milestone."""
    from sqlalchemy.orm import object_session

    from . import signoff

    db = object_session(obj)
    if db is None or obj.id is None:
        return {"next_stage": signoff.next_stage(target_type, obj.stage), "signoff": None, "last_signoff": None}
    return signoff.state(db, target_type, obj)


def milestone_out(m: Milestone) -> dict:
    total = len(m.issues)
    done = sum(1 for i in m.issues if i.status == "done")
    return {
        "id": m.id,
        "project_id": m.project_id,
        "name": m.name,
        "description": m.description,
        "start_date": m.start_date.isoformat() if m.start_date else None,
        "due_date": m.due_date.isoformat() if m.due_date else None,
        "status": m.status,
        "stage": m.stage,
        "features": [{"id": f.id, "title": f.title, "stage": f.stage} for f in sorted(m.features, key=lambda f: f.id)],
        **_lifecycle("milestone", m),
        "issue_count": total,
        "done_count": done,
        "progress": round(done * 100 / total) if total else 0,
    }


def issue_ref(i: Issue) -> dict:
    return {
        "id": i.id,
        "key": f"{i.project.key}-{i.number}",
        "title": i.title,
        "status": i.status,
        "due_date": i.due_date.isoformat() if i.due_date else None,
    }


def issue_out(i: Issue) -> dict:
    return {
        "id": i.id,
        "key": f"{i.project.key}-{i.number}",
        "project_id": i.project_id,
        "project_name": i.project.name,
        "project_color": i.project.color,
        "title": i.title,
        "description": i.description,
        "type": i.type,
        "status": i.status,
        "status_label": status_meta(i.project, i.status)["label"],
        "status_color": status_meta(i.project, i.status)["color"],
        "priority": i.priority,
        "assignee": user_brief(i.assignee),
        "reporter": user_brief(i.reporter),
        "milestone_id": i.milestone_id,
        "milestone_name": i.milestone.name if i.milestone else None,
        "feature_id": i.feature_id,
        "feature_title": i.feature.title if i.feature else None,
        "start_date": i.start_date.isoformat() if i.start_date else None,
        "due_date": i.due_date.isoformat() if i.due_date else None,
        "estimate_hours": i.estimate_hours,
        "spent_hours": i.spent_hours,
        "blocked_by": [issue_ref(b) for b in i.blocked_by],
        "blocking": [issue_ref(b) for b in i.blocking],
        "labels": [l for l in i.labels.split(",") if l],
        "recurrence": i.recurrence,
        "sprint_id": i.sprint_id,
        "sprint_name": i.sprint.name if i.sprint else None,
        "custom": _json(i.custom, {}),
        "checklist_total": len(i.checklist),
        "checklist_done": sum(1 for c in i.checklist if c.done),
        "position": i.position,
        "comment_count": len(i.comments),
        "created_at": dt(i.created_at),
        "updated_at": dt(i.updated_at),
        "completed_at": dt(i.completed_at),
    }


def comment_out(c: Comment) -> dict:
    return {
        "id": c.id,
        "issue_id": c.issue_id,
        "author": user_brief(c.author),
        "body": c.body,
        "created_at": dt(c.created_at),
    }


def activity_out(a: Activity) -> dict:
    return {
        "id": a.id,
        "project_id": a.project_id,
        "project_name": a.project.name,
        "issue_id": a.issue_id,
        "issue_key": f"{a.project.key}-{a.issue.number}" if a.issue else None,
        "user": user_brief(a.user),
        "message": a.message,
        "created_at": dt(a.created_at),
    }


def reset_request_out(r: PasswordResetRequest) -> dict:
    return {
        "id": r.id,
        "user": user_brief(r.user),
        "email": r.user.email,
        "note": r.note,
        "status": r.status,
        "created_at": dt(r.created_at),
        "resolved_at": dt(r.resolved_at),
    }


def feature_out(f: Feature) -> dict:
    total = len(f.issues)
    done = sum(1 for i in f.issues if i.status == "done")
    return {
        "id": f.id,
        "project_id": f.project_id,
        "title": f.title,
        "description": f.description,
        "acceptance_criteria": f.acceptance_criteria,
        "stage": f.stage,
        **_lifecycle("feature", f),
        "priority": f.priority,
        "owner": user_brief(f.owner),
        "release_id": f.release_id,
        "release_version": f.release.version if f.release else None,
        "milestone_id": f.milestone_id,
        "milestone_name": f.milestone.name if f.milestone else None,
        "start_date": f.start_date.isoformat() if f.start_date else None,
        "target_date": f.target_date.isoformat() if f.target_date else None,
        "issue_count": total,
        "done_count": done,
        "progress": round(done * 100 / total) if total else 0,
        "created_at": dt(f.created_at),
        "updated_at": dt(f.updated_at),
    }


def release_out(r: Release) -> dict:
    return {
        "id": r.id,
        "project_id": r.project_id,
        "version": r.version,
        "environment": r.environment,
        "status": r.status,
        "planned_date": r.planned_date.isoformat() if r.planned_date else None,
        "deployed_at": dt(r.deployed_at),
        "notes": r.notes,
        "features": [{"id": f.id, "title": f.title, "stage": f.stage} for f in r.features],
        "created_at": dt(r.created_at),
    }
