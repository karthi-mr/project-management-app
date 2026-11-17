"""Licence requests, manual activation, invoices, coupons and discounts, and the owner console."""
from conftest import fails, ok, unique


def request_plan(ws, plans, key="starter", seats=8, period="yearly", **extra):
    return ws.admin.api.post("/api/billing/requests", {"plan_id": plans[key]["id"], "seats": seats, "period": period, **extra})


def test_request_activation_and_invoice(workspace, owner, plans):
    ws = workspace()
    person = ws.add_person()
    fails(person.api.get("/api/billing"), 403)
    request = ok(request_plan(ws, plans, payment_reference="UTR123"), 201)
    assert request["amount"] == 480 and request["status"] == "pending"
    fails(request_plan(ws, plans, key="business"), 409)  # one waiting request at a time

    waiting = ok(owner.api.get("/api/platform/requests?status=pending"))
    assert request["id"] in [r["id"] for r in waiting]
    assert any(i["kind"] == "platform" for i in ok(owner.api.get("/api/notifications"))["pending"])
    fails(ws.admin.api.post(f"/api/platform/requests/{request['id']}/approve", {"note": ""}), 404)

    result = ok(owner.api.post(f"/api/platform/requests/{request['id']}/approve", {"note": "thanks"}))
    org = result["organization"]
    assert org["status"] == "active" and org["plan"]["key"] == "starter" and org["seats"] == 8
    assert 364 <= org["days_left"] <= 366 and org["license_key"].startswith("TRK-")
    assert result["invoice"]["number"].startswith("INV-")
    fails(owner.api.post(f"/api/platform/requests/{request['id']}/approve", {"note": ""}), 400)

    invoice = ok(ws.admin.api.get(f"/api/billing/invoices/{result['invoice']['id']}"))
    assert invoice["amount"] == 480 and invoice["payment_reference"] == "UTR123"
    other = workspace()
    fails(other.admin.api.get(f"/api/billing/invoices/{result['invoice']['id']}"), 404)


def test_request_validation(workspace, plans):
    ws = workspace()
    for _ in range(2):
        ws.add_person()
    fails(request_plan(ws, plans, seats=2), 422, "at least")  # 3 people are active
    fails(request_plan(ws, plans, seats=11), 422)  # Starter covers up to 10
    fails(ws.admin.api.post("/api/billing/requests", {"plan_id": 999999, "seats": 5, "period": "monthly"}), 404)


def test_renewing_early_adds_to_the_current_period(workspace, owner, plans):
    ws = workspace()
    first = ok(request_plan(ws, plans, period="yearly"), 201)
    ok(owner.api.post(f"/api/platform/requests/{first['id']}/approve", {"note": ""}))
    second = ok(request_plan(ws, plans, period="monthly"), 201)
    org = ok(owner.api.post(f"/api/platform/requests/{second['id']}/approve", {"note": ""}))["organization"]
    assert 393 <= org["days_left"] <= 397


def test_reject_and_cancel(workspace, owner, plans):
    ws = workspace()
    request = ok(request_plan(ws, plans), 201)
    rejected = ok(owner.api.post(f"/api/platform/requests/{request['id']}/reject", {"note": "no payment yet"}))
    assert rejected["status"] == "rejected"
    again = ok(request_plan(ws, plans), 201)
    assert ok(ws.admin.api.post(f"/api/billing/requests/{again['id']}/cancel"))["status"] == "cancelled"
    fails(ws.admin.api.post(f"/api/billing/requests/{again['id']}/cancel"), 400)


def test_coupons_discounts_and_custom_price(workspace, owner, plans):
    ws = workspace()
    code = unique("SAVE").upper()
    fails(ws.admin.api.post("/api/platform/coupons", {"code": code, "percent_off": 100}), 404)
    ok(owner.api.post("/api/platform/coupons", {"code": code.lower(), "percent_off": 20, "max_uses": 1}), 201)
    fails(owner.api.post("/api/platform/coupons", {"code": code, "percent_off": 10}), 409)
    ok(owner.api.patch(f"/api/platform/organizations/{ws.org_id}", {"discount_percent": 10}))

    quote = ok(ws.admin.api.post("/api/billing/quote", {"plan_id": plans["business"]["id"], "seats": 5, "period": "monthly", "coupon_code": code}))
    assert quote["list_amount"] == 60 and quote["amount"] == 43.2  # 60 − 10% − 20%
    fails(ws.admin.api.post("/api/billing/quote", {"plan_id": plans["business"]["id"], "seats": 5, "period": "monthly", "coupon_code": "NOPE"}), 422)

    request = ok(request_plan(ws, plans, key="business", seats=5, period="monthly", coupon_code=code), 201)
    assert request["amount"] == 43.2 and request["list_amount"] == 60
    invoice = ok(owner.api.post(f"/api/platform/requests/{request['id']}/approve", {"note": "", "amount": 40}))["invoice"]
    assert invoice["amount"] == 40 and invoice["list_amount"] == 60 and "custom price" in invoice["discount_note"]
    coupon = next(c for c in ok(owner.api.get("/api/platform/coupons")) if c["code"] == code)
    assert coupon["used"] == 1 and coupon["usable"] is False


def test_owner_console_workspaces(workspace, owner, anon):
    ws = workspace()
    fails(ws.admin.api.get("/api/platform/organizations"), 404)
    found = ok(owner.api.get(f"/api/platform/organizations?q={ws.username}"))
    assert [o["id"] for o in found] == [ws.org_id]
    detail = ok(owner.api.get(f"/api/platform/organizations/{ws.org_id}"))
    assert detail["users"][0]["username"] == ws.username
    overview = ok(owner.api.get("/api/platform/overview"))
    assert overview["workspaces"] >= 2

    created = ok(owner.api.post("/api/platform/organizations", {"name": "Hand made", "admin_full_name": "Hana", "admin_email": f"{unique()}@example.com", "admin_username": unique("hana")}), 201)
    session = ok(anon.post("/api/auth/login", {"workspace": created["organization"]["public_id"], "username": created["username"], "password": created["temporary_password"]}))
    assert session["user"]["must_change_password"]

    my_org = ok(owner.api.get("/api/auth/me"))["org"]["id"]
    fails(owner.api.patch(f"/api/platform/organizations/{my_org}", {"suspended": True}), 400)
    fails(owner.api.delete(f"/api/platform/organizations/{created['organization']['id']}"), 400, "suspend")
    ok(owner.api.patch(f"/api/platform/organizations/{created['organization']['id']}", {"suspended": True}))
    ok(owner.api.delete(f"/api/platform/organizations/{created['organization']['id']}"), 204)


def test_owner_edits_plans(owner):
    data = ok(owner.api.get("/api/platform/plans"))
    assert {"trial", "starter", "business", "enterprise"} <= {p["key"] for p in data["plans"]}
    plan = ok(owner.api.post("/api/platform/plans", {"name": f"Team {unique()}", "price_monthly": 9, "price_yearly": 90, "max_users": 25, "features": ["sprints", "automation"]}), 201)
    fails(owner.api.put(f"/api/platform/plans/{plan['id']}", {"name": "x", "price_monthly": 1, "price_yearly": 1, "features": ["bogus"]}), 422)
    enterprise = next(p for p in data["plans"] if p["key"] == "enterprise")
    fails(owner.api.delete(f"/api/platform/plans/{enterprise['id']}"), 400)
    ok(owner.api.delete(f"/api/platform/plans/{plan['id']}"), 204)


def test_announcements_reach_the_right_people(workspace, owner):
    ws = workspace()
    person = ws.add_person()
    everyone = ok(owner.api.post("/api/platform/announcements", {"title": f"Maintenance {unique()}", "level": "warning"}), 201)
    admins = ok(owner.api.post("/api/platform/announcements", {"title": f"Admins {unique()}", "audience": "admins"}), 201)
    try:
        member_sees = {a["id"] for a in ok(person.api.get("/api/announcements"))}
        admin_sees = {a["id"] for a in ok(ws.admin.api.get("/api/announcements"))}
        assert everyone["id"] in member_sees and admins["id"] not in member_sees
        assert {everyone["id"], admins["id"]} <= admin_sees
        ok(owner.api.patch(f"/api/platform/announcements/{everyone['id']}", {"active": False}))
        assert everyone["id"] not in {a["id"] for a in ok(person.api.get("/api/announcements"))}
    finally:
        for a in (everyone, admins):
            owner.api.delete(f"/api/platform/announcements/{a['id']}")


def test_support_conversations(workspace, owner):
    ws = workspace()
    asker, other = ws.add_person(), ws.add_person()
    ticket = ok(asker.api.post("/api/support/tickets", {"subject": "Cannot export", "body": "Help please"}), 201)
    assert ok(other.api.get("/api/support/tickets"))["tickets"] == []
    assert len(ok(ws.admin.api.get("/api/support/tickets"))["tickets"]) == 1
    fails(other.api.get(f"/api/support/tickets/{ticket['id']}"), 404)
    fails(ws.admin.api.get(f"/api/platform/support/{ticket['id']}"), 404)

    inbox = ok(owner.api.get("/api/platform/support?status=open"))
    assert ticket["id"] in [t["id"] for t in inbox["tickets"]]
    answered = ok(owner.api.post(f"/api/platform/support/{ticket['id']}/reply", {"body": "Use Billing, Export"}))
    assert answered["status"] == "answered" and answered["messages"][-1]["from_staff"]
    assert ok(asker.api.post(f"/api/support/tickets/{ticket['id']}/reply", {"body": "thanks"}))["status"] == "open"
    assert ok(asker.api.post(f"/api/support/tickets/{ticket['id']}/close"))["status"] == "closed"


def test_analytics_and_status_page(owner, anon, workspace):
    workspace()
    analytics = ok(owner.api.get("/api/platform/analytics"))
    assert len(analytics["weeks"]) == 12 and analytics["weeks"][-1]["signups"] >= 1
    status = ok(anon.get("/api/public/status"))
    assert status["state"] in ("operational", "degraded") and len(status["days"]) == 90
    incident = ok(owner.api.post("/api/platform/incidents", {"title": "Slow pages", "impact": "major", "text": "Looking"}), 201)
    try:
        assert ok(anon.get("/api/public/status"))["state"] == "major"
        resolved = ok(owner.api.post(f"/api/platform/incidents/{incident['id']}/updates", {"status": "resolved", "text": "Fixed"}))
        assert resolved["status"] == "resolved" and len(resolved["updates"]) == 2
        assert ok(anon.get("/api/public/status"))["state"] != "major"
    finally:
        owner.api.delete(f"/api/platform/incidents/{incident['id']}")


def test_legal_pages_are_public(anon):
    legal = ok(anon.get("/api/public/legal"))
    assert legal["terms"] and legal["privacy"]
