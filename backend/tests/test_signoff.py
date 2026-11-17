"""The signed-off lifecycle of features and milestones.

Rules under test: a stage moves on only when a sign-off request is approved by the project owner or
a project manager; nobody (not even the owner) skips the request; someone else approves your own
request unless you are the only approver; checklists must be complete; a milestone follows its features.
"""
from datetime import timedelta

import pytest
from sqlalchemy import select

from app import signoff
from app.database import SessionLocal
from app.models import Approval, Notification, utcnow
from conftest import fails, ok


class Team:
    """A project owned by the workspace admin, with a project manager and a contributor."""

    def __init__(self, ws, key="SGN", mode="strict"):
        self.ws = ws
        self.owner = ws.admin
        self.manager = ws.add_person(full_name="Mia Manager")
        self.dev = ws.add_person(full_name="Dan Developer")
        self.project = ws.project(key, signoff_mode=mode)
        self.pid = self.project["id"]
        ok(self.owner.api.post(f"/api/projects/{self.pid}/members", {"user_id": self.manager.id, "role": "manager"}))
        ok(self.owner.api.post(f"/api/projects/{self.pid}/members", {"user_id": self.dev.id, "role": "contributor"}))

    def feature(self, title="Login", stage="proposed", by=None, **extra):
        return ok((by or self.dev).api.post(f"/api/projects/{self.pid}/features", {"title": title, "stage": stage, **extra}), 201)

    def milestone(self, name="Beta", by=None):
        return ok((by or self.dev).api.post(f"/api/projects/{self.pid}/milestones", {"name": name}), 201)

    def request(self, kind, item_id, by=None, **extra):
        return (by or self.dev).api.post(f"/api/projects/{self.pid}/signoffs", {"target_type": kind, "target_id": item_id, **extra})

    def decide(self, approval_id, by, decision="approved", note=""):
        return by.api.post(f"/api/approvals/{approval_id}/decide", {"decision": decision, "note": note})

    def advance(self, kind, item_id, by=None, approver=None):
        approval = ok(self.request(kind, item_id, by=by), 201)
        return ok(self.decide(approval["id"], approver or self.owner))

    def stage(self, kind, item_id):
        if kind == "feature":
            return ok(self.dev.api.get(f"/api/features/{item_id}"))["stage"]
        return self.milestone_row(item_id)["stage"]

    def milestone_row(self, item_id):
        return next(m for m in ok(self.dev.api.get(f"/api/projects/{self.pid}/milestones")) if m["id"] == item_id)


@pytest.fixture
def team(workspace):
    """Most rules are tested in strict mode, the strictest; simple and off have their own tests."""
    return Team(workspace())


# ───────────── Request, then approval ─────────────


def test_project_reports_who_can_approve(team):
    project = ok(team.owner.api.get(f"/api/projects/{team.pid}"))
    assert project["signoff_gated"] is True and project["can_approve"] is True
    assert set(project["approver_ids"]) == {team.owner.id, team.manager.id}
    assert ok(team.manager.api.get(f"/api/projects/{team.pid}"))["can_approve"] is True
    assert ok(team.dev.api.get(f"/api/projects/{team.pid}"))["can_approve"] is False


def test_nobody_moves_a_stage_without_an_approved_request(team):
    feature = team.feature()
    fails(team.dev.api.patch(f"/api/features/{feature['id']}", {"stage": "planned"}), 409)
    fails(team.owner.api.patch(f"/api/features/{feature['id']}", {"stage": "planned"}), 409)
    fails(team.owner.api.patch(f"/api/features/{feature['id']}", {"stage": "design"}), 409, "one at a time")
    # The old "approve straight away" flag now only makes a request.
    request = ok(team.request("feature", feature["id"], by=team.owner, approve=True), 201)
    assert request["status"] == "pending" and team.stage("feature", feature["id"]) == "proposed"


def test_owner_or_manager_approves_and_the_item_moves_one_stage(team):
    feature = team.feature()
    request = ok(team.request("feature", feature["id"], note="scope agreed"), 201)
    assert request["stage"] == "proposed" and request["to_stage"] == "planned" and request["approver"] is None
    shown = ok(team.dev.api.get(f"/api/features/{feature['id']}"))["signoff"]
    assert shown["id"] == request["id"] and shown["requester"]["id"] == team.dev.id
    fails(team.decide(request["id"], team.dev), 403)
    decided = ok(team.decide(request["id"], team.manager))
    assert decided["status"] == "approved" and decided["approver"]["id"] == team.manager.id
    assert team.stage("feature", feature["id"]) == "planned"
    last = ok(team.dev.api.get(f"/api/features/{feature['id']}"))["last_signoff"]
    assert last["status"] == "approved" and last["by"]["id"] == team.manager.id


def test_declined_request_keeps_the_stage(team):
    feature = team.feature()
    request = ok(team.request("feature", feature["id"]), 201)
    ok(team.decide(request["id"], team.owner, "rejected", "add acceptance criteria"))
    data = ok(team.dev.api.get(f"/api/features/{feature['id']}"))
    assert data["stage"] == "proposed" and data["signoff"] is None
    assert data["last_signoff"]["status"] == "rejected" and data["last_signoff"]["note"] == "add acceptance criteria"
    ok(team.request("feature", feature["id"]), 201)  # it can be asked again


def test_your_own_request_is_approved_by_someone_else(team):
    feature = team.feature(by=team.manager)
    request = ok(team.request("feature", feature["id"], by=team.manager), 201)
    fails(team.decide(request["id"], team.manager), 403, "owner or another manager")
    pending = [i for i in ok(team.manager.api.get("/api/notifications"))["pending"] if i["kind"] == "approval"]
    assert pending == []  # not on the requester's own to-do list
    assert any(i["kind"] == "approval" for i in ok(team.owner.api.get("/api/notifications"))["pending"])
    ok(team.decide(request["id"], team.owner))


def test_a_sole_approver_may_approve_their_own_request(workspace):
    ws = workspace()
    project = ws.project("SOLO", signoff_mode="strict")
    feature = ok(ws.admin.api.post(f"/api/projects/{project['id']}/features", {"title": "Alone", "stage": "proposed"}), 201)
    request = ok(ws.admin.api.post(f"/api/projects/{project['id']}/signoffs", {"target_type": "feature", "target_id": feature["id"]}), 201)
    ok(ws.admin.api.post(f"/api/approvals/{request['id']}/decide", {"decision": "approved"}))


def test_every_request_goes_to_the_owner_and_all_managers(team):
    feature = team.feature()
    # Naming one person is not possible: it is ignored, and everyone who can approve is asked.
    request = ok(team.request("feature", feature["id"], approver_id=team.manager.id), 201)
    assert request["approver"] is None
    for person in (team.owner, team.manager):
        assert any(i["kind"] == "approval" for i in ok(person.api.get("/api/notifications"))["pending"])
    ok(team.decide(request["id"], team.owner))  # the first to decide settles it
    general = ok(team.dev.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "general", "title": "Buy a laptop", "approver_id": team.manager.id}), 201)
    assert general["approver"] is None


def test_workspace_admins_approve_only_as_owner_or_manager(workspace):
    ws = workspace()
    lead = ws.add_person(role="manager", full_name="Lead")
    dev = ws.add_person()
    project = ws.project("ADM", by=lead, signoff_mode="strict")  # owned by the lead, not the admin
    ok(lead.api.post(f"/api/projects/{project['id']}/members", {"user_id": dev.id, "role": "contributor"}))
    assert ok(ws.admin.api.get(f"/api/projects/{project['id']}"))["can_approve"] is False
    feature = ok(dev.api.post(f"/api/projects/{project['id']}/features", {"title": "F", "stage": "proposed"}), 201)
    request = ok(dev.api.post(f"/api/projects/{project['id']}/signoffs", {"target_type": "feature", "target_id": feature["id"]}), 201)
    fails(ws.admin.api.post(f"/api/approvals/{request['id']}/decide", {"decision": "approved"}), 403)
    ok(lead.api.post(f"/api/approvals/{request['id']}/decide", {"decision": "approved"}))
    fails(ws.admin.api.patch(f"/api/features/{feature['id']}", {"stage": "proposed"}), 403)  # nor move it back


def test_only_owner_or_manager_moves_something_back(team):
    feature = team.feature()
    team.advance("feature", feature["id"])
    team.advance("feature", feature["id"])
    fails(team.dev.api.patch(f"/api/features/{feature['id']}", {"stage": "planned"}), 403)
    ok(team.manager.api.patch(f"/api/features/{feature['id']}", {"stage": "proposed"}))
    assert team.stage("feature", feature["id"]) == "proposed"


def test_contributors_cannot_create_features_in_a_late_stage(team):
    fails(team.dev.api.post(f"/api/projects/{team.pid}/features", {"title": "Late", "stage": "testing"}), 409)
    assert team.feature(by=team.owner, stage="testing")["stage"] == "testing"


def test_the_last_stage_has_no_sign_off(team):
    milestone = team.milestone()
    for _ in range(len(signoff.MILESTONE_STAGES) - 1):
        team.advance("milestone", milestone["id"])
    row = team.milestone_row(milestone["id"])
    assert row["stage"] == "completed" and row["status"] == "closed" and row["next_stage"] is None
    fails(team.request("milestone", milestone["id"]), 400)


def test_turning_the_rule_off_allows_free_moves(team):
    feature = team.feature()
    fails(team.dev.api.patch(f"/api/projects/{team.pid}", {"signoff_mode": "off"}), 403)
    project = ok(team.owner.api.patch(f"/api/projects/{team.pid}", {"signoff_mode": "off"}))
    assert project["signoff_mode"] == "off" and project["signoff_gated"] is False and project["signoff_required"] is False
    assert ok(team.dev.api.patch(f"/api/features/{feature['id']}", {"stage": "released"}))["stage"] == "released"


def test_the_older_on_off_flag_still_maps_to_a_mode(team):
    assert ok(team.owner.api.patch(f"/api/projects/{team.pid}", {"signoff_required": False}))["signoff_mode"] == "off"
    assert ok(team.owner.api.patch(f"/api/projects/{team.pid}", {"signoff_required": True}))["signoff_mode"] == "strict"


# ───────────── Modes ─────────────


def test_new_projects_default_to_simple(workspace):
    ws = workspace()
    assert ws.project("DEF")["signoff_mode"] == "simple"
    assert ws.project("OFF", signoff_mode="off")["signoff_gated"] is False
    fails(ws.admin.api.post("/api/projects", {"name": "x", "key": "BAD", "signoff_mode": "loose"}), 422)


def test_simple_mode_owner_and_managers_sign_off_in_one_step(workspace):
    team = Team(workspace(), key="SMP", mode="simple")
    feature = team.feature()
    # One click (or a drag to the next stage) by an approver.
    signed = ok(team.request("feature", feature["id"], by=team.manager, approve=True), 201)
    assert signed["status"] == "approved" and team.stage("feature", feature["id"]) == "planned"
    ok(team.owner.api.patch(f"/api/features/{feature['id']}", {"stage": "design"}))
    assert team.stage("feature", feature["id"]) == "design"
    fails(team.owner.api.patch(f"/api/features/{feature['id']}", {"stage": "testing"}), 409, "one at a time")
    # Others still ask; the approve flag does nothing for them.
    fails(team.dev.api.patch(f"/api/features/{feature['id']}", {"stage": "development"}), 409)
    request = ok(team.request("feature", feature["id"], approve=True), 201)
    assert request["status"] == "pending"
    ok(team.decide(request["id"], team.manager))


def test_simple_mode_lets_approvers_decide_their_own_requests(workspace):
    team = Team(workspace(), key="OWN", mode="simple")
    feature = team.feature(by=team.manager)
    request = ok(team.request("feature", feature["id"], by=team.manager), 201)
    ok(team.decide(request["id"], team.manager))
    general = ok(team.manager.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "general", "title": "Order laptops"}), 201)
    ok(team.decide(general["id"], team.manager))


def test_simple_mode_still_applies_checklists(workspace):
    team = Team(workspace(), key="CHK", mode="simple")
    ok(team.owner.api.put(f"/api/projects/{team.pid}/signoff-criteria", {"criteria": [{"target_type": "feature", "stage": "proposed", "text": "Scope agreed", "kind": "manual"}]}))
    feature = team.feature()
    fails(team.request("feature", feature["id"], by=team.owner, approve=True), 409, "Scope agreed")
    fails(team.owner.api.patch(f"/api/features/{feature['id']}", {"stage": "planned"}), 409)


# ───────────── One rule for every approval ─────────────


def test_every_kind_of_approval_follows_the_same_rule_in_strict_mode(team):
    for body in ({"kind": "general", "title": "Buy a server"}, {"kind": "phase", "phase": "planning"}):
        request = ok(team.manager.api.post(f"/api/projects/{team.pid}/approvals", body), 201)
        fails(team.decide(request["id"], team.manager), 403, "owner or another manager")
        fails(team.decide(request["id"], team.dev), 403)
        ok(team.decide(request["id"], team.owner))


def test_approvals_say_who_can_decide(team):
    request = ok(team.dev.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "general", "title": "Hire a designer"}), 201)
    for person, expected in ((team.owner, True), (team.manager, True), (team.dev, False)):
        row = next(a for a in ok(person.api.get(f"/api/projects/{team.pid}/approvals")) if a["id"] == request["id"])
        assert row["can_decide"] is expected and row["kind_label"] == "Other approval"
    mine = ok(team.dev.api.get("/api/approvals/mine"))
    assert [a["id"] for a in mine] == [request["id"]] and mine[0]["can_decide"] is False


def test_deploying_a_release_does_not_skip_sign_offs(team):
    feature = team.feature(by=team.owner, stage="deployment")
    release = ok(team.owner.api.post(f"/api/projects/{team.pid}/releases", {"version": "1.0", "feature_ids": [feature["id"]]}), 201)
    ok(team.owner.api.patch(f"/api/releases/{release['id']}", {"status": "deployed"}))
    assert team.stage("feature", feature["id"]) == "deployment"


# ───────────── No duplicates ─────────────


def test_only_one_waiting_sign_off_per_item(team):
    feature = team.feature()
    ok(team.request("feature", feature["id"]), 201)
    fails(team.request("feature", feature["id"]), 409, "already waiting")
    fails(team.request("feature", feature["id"], by=team.manager), 409)


def test_the_database_refuses_a_second_waiting_sign_off(team):
    feature = team.feature()
    ok(team.request("feature", feature["id"]), 201)
    with SessionLocal() as db:
        db.add(Approval(project_id=team.pid, kind="stage", target_type="feature", target_id=feature["id"],
                        stage="proposed", to_stage="planned", title="duplicate", requester_id=team.dev.id))
        with pytest.raises(Exception):
            db.commit()


def test_other_approvals_cannot_be_asked_twice(team):
    first = ok(team.dev.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "phase", "phase": "planning"}), 201)
    fails(team.dev.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "phase", "phase": "planning"}), 409, "waiting")
    ok(team.decide(first["id"], team.owner))
    fails(team.dev.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "phase", "phase": "planning"}), 409, "already approved")
    second = ok(team.dev.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "phase", "phase": "design"}), 201)
    ok(team.decide(second["id"], team.owner, "rejected"))
    ok(team.dev.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "phase", "phase": "design"}), 201)
    ok(team.dev.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "general", "title": "Buy a licence"}), 201)
    fails(team.dev.api.post(f"/api/projects/{team.pid}/approvals", {"kind": "general", "title": "Buy a licence"}), 409)


# ───────────── Checklists ─────────────


def save_criteria(team, *rows):
    return ok(team.owner.api.put(f"/api/projects/{team.pid}/signoff-criteria", {"criteria": [
        {"target_type": t, "stage": s, "text": text, "kind": kind} for t, s, text, kind in rows
    ]}))


def test_checklist_lines_must_be_done_before_a_sign_off(team):
    fails(team.dev.api.put(f"/api/projects/{team.pid}/signoff-criteria", {"criteria": []}), 403)
    fails(team.owner.api.put(f"/api/projects/{team.pid}/signoff-criteria", {"criteria": [{"target_type": "feature", "stage": "released", "text": "x"}]}), 422)
    criteria = save_criteria(team, ("feature", "proposed", "Scope agreed with client", "manual"))
    feature = team.feature()
    assert feature["checklist"] == [{"id": criteria[0]["id"], "text": "Scope agreed with client", "kind": "manual", "done": False, "by": None, "detail": ""}]
    fails(team.request("feature", feature["id"]), 409, "Scope agreed")
    ticked = ok(team.dev.api.post("/api/signoff-checks", {"criterion_id": criteria[0]["id"], "target_id": feature["id"], "done": True}))
    assert ticked["checklist"][0]["done"] and ticked["checklist"][0]["by"] == "Dan Developer"
    team.advance("feature", feature["id"])
    # Going back to the stage clears its ticks: the work has to be checked again.
    ok(team.owner.api.patch(f"/api/features/{feature['id']}", {"stage": "proposed"}))
    assert ok(team.dev.api.get(f"/api/features/{feature['id']}"))["checklist"][0]["done"] is False


def test_automatic_lines_for_issues_and_tests(team):
    save_criteria(team, ("feature", "development", "All issues done", "all_issues_done"),
                  ("feature", "testing", "All tests passed", "tests_passed"))
    feature = team.feature(by=team.owner, stage="development")
    fails(team.dev.api.post("/api/signoff-checks", {"criterion_id": feature["checklist"][0]["id"], "target_id": feature["id"], "done": True}), 400)
    fails(team.request("feature", feature["id"]), 409)  # no linked issues yet
    issue = ok(team.dev.api.post("/api/issues", {"project_id": team.pid, "title": "Build it", "feature_id": feature["id"]}), 201)
    fails(team.request("feature", feature["id"]), 409)
    ok(team.dev.api.patch(f"/api/issues/{issue['id']}", {"status": "done"}))
    team.advance("feature", feature["id"])  # → testing

    fails(team.request("feature", feature["id"]), 409, "tests")
    case = ok(team.dev.api.post(f"/api/projects/{team.pid}/tests", {"title": "Login works", "feature_id": feature["id"]}), 201)
    ok(team.dev.api.post(f"/api/tests/{case['id']}/results", {"status": "failed", "note": "500 error"}))
    fails(team.request("feature", feature["id"]), 409)
    ok(team.dev.api.post(f"/api/tests/{case['id']}/results", {"status": "passed"}))
    assert team.advance("feature", feature["id"])["to_stage"] == "deployment"


# ───────────── Features and their milestone ─────────────


@pytest.fixture
def linked(team):
    milestone = team.milestone()
    f1 = team.feature("F1", stage="planned", by=team.owner, milestone_id=milestone["id"])
    f2 = team.feature("F2", stage="planned", by=team.owner, milestone_id=milestone["id"])
    return team, milestone["id"], f1["id"], f2["id"]


def test_feature_shows_its_milestone_and_milestone_lists_features(linked):
    team, mid, f1, f2 = linked
    row = team.milestone_row(mid)
    assert [f["id"] for f in row["features"]] == [f1, f2]
    assert row["feature_gate"]["total"] == 2 and row["feature_gate"]["signed_off"] == 0
    assert ok(team.dev.api.get(f"/api/features/{f1}"))["milestone_name"] == "Beta"


def test_milestone_follows_when_every_feature_is_signed_off(linked):
    team, mid, f1, f2 = linked
    team.advance("feature", f1)
    assert team.stage("milestone", mid) == "planned"
    assert team.milestone_row(mid)["feature_gate"]["signed_off"] == 1
    team.advance("feature", f2)
    row = team.milestone_row(mid)
    assert row["stage"] == "design"
    assert row["last_signoff"]["status"] == "approved" and "Automatic" in row["last_signoff"]["note"]


def test_signing_off_the_milestone_carries_its_features(linked):
    team, mid, f1, f2 = linked
    approval = ok(team.request("milestone", mid), 201)
    ok(team.decide(approval["id"], team.owner))
    assert team.stage("milestone", mid) == "design"
    assert team.stage("feature", f1) == "design" and team.stage("feature", f2) == "design"
    note = ok(team.dev.api.get(f"/api/features/{f1}"))["last_signoff"]["note"]
    assert "together with milestone" in note


def test_milestone_waits_for_a_feature_that_is_behind(linked):
    team, mid, f1, f2 = linked
    late = team.feature("F3", stage="proposed")
    ok(team.dev.api.patch(f"/api/features/{late['id']}", {"milestone_id": mid}))
    row = team.milestone_row(mid)
    assert row["stage"] == "planned" and [f["title"] for f in row["feature_gate"]["behind"]] == ["F3"]
    fails(team.request("milestone", mid), 409, "F3")
    ok(team.dev.api.patch(f"/api/features/{late['id']}", {"milestone_id": None}))
    ok(team.request("milestone", mid), 201)


def test_linking_an_early_feature_pulls_the_milestone_back(linked):
    team, mid, f1, f2 = linked
    team.advance("feature", f1)
    team.advance("feature", f2)
    assert team.stage("milestone", mid) == "design"
    early = team.feature("Early", stage="planned", by=team.owner)
    ok(team.dev.api.patch(f"/api/features/{early['id']}", {"milestone_id": mid}))
    assert team.stage("milestone", mid) == "planned"
    ok(team.dev.api.patch(f"/api/features/{early['id']}", {"milestone_id": None}))
    assert team.stage("milestone", mid) == "design"


def test_moving_back_works_both_ways(linked):
    team, mid, f1, f2 = linked
    for _ in range(2):
        team.advance("feature", f1)
        team.advance("feature", f2)
    assert team.stage("milestone", mid) == "development"
    ok(team.owner.api.patch(f"/api/features/{f1}", {"stage": "design"}))
    assert team.stage("milestone", mid) == "design"
    ok(team.owner.api.patch(f"/api/milestones/{mid}", {"stage": "planned"}))
    assert team.stage("feature", f1) == "planned" and team.stage("feature", f2) == "planned"


def test_milestone_checklist_holds_the_automatic_move(linked):
    team, mid, f1, f2 = linked
    criterion = save_criteria(team, ("milestone", "planned", "Plan reviewed", "manual"))[0]
    team.advance("feature", f1)
    team.advance("feature", f2)
    assert team.stage("milestone", mid) == "planned"
    ok(team.dev.api.post("/api/signoff-checks", {"criterion_id": criterion["id"], "target_id": mid, "done": True}))
    assert team.stage("milestone", mid) == "design"


# ───────────── Reminders ─────────────


def test_waiting_sign_offs_are_reminded_then_escalated_once(team):
    feature = team.feature()
    request = ok(team.request("feature", feature["id"]), 201)
    with SessionLocal() as db:
        row = db.get(Approval, request["id"])
        row.created_at = utcnow() - timedelta(days=6)
        db.commit()
        before = db.scalar(select(Notification.id).order_by(Notification.id.desc()).limit(1)) or 0
        assert signoff.run_reminders(db) == 2
        assert signoff.run_reminders(db) == 0  # each is sent once
        sent = db.scalars(select(Notification).where(Notification.id > before)).all()
    messages = [n.message for n in sent]
    assert any("reminder" in m for m in messages) and any("escalation" in m for m in messages)
    shown = ok(team.dev.api.get(f"/api/features/{feature['id']}"))["signoff"]
    assert shown["overdue"] is True and shown["waiting_days"] == 6
    late = [i for i in ok(team.owner.api.get("/api/notifications"))["pending"] if i["kind"] == "approval"]
    assert late and late[0]["severity"] == "overdue"
