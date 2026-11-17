"""Workspaces: sign-up, keeping customers' data apart, plan limits and the read-only states."""
from conftest import Api, fails, ok, unique


def register(anon, **overrides):
    username = unique("s")
    body = {"company": "Signup Co", "full_name": "Sign Up", "email": f"{username}@example.com",
            "username": username, "password": "Secret#123", "accept_terms": True, **overrides}
    return anon.post("/api/auth/register", body)


# ───────────── Sign-up ─────────────


def test_public_plans_hide_the_trial(anon):
    data = ok(anon.get("/api/public/plans"))
    assert [p["key"] for p in data["plans"]] == ["starter", "business", "enterprise"]
    assert data["settings"]["allow_signup"] is True


def test_sign_up_creates_a_trial_workspace_with_an_example_project(anon):
    session = ok(register(anon), 201)
    user, org = session["user"], session["user"]["org"]
    assert user["role"] == "admin" and not user["is_platform_admin"]
    assert org["status"] == "trial" and org["days_left"] == 14 and org["plan"]["key"] == "trial"
    api = Api(anon.client, session["access_token"])
    projects = ok(api.get("/api/projects"))
    assert len(projects) == 1 and projects[0]["issue_count"] == 6
    onboarding = ok(api.get("/api/onboarding"))
    assert onboarding["show"] and onboarding["total"] == 6
    ok(api.post("/api/onboarding/dismiss"), 204)
    assert ok(api.get("/api/onboarding"))["show"] is False


def test_sign_up_validation(anon, workspace):
    existing = workspace()
    fails(register(anon, accept_terms=False), 422, "terms")
    fails(register(anon, username=existing.username), 409)
    fails(register(anon, email=f"{existing.username}@example.com"), 409)
    fails(register(anon, website="http://spam.example"), 400)  # the hidden honeypot field
    fails(register(anon, username="bad name!"), 422)
    fails(register(anon, password="weak"), 422)


def test_sign_up_is_rate_limited_per_address(anon):
    for _ in range(5):
        ok(register(anon), 201)
    fails(register(anon), 429)


def test_owner_can_close_sign_up(anon, owner):
    settings = ok(owner.api.get("/api/platform/settings"))
    ok(owner.api.put("/api/platform/settings", {**settings, "allow_signup": False}))
    try:
        fails(register(anon), 403)
    finally:
        ok(owner.api.put("/api/platform/settings", {**settings, "allow_signup": True}))


# ───────────── Keeping workspaces apart ─────────────


def test_workspaces_cannot_see_each_other(workspace, owner):
    a, b = workspace("Alpha"), workspace("Beta")
    secret = a.project("SEC", description="Alpha's secret project")
    issue = ok(a.admin.api.post("/api/issues", {"project_id": secret["id"], "title": "Alpha secret issue"}), 201)
    feature = ok(a.admin.api.post(f"/api/projects/{secret['id']}/features", {"title": "Alpha feature", "stage": "proposed"}), 201)

    # The same project key is fine in another workspace.
    b.project("SEC")
    assert [p["key"] for p in ok(b.admin.api.get("/api/projects")) if p["key"] == "SEC"] == ["SEC"]

    for path in (f"/api/projects/{secret['id']}", f"/api/issues/{issue['id']}", f"/api/features/{feature['id']}",
                 f"/api/projects/{secret['id']}/milestones", f"/api/projects/{secret['id']}/activity"):
        assert b.admin.api.get(path).status_code in (403, 404), path
    for path in ("/api/projects", "/api/issues", "/api/users", "/api/roadmap", "/api/portfolio", "/api/dashboard",
                 "/api/trash", "/api/templates", "/api/notifications", "/api/chat/conversations"):
        body = ok(b.admin.api.get(path))
        assert "Alpha secret" not in str(body) and a.username not in str(body), path

    fails(b.admin.api.patch(f"/api/issues/{issue['id']}", {"title": "hacked"}), 404)
    fails(b.admin.api.post(f"/api/projects/{secret['id']}/members", {"user_id": b.admin.id}), 404)
    fails(b.admin.api.patch(f"/api/users/{a.admin.id}", {"full_name": "hacked"}), 404)
    assert b.admin.api.post("/api/chat/direct", {"user_id": a.admin.id}).status_code in (403, 404, 422)
    fails(b.admin.api.get("/api/platform/overview"), 404)  # the owner console is invisible to customers

    # The platform owner's own workspace is just another workspace.
    assert "Alpha secret" not in str(ok(owner.api.get("/api/projects")))


def test_people_from_another_workspace_cannot_be_added(workspace):
    a, b = workspace(), workspace()
    project = a.project()
    fails(a.admin.api.post(f"/api/projects/{project['id']}/members", {"user_id": b.admin.id}), 404)
    fails(a.admin.api.post("/api/issues", {"project_id": project["id"], "title": "x", "assignee_id": b.admin.id}), 422)


def test_audit_log_belongs_to_its_workspace(workspace):
    a, b = workspace(), workspace()
    entries = ok(a.admin.api.get("/api/admin/audit"))
    rows = entries if isinstance(entries, list) else entries.get("items", [])
    assert rows and all(b.username not in str(row) for row in rows)


# ───────────── Plan limits and features ─────────────


def test_trial_limits_users_and_projects(workspace):
    ws = workspace()  # the trial allows 5 users and 3 projects; the example project counts
    ws.project("PA")
    ws.project("PB")
    fails(ws.admin.api.post("/api/projects", {"name": "Fourth", "key": "PC"}), 402)
    for _ in range(4):
        ws.add_person()
    fails(ws.admin.api.post("/api/users", {"username": unique(), "full_name": "Sixth", "email": f"{unique()}@example.com"}), 402)


def test_disabled_people_free_a_seat(workspace):
    ws = workspace()
    people = [ws.add_person() for _ in range(4)]
    ok(ws.admin.api.patch(f"/api/users/{people[0].id}", {"is_active": False}))
    ws.add_person()
    fails(ws.admin.api.patch(f"/api/users/{people[0].id}", {"is_active": True}), 402)


def activate(owner, ws, plan_key, plans, seats=8, period="monthly"):
    request = ok(ws.admin.api.post("/api/billing/requests", {"plan_id": plans[plan_key]["id"], "seats": seats, "period": period}), 201)
    return ok(owner.api.post(f"/api/platform/requests/{request['id']}/approve", {"note": ""}))


def test_features_follow_the_plan(workspace, owner, plans):
    ws = workspace()
    project = ws.project()
    person = ws.add_person()
    activate(owner, ws, "starter", plans)
    assert ok(ws.admin.api.get("/api/auth/me"))["org"]["features"] == ["sprints", "customization"]
    fails(ws.admin.api.post(f"/api/projects/{project['id']}/automations", {"name": "x", "trigger": "issue_created", "config": {"action": {"type": "set_priority", "value": "high"}}}), 402)
    fails(ws.admin.api.post("/api/chat/groups", {"name": "Team", "member_ids": [person.id]}), 402)
    fails(ws.admin.api.get("/api/admin/audit"), 402)
    fails(ws.admin.api.get("/api/workload"), 402)
    ok(ws.admin.api.post(f"/api/projects/{project['id']}/sprints", {"name": "Sprint 1"}), 201)
    activate(owner, ws, "business", plans)
    ok(ws.admin.api.post("/api/chat/groups", {"name": "Team", "member_ids": [person.id]}), 201)


def test_expired_and_suspended_workspaces_are_read_only(workspace, owner, plans):
    ws = workspace()
    project = ws.project()
    ok(owner.api.patch(f"/api/platform/organizations/{ws.org_id}", {"valid_until": "2020-01-01"}))
    fails(ws.admin.api.post("/api/issues", {"project_id": project["id"], "title": "x"}), 402, "read-only")
    ok(ws.admin.api.get("/api/projects"))  # reading still works
    ok(ws.admin.api.get("/api/billing"))
    renewal = ok(ws.admin.api.post("/api/billing/requests", {"plan_id": plans["business"]["id"], "seats": 5, "period": "monthly"}), 201)
    ok(owner.api.post(f"/api/platform/requests/{renewal['id']}/approve", {"note": ""}))
    ok(ws.admin.api.post("/api/issues", {"project_id": project["id"], "title": "works again"}), 201)

    ok(owner.api.patch(f"/api/platform/organizations/{ws.org_id}", {"suspended": True}))
    fails(ws.admin.api.post("/api/issues", {"project_id": project["id"], "title": "x"}), 402, "suspended")
    fails(ws.admin.api.post("/api/billing/requests", {"plan_id": plans["business"]["id"], "seats": 5, "period": "monthly"}), 402)
    notices = [i for i in ok(ws.admin.api.get("/api/notifications"))["pending"] if i["kind"] == "license"]
    assert notices


# ───────────── Your data ─────────────


def test_export_contains_the_workspace_and_no_passwords(workspace):
    ws = workspace()
    person = ws.add_person()
    fails(person.api.get("/api/billing/export"), 403)
    response = ws.admin.api.get("/api/billing/export")
    assert response.status_code == 200 and "attachment" in response.headers["content-disposition"]
    data = response.json()
    assert {u["username"] for u in data["users"]} == {ws.username, person.username}
    assert len(data["projects"]) == 1 and len(data["issues"]) == 6
    for secret in ("password_hash", "token_version", "totp_secret", "totp_pending_secret", "recovery_codes", "totp_last_step"):
        assert secret not in response.text, f"{secret} must never be exported"
    assert all("two_factor_enabled" in u for u in data["users"])


def test_deleting_a_workspace_removes_everyone_in_it(workspace, owner):
    ws = workspace()
    person = ws.add_person()
    fails(ws.admin.api.post("/api/billing/delete-workspace", {"name": "wrong name", "password": ws.password}), 422)
    fails(ws.admin.api.post("/api/billing/delete-workspace", {"name": ws.name, "password": "wrong"}), 403)
    fails(owner.api.post("/api/billing/delete-workspace", {"name": "My workspace", "password": owner.password}), 400)
    ok(ws.admin.api.post("/api/billing/delete-workspace", {"name": ws.name, "password": ws.password}), 204)
    fails(person.api.get("/api/auth/me"), 401)
    fails(owner.api.get(f"/api/platform/organizations/{ws.org_id}"), 404)


def test_branding_and_sign_in_address(workspace, anon):
    a, b = workspace(), workspace()
    slug = unique("brand")
    org = ok(a.admin.api.patch("/api/billing/workspace", {"name": "Branded", "billing_email": "", "brand_color": "#e11d48", "slug": slug, "timezone": "Asia/Kolkata"}))
    assert org["slug"] == slug and org["brand_color"] == "#e11d48" and org["timezone"] == "Asia/Kolkata"
    fails(b.admin.api.patch("/api/billing/workspace", {"name": "Other", "billing_email": "", "slug": slug}), 409)
    fails(b.admin.api.patch("/api/billing/workspace", {"name": "Other", "billing_email": "", "slug": "api"}), 422)
    fails(b.admin.api.patch("/api/billing/workspace", {"name": "Other", "billing_email": "", "logo_url": "https://x.example/logo.png"}), 422)
    assert ok(anon.get(f"/api/public/workspace/{slug}"))["name"] == "Branded"
    fails(anon.get("/api/public/workspace/no-such-place"), 404)


# ───────────── Optional modules ─────────────


def test_new_workspaces_start_focused_and_admins_switch_modules(workspace, owner):
    ws = workspace()
    person = ws.add_person()
    modules = ok(ws.admin.api.get("/api/auth/me"))["org"]["modules"]
    assert modules["chat"] and modules["documents"] and modules["sprints"] and modules["client_access"]
    assert not modules["time"] and not modules["portfolio"] and not modules["tests"]
    fails(person.api.get("/api/admin/modules"), 403)
    fails(person.api.put("/api/admin/modules", {"modules": {"time": True}}), 403)
    fails(ws.admin.api.put("/api/admin/modules", {"modules": {"teleport": True}}), 422)
    rows = ok(ws.admin.api.put("/api/admin/modules", {"modules": {"time": True, "chat": False}}))
    state = {r["key"]: r["on"] for r in rows}
    assert state["time"] is True and state["chat"] is False and state["documents"] is True
    assert ok(person.api.get("/api/auth/me"))["org"]["modules"]["chat"] is False
    # Hiding is per workspace: the platform owner's workspace keeps everything.
    assert all(ok(owner.api.get("/api/auth/me"))["org"]["modules"].values())
