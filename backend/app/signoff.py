"""The gated lifecycle of features and milestones.

Every feature and every milestone moves through its stages one at a time. A stage is finished
only when it has been signed off by the project owner or one of the project's managers (any one
of them is enough); the sign-off moves the item on to the next stage. Nobody can skip a stage.

Moving an item back (rework) needs no sign-off, but only the owner or a manager can do it.
The rule can be switched off per project, and is off when the plan has no approvals.
"""
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import (
    Activity, Approval, Feature, Milestone, Notification, Project, SignoffCheck, SignoffCriterion, TestCase, User,
    project_members, utcnow,
)
from .saas import has_feature

FEATURE_STAGES = ("proposed", "planned", "design", "development", "testing", "deployment", "released")
MILESTONE_STAGES = ("planned", "design", "development", "testing", "deployment", "completed")
STAGES = {"feature": FEATURE_STAGES, "milestone": MILESTONE_STAGES}
APPROVER_ROLES = ("manager",)


def gated(db: Session, project: Project) -> bool:
    return bool(project.signoff_required) and has_feature(db, project.org_id, "approvals")


def approvers(db: Session, project: Project) -> list[User]:
    """The people a sign-off request goes to: the owner and the project's managers."""
    manager_ids = set(
        db.scalars(
            select(project_members.c.user_id).where(
                project_members.c.project_id == project.id, project_members.c.role.in_(APPROVER_ROLES)
            )
        )
    )
    people = {m.id: m for m in project.members if m.id in manager_ids and m.is_active}
    if project.owner and project.owner.is_active:
        people[project.owner.id] = project.owner
    return list(people.values())


def is_approver(db: Session, project: Project, user: User) -> bool:
    if user.org_id != project.org_id:
        return False
    if project.owner_id == user.id:
        return True
    role = db.scalar(
        select(project_members.c.role).where(
            project_members.c.project_id == project.id, project_members.c.user_id == user.id
        )
    )
    return role in APPROVER_ROLES


def next_stage(target_type: str, stage: str) -> str | None:
    stages = STAGES[target_type]
    index = stages.index(stage) if stage in stages else 0
    return stages[index + 1] if index + 1 < len(stages) else None


def label(target_type: str, obj) -> str:
    return f"feature “{obj.title}”" if target_type == "feature" else f"milestone “{obj.name}”"


def pending_for(db: Session, target_type: str, target_id: int) -> Approval | None:
    return db.scalar(
        select(Approval).where(
            Approval.kind == "stage", Approval.target_type == target_type,
            Approval.target_id == target_id, Approval.status == "pending",
        ).order_by(Approval.id.desc())
    )


def last_decision(db: Session, target_type: str, target_id: int) -> Approval | None:
    return db.scalar(
        select(Approval).where(
            Approval.kind == "stage", Approval.target_type == target_type,
            Approval.target_id == target_id, Approval.status.in_(("approved", "rejected")),
        ).order_by(Approval.id.desc())
    )


def state(db: Session, target_type: str, obj) -> dict:
    """What the interface needs to draw the lifecycle of one item."""
    pending = pending_for(db, target_type, obj.id)
    last = last_decision(db, target_type, obj.id)
    brief = lambda u: {"id": u.id, "full_name": u.full_name} if u else None  # noqa: E731
    waiting = (utcnow() - pending.created_at).days if pending else 0
    project = obj.project
    return {
        "next_stage": next_stage(target_type, obj.stage),
        "checklist": checklist(db, target_type, obj),
        "feature_gate": _gate_out(obj) if target_type == "milestone" else None,
        "signoff": {
            "id": pending.id, "stage": pending.stage, "to_stage": pending.to_stage,
            "requester": brief(pending.requester), "note": pending.note,
            "approver": brief(pending.approver),
            "created_at": pending.created_at.isoformat(timespec="seconds") + "Z",
            "waiting_days": waiting,
            "overdue": bool(project and waiting >= (project.signoff_remind_days or 2)),
        } if pending else None,
        "last_signoff": {
            "status": last.status, "stage": last.stage, "to_stage": last.to_stage,
            "by": brief(last.approver), "note": last.decision_note,
            "decided_at": last.decided_at.isoformat(timespec="seconds") + "Z" if last.decided_at else None,
        } if last else None,
    }


def _gate_out(milestone) -> dict | None:
    gate = milestone_gate(milestone)
    if not gate:
        return None
    return {"total": gate["total"], "signed_off": gate["signed_off"], "behind": gate["behind"], "at_stage": len(gate["at_stage"])}


AUTO_KINDS = {
    "all_issues_done": "Every linked issue is done",
    "tests_passed": "Every test case has passed",
}


def checklist(db: Session, target_type: str, obj) -> list[dict]:
    """The criteria for the item's current stage, each marked done or not."""
    criteria = db.scalars(
        select(SignoffCriterion).where(
            SignoffCriterion.project_id == obj.project_id, SignoffCriterion.target_type == target_type,
            SignoffCriterion.stage == obj.stage,
        ).order_by(SignoffCriterion.position, SignoffCriterion.id)
    ).all()
    if not criteria:
        return []
    checks = {
        c.criterion_id: c for c in db.scalars(
            select(SignoffCheck).where(SignoffCheck.criterion_id.in_([c.id for c in criteria]), SignoffCheck.target_id == obj.id)
        )
    }
    out = []
    for c in criteria:
        row = {"id": c.id, "text": c.text, "kind": c.kind, "done": False, "by": None, "detail": ""}
        if c.kind == "all_issues_done":
            issues = list(obj.issues)
            open_count = sum(1 for i in issues if i.status != "done")
            row["done"] = bool(issues) and open_count == 0
            row["detail"] = "No issues are linked yet" if not issues else f"{len(issues) - open_count} of {len(issues)} done"
        elif c.kind == "tests_passed":
            cases = db.scalars(select(TestCase).where(TestCase.feature_id == obj.id)).all() if target_type == "feature" else []
            passed = sum(1 for t in cases if t.last_status == "passed")
            row["done"] = bool(cases) and passed == len(cases)
            row["detail"] = "No test cases yet" if not cases else f"{passed} of {len(cases)} passed"
        else:
            check = checks.get(c.id)
            row["done"] = check is not None
            row["by"] = check.checked_by_name if check else None
        out.append(row)
    return out


def require_checklist(db: Session, target_type: str, obj) -> None:
    missing = [c["text"] for c in checklist(db, target_type, obj) if not c["done"]]
    if missing:
        more = f" and {len(missing) - 2} more" if len(missing) > 2 else ""
        raise HTTPException(409, f"The {obj.stage} checklist is not complete yet: {'; '.join(missing[:2])}{more}.")


def clear_checks(db: Session, target_type: str, obj, from_stage_index: int) -> None:
    """When an item goes back, the ticks of the stages it has to redo are removed."""
    stages = STAGES[target_type][from_stage_index:]
    ids = list(db.scalars(
        select(SignoffCriterion.id).where(
            SignoffCriterion.project_id == obj.project_id, SignoffCriterion.target_type == target_type,
            SignoffCriterion.stage.in_(stages),
        )
    ))
    if ids:
        for check in db.scalars(select(SignoffCheck).where(SignoffCheck.criterion_id.in_(ids), SignoffCheck.target_id == obj.id)).all():
            db.delete(check)


def run_reminders(db: Session) -> int:
    """Remind approvers about sign-offs that have waited too long, then escalate. Run by the scheduler."""
    now = utcnow()
    sent = 0
    for approval in db.scalars(select(Approval).where(Approval.status == "pending")).all():
        project = approval.project
        if project is None or project.deleted_at is not None:
            continue
        days = (now - approval.created_at).days
        people = [approvers_ for approvers_ in approvers(db, project)]
        if approval.approver_id:
            people = [p for p in people if p.id == approval.approver_id] or people
        if approval.reminded_at is None and days >= (project.signoff_remind_days or 2):
            approval.reminded_at = now
            _notify(db, [p.id for p in people], None, f"reminder: “{approval.title}” has waited {days} days for a decision", project.id)
            _log(db, project.id, None, f"Reminder sent: “{approval.title}” has waited {days} days")
            sent += 1
        if approval.escalated_at is None and days >= (project.signoff_escalate_days or 5):
            approval.escalated_at = now
            admins = db.scalars(
                select(User.id).where(User.org_id == project.org_id, User.role == "admin", User.is_active).execution_options(all_orgs=True)
            ).all()
            _notify(db, [*admins, project.owner_id, approval.requester_id], None,
                    f"escalation: “{approval.title}” in {project.name} is still waiting after {days} days", project.id)
            _log(db, project.id, None, f"Escalated: “{approval.title}” is still waiting after {days} days")
            sent += 1
    db.commit()
    return sent


def _notify(db: Session, user_ids, actor: User | None, message: str, project_id: int, feature_id: int | None = None):
    name = actor.full_name if actor else "Automation"
    for user_id in {u for u in user_ids if u and (actor is None or u != actor.id)}:
        db.add(Notification(user_id=user_id, message=f"{name} {message}"[:500], project_id=project_id, feature_id=feature_id))
        db.info.setdefault("notify_users", set()).add(user_id)


def _log(db: Session, project_id: int, actor: User | None, message: str):
    db.add(Activity(project_id=project_id, user_id=actor.id if actor else None, message=message[:500]))


# ───────────── Features and their milestone move together ─────────────
#
# A feature can belong to a milestone. The milestone is never ahead of its features:
#   * when every feature of a milestone has been signed off past a stage, the milestone follows
#     automatically (the features' sign-offs are its approval);
#   * signing off the milestone's stage signs off, in one go, the features that are at that stage;
#   * a feature that goes back takes its milestone back, and a milestone that goes back takes
#     its features back.
# A milestone stage corresponds to the feature stage of the same name; "proposed" is before
# "planned", and "released" corresponds to "completed".


def feature_level(feature) -> int:
    """Position of a feature on the milestone scale: proposed = -1, planned = 0 … released = 5."""
    return (FEATURE_STAGES.index(feature.stage) if feature.stage in FEATURE_STAGES else 0) - 1


def linked_features(milestone) -> list:
    return [f for f in milestone.features if f.deleted_at is None]


def milestone_gate(milestone) -> dict | None:
    """How the milestone's features stand against its current stage."""
    features = linked_features(milestone)
    if not features:
        return None
    current = MILESTONE_STAGES.index(milestone.stage) if milestone.stage in MILESTONE_STAGES else 0
    return {
        "total": len(features),
        "signed_off": sum(1 for f in features if feature_level(f) > current),
        "behind": [{"id": f.id, "title": f.title, "stage": f.stage} for f in features if feature_level(f) < current],
        "at_stage": [f for f in features if feature_level(f) == current],
    }


def require_features_ready(milestone) -> None:
    gate = milestone_gate(milestone)
    if gate and gate["behind"]:
        first = gate["behind"][0]
        more = f" and {len(gate['behind']) - 1} more" if len(gate["behind"]) > 1 else ""
        raise HTTPException(409, f"Feature “{first['title']}” is still in {first['stage']}{more}. Sign off the features of this milestone first.")


def _approved_record(db: Session, project: Project, target_type: str, obj, to_stage: str, actor: User | None, note: str) -> None:
    """Every move forward leaves an approved sign-off behind, also the automatic ones."""
    approval = pending_for(db, target_type, obj.id)
    if approval is None or approval.stage != obj.stage:
        approval = Approval(
            project_id=project.id, kind="stage", target_type=target_type, target_id=obj.id, stage=obj.stage,
            to_stage=to_stage, title=f"Sign off {obj.stage} of {label(target_type, obj)}"[:200],
            requester_id=actor.id if actor else None,
        )
        db.add(approval)
    approval.status = "approved"
    approval.approver_id = actor.id if actor else None
    approval.decision_note = note
    approval.decided_at = utcnow()
    db.flush()


def sync_milestones(db: Session, project: Project, milestone_ids, actor: User | None) -> None:
    """Bring milestones in line with their features after a feature moved or was (un)linked."""
    if not gated(db, project):
        return
    for milestone_id in {m for m in milestone_ids if m}:
        milestone = db.get(Milestone, milestone_id)
        if milestone is None or milestone.deleted_at is not None:
            continue
        db.refresh(milestone, ["features"])
        features = linked_features(milestone)
        if not features:
            continue
        target = max(0, min(feature_level(f) for f in features))
        current = MILESTONE_STAGES.index(milestone.stage) if milestone.stage in MILESTONE_STAGES else 0
        while current < target:
            if any(not c["done"] for c in checklist(db, "milestone", milestone)):
                break  # the milestone's own checklist still has open lines; it follows once they are ticked
            to_stage = MILESTONE_STAGES[current + 1]
            _approved_record(db, project, "milestone", milestone, to_stage, actor,
                             "Automatic: every feature of this milestone was signed off")
            set_stage(db, project, "milestone", milestone, to_stage, actor, sync=False)
            current += 1
        if current > target:
            set_stage(db, project, "milestone", milestone, MILESTONE_STAGES[target], actor, sync=False)


def _carry_features_forward(db: Session, project: Project, milestone, from_index: int, actor: User) -> None:
    """A milestone sign-off also signs off the features that were at that stage."""
    for feature in linked_features(milestone):
        if feature_level(feature) == from_index:
            to_stage = FEATURE_STAGES[from_index + 2]
            _approved_record(db, project, "feature", feature, to_stage, actor, f"Signed off together with milestone “{milestone.name}”")
            set_stage(db, project, "feature", feature, to_stage, actor, sync=False)


def _carry_features_back(db: Session, project: Project, milestone, actor: User | None) -> None:
    index = MILESTONE_STAGES.index(milestone.stage)
    for feature in linked_features(milestone):
        if feature_level(feature) > index:
            set_stage(db, project, "feature", feature, FEATURE_STAGES[index + 1], actor, sync=False)


def set_stage(db: Session, project: Project, target_type: str, obj, stage: str, actor: User | None, sync: bool = True) -> None:
    """Put an item in a stage and keep everything that depends on it in step."""
    old = obj.stage
    stages = STAGES[target_type]
    if old in stages and stage in stages and stages.index(stage) < stages.index(old):
        clear_checks(db, target_type, obj, stages.index(stage))
    obj.stage = stage
    if target_type == "milestone":
        obj.status = "closed" if stage == "completed" else "open"
    else:
        obj.updated_at = utcnow()
    # A request made for the old stage no longer applies.
    stale = pending_for(db, target_type, obj.id)
    if stale and stale.stage != stage:
        stale.status = "cancelled"
        stale.decided_at = utcnow()
    _log(db, project.id, actor, f"moved {label(target_type, obj)} from {old} to {stage}")
    owner_id = obj.owner_id if target_type == "feature" else None
    _notify(db, [owner_id], actor, f"moved {label(target_type, obj)} to {stage}", project.id,
            obj.id if target_type == "feature" else None)
    if sync and target_type == "feature" and obj.milestone_id:
        db.flush()
        sync_milestones(db, project, [obj.milestone_id], actor)


def may_decide(db: Session, project: Project, approval: Approval, user: User) -> bool:
    """Whether this person is the one (or one of those) who decides this request."""
    if not is_approver(db, project, user):
        return False
    if approval.approver_id is not None:
        return approval.approver_id == user.id
    if approval.requester_id == user.id:
        # Your own request is decided by someone else, unless nobody else can.
        return not [a for a in approvers(db, project) if a.id != user.id]
    return True


def request(db: Session, project: Project, user: User | None, target_type: str, obj, note: str = "",
            approver_id: int | None = None) -> Approval:
    """Ask the owner and managers (or one of them by name) to sign off the current stage."""
    if approver_id is not None:
        if approver_id not in {a.id for a in approvers(db, project)}:
            raise HTTPException(422, "Sign-off requests go to the project owner or a project manager")
        if user is not None and approver_id == user.id:
            raise HTTPException(422, "Ask someone else to sign off, or send it to the owner and all managers")
    to_stage = next_stage(target_type, obj.stage)
    if to_stage is None:
        raise HTTPException(400, "This has already finished its last stage")
    if pending_for(db, target_type, obj.id):
        raise HTTPException(409, "A sign-off for this stage is already waiting for a decision")
    require_checklist(db, target_type, obj)
    if target_type == "milestone" and gated(db, project):
        require_features_ready(obj)
    approval = Approval(
        project_id=project.id, kind="stage", target_type=target_type, target_id=obj.id,
        stage=obj.stage, to_stage=to_stage, note=note,
        title=f"Sign off {obj.stage} of {label(target_type, obj)}"[:200],
        requester_id=user.id if user else None, approver_id=approver_id,
    )
    try:
        with db.begin_nested():
            db.add(approval)
    except IntegrityError:  # someone else's request for the same stage got in a moment earlier
        raise HTTPException(409, "A sign-off for this stage is already waiting for a decision")
    _log(db, project.id, user, f"asked for sign-off of the {obj.stage} stage of {label(target_type, obj)}")
    _notify(db, [approver_id] if approver_id else [a.id for a in approvers(db, project)], user,
            f"asked for sign-off: {obj.stage} stage of {label(target_type, obj)}", project.id,
            obj.id if target_type == "feature" else None)
    return approval


def target_of(db: Session, approval: Approval):
    model = Feature if approval.target_type == "feature" else Milestone
    obj = db.get(model, approval.target_id or 0)
    return obj if obj is not None and obj.project_id == approval.project_id else None


def decide(db: Session, project: Project, approval: Approval, user: User, decision: str, note: str = "") -> None:
    """Approve (moves the item to the next stage) or reject a stage sign-off."""
    if not is_approver(db, project, user):
        raise HTTPException(403, "Only the project owner or a project manager can sign off a stage")
    if not may_decide(db, project, approval, user):
        if approval.approver_id is not None:
            raise HTTPException(403, f"This request was sent to {approval.approver.full_name if approval.approver else 'someone else'}")
        raise HTTPException(403, "You asked for this sign-off, so the owner or another manager has to approve it")
    obj = target_of(db, approval)
    if obj is None:
        approval.status = "cancelled"
        approval.decided_at = utcnow()
        raise HTTPException(404, "The item this sign-off was for no longer exists")
    if obj.stage != approval.stage:
        approval.status = "cancelled"
        approval.decided_at = utcnow()
        db.commit()
        raise HTTPException(409, "The item has moved since this was requested. Ask for a new sign-off.")
    carried = []
    if decision == "approved":
        require_checklist(db, approval.target_type, obj)
        if approval.target_type == "milestone" and gated(db, project):
            require_features_ready(obj)
            carried = milestone_gate(obj)["at_stage"] if milestone_gate(obj) else []
            for feature in carried:  # they are signed off in the same step, so their checklists count too
                try:
                    require_checklist(db, "feature", feature)
                except HTTPException as err:
                    raise HTTPException(409, f"Feature “{feature.title}”: {err.detail}")
    approval.status = decision
    approval.decision_note = note
    approval.approver_id = user.id
    approval.decided_at = utcnow()
    db.flush()  # so the lookups below no longer see this request as waiting
    target = label(approval.target_type, obj)
    if decision == "approved":
        _log(db, project.id, user, f"signed off the {approval.stage} stage of {target}")
        from_index = STAGES[approval.target_type].index(approval.stage)
        set_stage(db, project, approval.target_type, obj, approval.to_stage, user)
        if carried:
            _carry_features_forward(db, project, obj, from_index, user)
        _notify(db, [approval.requester_id], user, f"signed off the {approval.stage} stage of {target}; it is now in {approval.to_stage}", project.id)
    else:
        reason = f": {note}" if note else ""
        _log(db, project.id, user, f"did not sign off the {approval.stage} stage of {target}")
        _notify(db, [approval.requester_id], user, f"did not sign off the {approval.stage} stage of {target}{reason}", project.id)


def sign_off_now(db: Session, project: Project, user: User, target_type: str, obj, note: str = "") -> Approval:
    """An owner or manager signs off the current stage directly."""
    to_stage = next_stage(target_type, obj.stage)
    if to_stage is None:
        raise HTTPException(400, "This has already finished its last stage")
    approval = pending_for(db, target_type, obj.id)
    if approval is None:
        approval = Approval(
            project_id=project.id, kind="stage", target_type=target_type, target_id=obj.id,
            stage=obj.stage, to_stage=to_stage, title=f"Sign off {obj.stage} of {label(target_type, obj)}"[:200],
            requester_id=user.id,
        )
        db.add(approval)
        db.flush()
    decide(db, project, approval, user, "approved", note)
    return approval


def change_stage(db: Session, project: Project, user: User, target_type: str, obj, new_stage: str) -> None:
    """A direct stage edit (drag on the board, the stage menu). Enforces the lifecycle."""
    stages = STAGES[target_type]
    if new_stage not in stages:
        raise HTTPException(422, "Unknown stage")
    if new_stage == obj.stage:
        return
    if not gated(db, project):
        set_stage(db, project, target_type, obj, new_stage, user)
        return
    step = stages.index(new_stage) - stages.index(obj.stage if obj.stage in stages else stages[0])
    approver = is_approver(db, project, user)
    if step < 0:
        if not approver:
            raise HTTPException(403, "Only the project owner or a manager can move this back to an earlier stage")
        set_stage(db, project, target_type, obj, new_stage, user)
        if target_type == "milestone":
            _carry_features_back(db, project, obj, user)
        return
    if step > 1:
        raise HTTPException(409, f"Stages are signed off one at a time. The next stage is {next_stage(target_type, obj.stage)}.")
    # Forward always goes through a request that the owner or a manager approves.
    raise HTTPException(409, f"The {obj.stage} stage needs an approved sign-off first. Request a sign-off; the owner or a manager approves it.")


def initial_stage_allowed(db: Session, project: Project, user: User, target_type: str, stage: str) -> bool:
    """New items start at the beginning unless an owner or manager places them further along."""
    if not gated(db, project) or is_approver(db, project, user):
        return True
    return STAGES[target_type].index(stage) <= (1 if target_type == "feature" else 0)
