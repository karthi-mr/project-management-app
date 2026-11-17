"""Modules: a module has several features; a milestone has several modules and features.

Every stage of a module needs an approved sign-off. A module follows its features once they are all
signed off, and signing off a module signs off its features at that stage; the milestone follows all
of its features, including those in its modules.
"""
import pytest

from conftest import fails, ok
from test_signoff import Team


class ModuleTeam(Team):
    def module(self, name="Payments", by=None, **extra):
        return ok((by or self.dev).api.post(f"/api/projects/{self.pid}/modules", {"name": name, **extra}), 201)

    def module_row(self, module_id):
        return ok(self.dev.api.get(f"/api/modules/{module_id}"))

    def stage(self, kind, item_id):
        if kind == "module":
            return self.module_row(item_id)["stage"]
        return super().stage(kind, item_id)


@pytest.fixture
def team(workspace):
    return ModuleTeam(workspace(), key="MOD")


def setup_payments(team):
    beta = team.milestone("Beta")
    card = team.feature("Card payments")
    upi = team.feature("UPI payments")
    module = team.module("Payments", milestone_id=beta["id"], feature_ids=[card["id"], upi["id"]])
    return beta, card, upi, module


def test_features_in_a_module_belong_to_its_milestone(team):
    beta, card, upi, module = setup_payments(team)
    assert {f["title"] for f in module["features"]} == {"Card payments", "UPI payments"}
    assert module["milestone_name"] == "Beta" and module["stage"] == "proposed"
    feature = ok(team.dev.api.get(f"/api/features/{card['id']}"))
    assert feature["module_name"] == "Payments" and feature["milestone_id"] == beta["id"]
    other = team.milestone("Launch")
    fails(team.dev.api.patch(f"/api/features/{card['id']}", {"milestone_id": other["id"]}), 422, "comes from its module")
    # A new feature added straight into the module joins its milestone too.
    extra = team.feature("Refunds", module_id=module["id"])
    assert extra["milestone_id"] == beta["id"]
    # Moving the module moves its features.
    ok(team.owner.api.patch(f"/api/modules/{module['id']}", {"milestone_id": other["id"]}))
    assert ok(team.dev.api.get(f"/api/features/{card['id']}"))["milestone_id"] == other["id"]
    row = team.milestone_row(other["id"])
    assert [m["name"] for m in row["modules"]] == ["Payments"] and len(row["features"]) == 3


def test_a_module_does_not_move_without_sign_off(team):
    beta, card, upi, module = setup_payments(team)
    fails(team.dev.api.patch(f"/api/modules/{module['id']}", {"stage": "planned"}), 409)
    fails(team.owner.api.patch(f"/api/modules/{module['id']}", {"stage": "planned"}), 409, "needs an approved sign-off")
    fails(team.owner.api.patch(f"/api/modules/{module['id']}", {"stage": "design"}), 409, "one at a time")
    assert team.stage("module", module["id"]) == "proposed"


def test_when_every_feature_is_signed_off_the_module_follows(team):
    beta, card, upi, module = setup_payments(team)
    team.advance("feature", card["id"])
    assert team.stage("module", module["id"]) == "proposed"  # UPI is not signed off yet
    team.advance("feature", upi["id"])
    assert team.stage("module", module["id"]) == "planned"
    row = team.module_row(module["id"])
    assert row["last_signoff"]["note"].startswith("Automatic") and row["signed_off_count"] == 0
    # The milestone follows all its features too (proposed is before a milestone's first stage).
    team.advance("feature", card["id"])
    team.advance("feature", upi["id"])
    assert team.stage("module", module["id"]) == "design"
    assert team.stage("milestone", beta["id"]) == "design"


def test_signing_off_a_module_signs_off_its_features(team):
    beta, card, upi, module = setup_payments(team)
    # A contributor asks; the owner approves; the module and both features move together.
    approval = ok(team.request("module", module["id"]), 201)
    fails(team.request("module", module["id"]), 409, "already waiting")
    ok(team.decide(approval["id"], team.owner))
    assert team.stage("module", module["id"]) == "planned"
    assert team.stage("feature", card["id"]) == "planned" and team.stage("feature", upi["id"]) == "planned"
    assert team.stage("milestone", beta["id"]) == "planned"
    team.advance("module", module["id"])
    assert team.stage("feature", upi["id"]) == "design" and team.stage("milestone", beta["id"]) == "design"


def test_a_module_cannot_be_signed_off_while_a_feature_is_behind(team):
    beta, card, upi, module = setup_payments(team)
    team.advance("module", module["id"])  # all in planned
    late = team.feature("Wallets", stage="proposed")
    ok(team.owner.api.patch(f"/api/features/{late['id']}", {"module_id": module["id"]}))
    # The module is never ahead of its features: it steps back to proposed.
    assert team.stage("module", module["id"]) == "proposed"
    team.advance("feature", late["id"])
    assert team.stage("module", module["id"]) == "planned"


def test_moving_a_module_back_moves_its_features_and_milestone_back(team):
    beta, card, upi, module = setup_payments(team)
    team.advance("module", module["id"])
    team.advance("module", module["id"])
    assert team.stage("milestone", beta["id"]) == "design"
    fails(team.dev.api.patch(f"/api/modules/{module['id']}", {"stage": "planned"}), 403)
    ok(team.owner.api.patch(f"/api/modules/{module['id']}", {"stage": "planned"}))
    assert team.stage("feature", card["id"]) == "planned" and team.stage("feature", upi["id"]) == "planned"
    assert team.stage("milestone", beta["id"]) == "planned"
    # And a feature going back takes its module back.
    team.advance("module", module["id"])
    ok(team.owner.api.patch(f"/api/features/{card['id']}", {"stage": "planned"}))
    assert team.stage("module", module["id"]) == "planned"


def test_milestone_sign_off_carries_modules_through_their_features(team):
    beta, card, upi, module = setup_payments(team)
    team.advance("module", module["id"])  # everything at planned
    team.advance("milestone", beta["id"])
    assert team.stage("feature", card["id"]) == "design"
    assert team.stage("module", module["id"]) == "design"


def test_simple_mode_one_click_and_deleting_a_module(workspace):
    team = ModuleTeam(workspace(), key="SMP", mode="simple")
    beta, card, upi, module = setup_payments(team)
    ok(team.owner.api.post(f"/api/projects/{team.pid}/signoffs", {"target_type": "module", "target_id": module["id"], "approve": True}), 201)
    assert team.stage("module", module["id"]) == "planned" and team.stage("feature", upi["id"]) == "planned"
    fails(team.dev.api.delete(f"/api/modules/{module['id']}"), 403)
    ok(team.owner.api.delete(f"/api/modules/{module['id']}"), 204)
    feature = ok(team.dev.api.get(f"/api/features/{card['id']}"))
    assert feature["module_id"] is None and feature["milestone_id"] == beta["id"]


def test_modules_are_private_to_the_project_and_workspace(team, workspace):
    beta, card, upi, module = setup_payments(team)
    other = workspace()
    assert other.admin.api.get(f"/api/modules/{module['id']}").status_code in (403, 404)
    foreign = other.project("OTH")
    feature = ok(other.admin.api.post(f"/api/projects/{foreign['id']}/features", {"title": "X"}), 201)
    fails(team.owner.api.patch(f"/api/modules/{module['id']}", {"feature_ids": [feature["id"]]}), 422)
    fails(team.dev.api.post(f"/api/projects/{team.pid}/features", {"title": "Y", "module_id": 999999}), 422)
