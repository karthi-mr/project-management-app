"""Project automation rules.

A rule has one trigger, optional conditions and one action:

  triggers  issue_created          an issue is created
            status_changed         an issue moves into a given status (or any status)
            due_soon               an open issue is due in N days (checked by the scheduler)
            feature_done           every issue linked to a feature is finished
  conditions  type, priority       only issues of that type / priority
  actions   assign                 set the assignee
            set_priority           set the priority
            set_status             move the issue to a status
            add_label              add a label
            comment                post a comment (as the rule)
            notify                 notify the assignee, the reporter, the watchers or a person
            feature_stage          move the feature to a stage (feature_done only)

Actions taken by rules never trigger other rules, so rules cannot loop.
"""
import json
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import (
    Activity,
    AutomationRule,
    AutomationRun,
    Comment,
    Feature,
    Issue,
    Notification,
    Project,
    User,
    Watch,
    utcnow,
)
from .workflow import status_keys, status_meta

TRIGGERS = ("issue_created", "status_changed", "due_soon", "feature_done")
ACTIONS = ("assign", "set_priority", "set_status", "add_label", "comment", "notify", "feature_stage")
PRIORITIES = ("low", "medium", "high", "urgent")
TYPES = ("task", "bug", "story", "epic")
FEATURE_STAGES = ("proposed", "planned", "design", "development", "testing", "deployment", "released")


def parse(rule: AutomationRule) -> dict:
    try:
        return json.loads(rule.config or "{}")
    except ValueError:
        return {}


def validate(project: Project, trigger: str, config: dict) -> dict:
    """Check a rule definition and return a cleaned copy. Raises ValueError with a readable message."""
    if trigger not in TRIGGERS:
        raise ValueError("Unknown trigger")
    clean: dict = {"conditions": {}, "action": {}}
    if trigger == "status_changed":
        status = config.get("status") or ""
        if status and status not in status_keys(project):
            raise ValueError("That status is not part of this project's workflow")
        clean["status"] = status
    if trigger == "due_soon":
        days = config.get("days", 1)
        if not isinstance(days, int) or not 0 <= days <= 30:
            raise ValueError("Choose between 0 and 30 days")
        clean["days"] = days
    conditions = config.get("conditions") or {}
    if conditions.get("type"):
        if conditions["type"] not in TYPES:
            raise ValueError("Unknown issue type")
        clean["conditions"]["type"] = conditions["type"]
    if conditions.get("priority"):
        if conditions["priority"] not in PRIORITIES:
            raise ValueError("Unknown priority")
        clean["conditions"]["priority"] = conditions["priority"]

    action = config.get("action") or {}
    kind = action.get("type")
    if kind not in ACTIONS:
        raise ValueError("Choose what the rule should do")
    if (kind == "feature_stage") != (trigger == "feature_done"):
        raise ValueError(
            "“Move the feature” only works with the “all feature issues done” trigger, "
            "and that trigger only supports moving the feature or notifying someone"
            if kind == "feature_stage"
            else "When every issue of a feature is done, the rule can move the feature or notify someone"
        )
    if trigger == "feature_done" and kind not in ("feature_stage", "notify"):
        raise ValueError("When every issue of a feature is done, the rule can move the feature or notify someone")
    clean["action"]["type"] = kind
    member_ids = {m.id for m in project.members} | ({project.owner_id} if project.owner_id else set())
    if kind == "assign":
        user_id = action.get("user_id")
        if user_id is not None and user_id not in member_ids:
            raise ValueError("The assignee must be a member of the project")
        clean["action"]["user_id"] = user_id
    elif kind == "set_priority":
        if action.get("value") not in PRIORITIES:
            raise ValueError("Choose a priority")
        clean["action"]["value"] = action["value"]
    elif kind == "set_status":
        if action.get("value") not in status_keys(project):
            raise ValueError("Choose a status from this project's workflow")
        clean["action"]["value"] = action["value"]
    elif kind == "add_label":
        label = str(action.get("value") or "").replace(",", " ").strip().lower()[:30]
        if not label:
            raise ValueError("Enter the label to add")
        clean["action"]["value"] = label
    elif kind == "comment":
        text = str(action.get("value") or "").strip()[:2000]
        if not text:
            raise ValueError("Enter the comment text")
        clean["action"]["value"] = text
    elif kind == "notify":
        target = action.get("target")
        if target not in ("assignee", "reporter", "watchers", "owner") and target not in member_ids:
            raise ValueError("Choose who to notify")
        clean["action"]["target"] = target
        clean["action"]["value"] = str(action.get("value") or "").strip()[:300]
    elif kind == "feature_stage":
        if action.get("value") not in FEATURE_STAGES:
            raise ValueError("Choose a feature stage")
        clean["action"]["value"] = action["value"]
    return clean


# ───────────── Running rules ─────────────


def _log(db: Session, issue: Issue | None, project_id: int, rule: AutomationRule, message: str) -> None:
    db.add(
        Activity(
            project_id=project_id,
            issue_id=issue.id if issue else None,
            user_id=None,
            message=f"⚡ {rule.name}: {message}"[:500],
        )
    )


def _notify(db: Session, user_ids, rule: AutomationRule, message: str, project_id: int, issue_id=None, feature_id=None):
    for user_id in {u for u in user_ids if u}:
        db.add(
            Notification(
                user_id=user_id,
                message=f"⚡ {rule.name}: {message}"[:500],
                project_id=project_id,
                issue_id=issue_id,
                feature_id=feature_id,
            )
        )
        db.info.setdefault("notify_users", set()).add(user_id)


def _matches(issue: Issue, config: dict) -> bool:
    conditions = config.get("conditions") or {}
    if conditions.get("type") and issue.type != conditions["type"]:
        return False
    if conditions.get("priority") and issue.priority != conditions["priority"]:
        return False
    return True


def _apply_issue_action(db: Session, rule: AutomationRule, config: dict, issue: Issue) -> None:
    project = issue.project
    action = config["action"]
    ref = f"{project.key}-{issue.number}"
    kind = action["type"]
    if kind == "assign":
        target = action.get("user_id")
        if target != issue.assignee_id:
            issue.assignee_id = target
            who = db.get(User, target) if target else None
            _log(db, issue, project.id, rule, f"assigned to {who.full_name}" if who else "removed the assignee")
            if who:
                _notify(db, [who.id], rule, f"assigned you {ref} “{issue.title}”", project.id, issue.id)
    elif kind == "set_priority" and issue.priority != action["value"]:
        issue.priority = action["value"]
        _log(db, issue, project.id, rule, f"set priority to {action['value']}")
    elif kind == "set_status" and issue.status != action["value"] and action["value"] in status_keys(project):
        issue.status = action["value"]
        issue.completed_at = utcnow() if issue.status == "done" else None
        _log(db, issue, project.id, rule, f"moved to {status_meta(project, issue.status)['label']}")
    elif kind == "add_label":
        labels = [l for l in issue.labels.split(",") if l]
        if action["value"] not in labels and len(labels) < 9:
            issue.labels = ",".join(labels + [action["value"]])
            _log(db, issue, project.id, rule, f"added the label “{action['value']}”")
    elif kind == "comment":
        db.add(Comment(issue_id=issue.id, author_id=None, body=action["value"]))
        _log(db, issue, project.id, rule, "added a comment")
    elif kind == "notify":
        target = action["target"]
        if target == "assignee":
            users = [issue.assignee_id]
        elif target == "reporter":
            users = [issue.reporter_id]
        elif target == "owner":
            users = [project.owner_id]
        elif target == "watchers":
            users = list(db.scalars(select(Watch.user_id).where(Watch.issue_id == issue.id)))
        else:
            users = [target]
        message = action.get("value") or f"{ref} “{issue.title}” needs your attention"
        _notify(db, users, rule, f"{message} ({ref})", project.id, issue.id)
    issue.updated_at = utcnow()


def _record(rule: AutomationRule) -> None:
    rule.runs = (rule.runs or 0) + 1
    rule.last_run_at = utcnow()


def _rules(db: Session, project_id: int, trigger: str) -> list[AutomationRule]:
    from .saas import has_feature

    project = db.get(Project, project_id)
    if project is None or not has_feature(db, project.org_id, "automation"):
        return []  # rules are kept but paused while the plan does not include automation
    return list(
        db.scalars(
            select(AutomationRule).where(
                AutomationRule.project_id == project_id,
                AutomationRule.trigger == trigger,
                AutomationRule.enabled.is_(True),
            ).order_by(AutomationRule.id)
        )
    )


def on_issue_created(db: Session, issue: Issue) -> None:
    for rule in _rules(db, issue.project_id, "issue_created"):
        config = parse(rule)
        if config.get("action") and _matches(issue, config):
            _apply_issue_action(db, rule, config, issue)
            _record(rule)


def on_status_changed(db: Session, issue: Issue, old_status: str) -> None:
    for rule in _rules(db, issue.project_id, "status_changed"):
        config = parse(rule)
        wanted = config.get("status")
        if config.get("action") and (not wanted or wanted == issue.status) and _matches(issue, config):
            _apply_issue_action(db, rule, config, issue)
            _record(rule)
    if issue.status == "done" and old_status != "done" and issue.feature_id:
        _check_feature_done(db, issue)


def _check_feature_done(db: Session, issue: Issue) -> None:
    feature = db.get(Feature, issue.feature_id)
    if not feature or not feature.issues or any(i.status != "done" for i in feature.issues):
        return
    project = issue.project
    for rule in _rules(db, project.id, "feature_done"):
        config = parse(rule)
        action = config.get("action") or {}
        if action.get("type") == "feature_stage" and feature.stage != action.get("value"):
            from . import signoff

            if signoff.gated(db, project):
                # Stages need a human sign-off here, so the rule asks for one instead of moving it.
                if signoff.next_stage("feature", feature.stage) and not signoff.pending_for(db, "feature", feature.id):
                    try:
                        signoff.request(db, project, None, "feature", feature, f"Requested by the rule “{rule.name}”: every issue is done.")
                        _record(rule)
                    except Exception:  # the stage checklist is not complete yet
                        pass
                continue
            feature.stage = action["value"]
            feature.updated_at = utcnow()
            _log(db, None, project.id, rule, f"moved feature “{feature.title}” to {feature.stage}")
            watchers = list(db.scalars(select(Watch.user_id).where(Watch.feature_id == feature.id)))
            _notify(db, [feature.owner_id, *watchers], rule, f"moved feature “{feature.title}” to {feature.stage}", project.id, feature_id=feature.id)
            _record(rule)
        elif action.get("type") == "notify":
            target = action.get("target")
            users = (
                [feature.owner_id] if target in ("assignee", "reporter")
                else [project.owner_id] if target == "owner"
                else list(db.scalars(select(Watch.user_id).where(Watch.feature_id == feature.id))) if target == "watchers"
                else [target]
            )
            message = action.get("value") or f"every issue of feature “{feature.title}” is done"
            _notify(db, users, rule, message, project.id, feature_id=feature.id)
            _record(rule)


def run_scheduled(db: Session) -> int:
    """Due-date reminders. Each issue is reminded once per due date per rule."""
    applied = 0
    today = date.today()
    for rule in db.scalars(
        select(AutomationRule).where(AutomationRule.trigger == "due_soon", AutomationRule.enabled.is_(True))
    ).all():
        config = parse(rule)
        if not config.get("action"):
            continue
        target_day = today + timedelta(days=int(config.get("days", 1)))
        issues = db.scalars(
            select(Issue).where(
                Issue.project_id == rule.project_id,
                Issue.status != "done",
                Issue.due_date.is_not(None),
                Issue.due_date <= target_day,
                Issue.due_date >= today,
            )
        ).all()
        for issue in issues:
            if not _matches(issue, config):
                continue
            try:
                with db.begin_nested():
                    db.add(AutomationRun(rule_id=rule.id, issue_id=issue.id, marker=issue.due_date.isoformat()))
            except IntegrityError:
                continue  # already reminded for this due date
            _apply_issue_action(db, rule, config, issue)
            _record(rule)
            applied += 1
    db.commit()
    return applied
