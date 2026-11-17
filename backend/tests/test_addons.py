"""Plans and add-ons: what each costs, what each unlocks, and how they are bought and granted."""
from conftest import fails, ok, unique


def buy(owner, ws, plans, plan_key, addons=(), seats=5, period="monthly"):
    request = ok(ws.admin.api.post("/api/billing/requests", {
        "plan_id": plans[plan_key]["id"], "seats": seats, "period": period, "addons": list(addons),
    }), 201)
    if request["status"] == "pending":
        return ok(owner.api.post(f"/api/platform/requests/{request['id']}/approve", {"note": ""}))
    return {"request": request}


def features(ws):
    return ok(ws.admin.api.get("/api/auth/me"))["org"]["features"]


def test_the_catalogue_lists_plans_and_addons(workspace):
    ws = workspace()
    billing = ok(ws.admin.api.get("/api/billing"))
    assert [p["key"] for p in billing["plans"]] == ["free", "starter", "professional", "business", "enterprise"]
    keys = [a["key"] for a in billing["addons"]]
    assert keys == ["approvals_pro", "client_portal", "time_budgets", "test_management", "automation", "resource_planning", "advanced_security"]
    # A trial has every feature, add-ons included.
    assert {"tests", "client_portal", "time_tracking", "approvals_advanced", "portfolio"} <= set(features(ws))


def test_a_quote_adds_addons_per_user_and_skips_what_the_plan_includes(workspace, plans):
    ws = workspace()
    starter = ok(ws.admin.api.post("/api/billing/quote", {
        "plan_id": plans["starter"]["id"], "seats": 5, "period": "monthly", "addons": ["client_portal", "test_management"],
    }))
    assert starter["list_amount"] == (6 + 2 + 2) * 5
    assert [line["name"] for line in starter["lines"]] == ["Starter", "Client portal", "Test management"]
    yearly = ok(ws.admin.api.post("/api/billing/quote", {
        "plan_id": plans["starter"]["id"], "seats": 5, "period": "yearly", "addons": ["client_portal"],
    }))
    assert yearly["amount"] == (60 + 20) * 5
    # Business already includes the client portal, so it is not charged again.
    business = ok(ws.admin.api.post("/api/billing/quote", {
        "plan_id": plans["business"]["id"], "seats": 5, "period": "monthly", "addons": ["client_portal", "test_management"],
    }))
    assert business["addons"] == ["test_management"] and business["list_amount"] == (12 + 2) * 5
    fails(ws.admin.api.post("/api/billing/quote", {"plan_id": plans["starter"]["id"], "seats": 5, "period": "monthly", "addons": ["nope"]}), 422)


def test_buying_addons_unlocks_their_features_and_a_renewal_without_them_removes_them(workspace, owner, plans):
    ws = workspace()
    project = ws.project()
    done = buy(owner, ws, plans, "starter", ["test_management", "client_portal"])
    assert done["invoice"]["addon_names"] == ["Client portal", "Test management"]
    assert done["invoice"]["amount"] == (6 + 2 + 2) * 5
    have = set(features(ws))
    assert {"tests", "client_portal"} <= have and "time_tracking" not in have
    ok(ws.admin.api.get(f"/api/projects/{project['id']}/tests"))
    link = ok(ws.admin.api.post(f"/api/projects/{project['id']}/share-links", {"label": "Client", "sections": ["features"]}), 201)
    ok(ws.client.get(f"/api/public/share/{link['token']}"))
    fails(ws.admin.api.get("/api/timesheet?start=2026-01-01&end=2026-01-31"), 402, "not included")

    me = ok(ws.admin.api.get("/api/auth/me"))["org"]
    assert [a["key"] for a in me["addons"]] == ["client_portal", "test_management"]

    buy(owner, ws, plans, "starter")  # renewed without add-ons
    assert "tests" not in features(ws)
    fails(ws.admin.api.get(f"/api/projects/{project['id']}/tests"), 402)
    # The client link stops working too, without saying why.
    assert ws.client.get(f"/api/public/share/{link['token']}").status_code == 404


def test_the_free_plan_starts_at_once_and_has_limits(workspace, owner, plans):
    ws = workspace()
    fails(ws.admin.api.post("/api/billing/requests", {"plan_id": plans["free"]["id"], "seats": 4, "period": "monthly"}), 422, "up to 3")
    request = ok(ws.admin.api.post("/api/billing/requests", {"plan_id": plans["free"]["id"], "seats": 3, "period": "monthly"}), 201)
    assert request["status"] == "approved"
    org = ok(ws.admin.api.get("/api/auth/me"))["org"]
    assert org["plan"]["key"] == "free" and org["status"] == "active" and org["valid_until"] is None
    assert org["features"] == []
    ws.project("TWO")
    fails(ws.admin.api.post("/api/projects", {"name": "Third", "key": "THR"}), 402)
    # Paid add-ons on the free plan go through the owner like any paid request.
    paid = ok(ws.admin.api.post("/api/billing/requests", {"plan_id": plans["free"]["id"], "seats": 3, "period": "monthly", "addons": ["client_portal"]}), 201)
    assert paid["status"] == "pending" and paid["amount"] == 2 * 3


def test_strict_signoff_reminders_and_checklists_need_approvals_pro(workspace, owner, plans):
    ws = workspace()
    buy(owner, ws, plans, "professional")
    fails(ws.admin.api.post("/api/projects", {"name": "Strict", "key": "STR", "signoff_mode": "strict"}), 402, "not included")
    simple = ok(ws.admin.api.post("/api/projects", {"name": "Simple", "key": "SIM"}), 201)
    assert simple["signoff_mode"] == "simple"
    fails(ws.admin.api.patch(f"/api/projects/{simple['id']}", {"signoff_mode": "strict"}), 402)
    fails(ws.admin.api.patch(f"/api/projects/{simple['id']}", {"signoff_remind_days": 3}), 402)
    fails(ws.admin.api.put(f"/api/projects/{simple['id']}/signoff-criteria", {"criteria": []}), 402)
    buy(owner, ws, plans, "professional", ["approvals_pro"])
    ok(ws.admin.api.patch(f"/api/projects/{simple['id']}", {"signoff_mode": "strict", "signoff_remind_days": 3}))


def test_the_platform_owner_can_give_addons_free_and_they_survive_a_purchase(workspace, owner, plans):
    ws = workspace()
    buy(owner, ws, plans, "starter")
    fails(owner.api.patch(f"/api/platform/organizations/{ws.org_id}", {"free_addons": ["nope"]}), 422)
    ok(owner.api.patch(f"/api/platform/organizations/{ws.org_id}", {"free_addons": ["automation"]}))
    org = ok(ws.admin.api.get("/api/auth/me"))["org"]
    assert "automation" in org["features"] and org["addons"][0]["free"] is True
    # A free add-on is not charged, and is kept when a licence without it is activated.
    quote = ok(ws.admin.api.post("/api/billing/quote", {"plan_id": plans["starter"]["id"], "seats": 5, "period": "monthly", "addons": ["automation"]}))
    assert quote["addons"] == [] and quote["list_amount"] == 6 * 5
    buy(owner, ws, plans, "starter", ["client_portal"])
    assert {"automation", "client_portal"} <= set(features(ws))
    assert any("add-ons" in n["message"] for n in ok(ws.admin.api.get("/api/notifications"))["updates"])


def test_the_platform_owner_manages_the_addon_catalogue(owner, workspace, plans):
    listing = ok(owner.api.get("/api/platform/addons"))
    assert len(listing["addons"]) >= 7 and "tests" in listing["features"]
    name = unique("Extra ")
    created = ok(owner.api.post("/api/platform/addons", {"name": name, "price_monthly": 1, "price_yearly": 10, "features": ["tests"]}), 201)
    fails(owner.api.post("/api/platform/addons", {"name": "Bad", "price_monthly": 1, "price_yearly": 10, "features": ["flying"]}), 422)
    ok(owner.api.put(f"/api/platform/addons/{created['id']}", {"name": name, "price_monthly": 1.5, "price_yearly": 15, "features": ["tests"], "is_public": False}))
    ws = workspace()
    assert created["key"] not in [a["key"] for a in ok(ws.admin.api.get("/api/billing"))["addons"]]  # hidden
    ok(owner.api.patch(f"/api/platform/organizations/{ws.org_id}", {"addons": [created["key"]]}))
    fails(owner.api.delete(f"/api/platform/addons/{created['id']}"), 400, "Workspaces have this add-on")
    ok(owner.api.patch(f"/api/platform/organizations/{ws.org_id}", {"addons": []}))
    ok(owner.api.delete(f"/api/platform/addons/{created['id']}"), 204)
    fails(ws.admin.api.get("/api/platform/addons"), 404)


def test_workspaces_from_before_addons_keep_what_they_had():
    """The one-off upgrade: a paid workspace keeps, free, the add-ons for features everyone used to have."""
    from sqlalchemy import select

    from app import saas
    from app.database import SessionLocal
    from app.models import Organization, Plan, PlatformSetting

    with SessionLocal() as db:
        starter = db.scalar(select(Plan).where(Plan.key == "starter"))
        org = Organization(name=unique("Old customer "), plan_id=starter.id, is_trial=False, seats=5)
        db.add(org)
        marker = db.get(PlatformSetting, "addons_grandfathered")
        db.delete(marker)
        db.flush()
        saas._grandfather_addons(db)
        assert saas.split_keys(org.free_addons) == ["client_portal", "resource_planning", "test_management", "time_budgets"]
        assert {"tests", "client_portal", "time_tracking", "portfolio"} <= set(saas.effective_features(db, org))
        db.rollback()
