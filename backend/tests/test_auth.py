"""Signing in, passwords, profiles, sessions and the per-workspace security settings."""
from conftest import MEMBER_PASSWORD, Api, fails, ok, unique


def login(anon, username, password):
    return anon.post("/api/auth/login", {"username": username, "password": password})


def test_first_sign_in_forces_a_password_change(workspace, anon):
    ws = workspace()
    username = unique("new")
    ok(ws.admin.api.post("/api/users", {"username": username, "full_name": "New Person", "email": f"{username}@example.com", "password": "Temp#Pass123"}), 201)
    session = ok(login(anon, username, "Temp#Pass123"))
    assert session["user"]["must_change_password"] is True
    temp = Api(anon.client, session["access_token"])
    fails(temp.get("/api/projects"), 403, "PASSWORD_CHANGE_REQUIRED")
    fails(temp.post("/api/auth/change-password", {"current_password": "wrong", "new_password": "Brand#New123"}), 400)
    fails(temp.post("/api/auth/change-password", {"current_password": "Temp#Pass123", "new_password": "Temp#Pass123"}), 400)
    fails(temp.post("/api/auth/change-password", {"current_password": "Temp#Pass123", "new_password": "short"}), 422)
    changed = ok(temp.post("/api/auth/change-password", {"current_password": "Temp#Pass123", "new_password": "Brand#New123"}))
    assert changed["user"]["must_change_password"] is False
    ok(Api(anon.client, changed["access_token"]).get("/api/projects"))
    fails(temp.get("/api/auth/me"), 401)  # the old token stops working


def test_login_by_username_or_email_and_wrong_password(workspace, anon):
    ws = workspace()
    ok(login(anon, ws.username, ws.password))
    ok(login(anon, f"{ws.username.upper()}@EXAMPLE.COM", ws.password))
    fails(login(anon, ws.username, "nope"), 401)
    fails(login(anon, "nobody-here", "nope"), 401)


def test_repeated_wrong_passwords_lock_the_account_for_a_while(workspace, anon):
    ws = workspace()
    for _ in range(5):
        fails(login(anon, ws.username, "wrong"), 401)
    fails(login(anon, ws.username, ws.password), 429)  # even the right password waits


def test_disabled_account_cannot_sign_in(workspace, anon):
    ws = workspace()
    person = ws.add_person()
    ok(ws.admin.api.patch(f"/api/users/{person.id}", {"is_active": False}))
    fails(login(anon, person.username, MEMBER_PASSWORD), 403, "disabled")
    fails(person.api.get("/api/projects"), 401)


def test_unauthenticated_and_garbage_tokens(anon):
    fails(anon.get("/api/projects"), 401)
    fails(Api(anon.client, "not-a-token").get("/api/projects"), 401)


def test_forgot_password_does_not_reveal_accounts_and_reaches_the_admin(workspace, anon):
    ws = workspace()
    person = ws.add_person()
    known = ok(anon.post("/api/auth/forgot-password", {"identifier": person.username, "note": "locked out"}))
    unknown = ok(anon.post("/api/auth/forgot-password", {"identifier": "nobody-at-all"}))
    assert known == unknown
    requests = ok(ws.admin.api.get("/api/admin/reset-requests"))
    assert [r["user"]["id"] for r in requests if r["status"] == "pending"] == [person.id]
    reset = ok(ws.admin.api.post(f"/api/users/{person.id}/reset-password", {}))
    assert ok(login(anon, person.username, reset["temporary_password"]))["user"]["must_change_password"]


def test_profile_and_preferences(workspace):
    ws = workspace()
    other = workspace()
    me = ok(ws.admin.api.patch("/api/auth/profile", {"full_name": "Renamed Person", "email": f"{unique('r')}@example.com"}))
    assert me["full_name"] == "Renamed Person"
    # Emails are unique across all workspaces.
    fails(ws.admin.api.patch("/api/auth/profile", {"full_name": "x", "email": f"{other.username}@example.com"}), 409)
    me = ok(ws.admin.api.put("/api/auth/preferences", {"preferences": {"language": "ta", "timezone": "Asia/Kolkata"}}))
    assert me["preferences"]["language"] == "ta"
    fails(ws.admin.api.put("/api/auth/preferences", {"preferences": {"x": "y" * 9000}}), 422)
    fails(ws.admin.api.put("/api/auth/avatar", {"url": "https://evil.example/x.png"}), 422)


def test_sessions_can_be_listed_and_ended(workspace, anon):
    ws = workspace()
    second = Api(anon.client, ok(login(anon, ws.username, ws.password))["access_token"])
    sessions = ok(second.get("/api/auth/sessions"))
    assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
    first = next(s for s in sessions if not s["current"])
    ok(second.delete(f"/api/auth/sessions/{first['id']}"), 204)
    fails(ws.admin.api.get("/api/auth/me"), 401)
    third = Api(anon.client, ok(login(anon, ws.username, ws.password))["access_token"])
    ok(third.post("/api/auth/sessions/sign-out-others"), 204)
    fails(second.get("/api/auth/me"), 401)
    ok(third.get("/api/auth/me"))


def test_password_change_signs_out_every_other_session(workspace, anon):
    ws = workspace()
    other = Api(anon.client, ok(login(anon, ws.username, ws.password))["access_token"])
    fresh = ok(ws.admin.api.post("/api/auth/change-password", {"current_password": ws.password, "new_password": "Another#Pass456"}))
    fails(other.get("/api/auth/me"), 401)
    ok(Api(anon.client, fresh["access_token"]).get("/api/auth/me"))


def test_admin_security_settings(workspace, anon):
    ws = workspace()
    person = ws.add_person()
    fails(person.api.get("/api/admin/security"), 403)
    settings = ok(ws.admin.api.get("/api/admin/security"))
    assert settings["password_min_length"] == 8 and settings["require_two_factor"] is False
    assert len(settings["sessions"]) >= 2
    base = {"password_min_length": 12, "password_require_symbol": True, "password_require_mixed_case": True, "ip_allowlist": ""}
    ok(ws.admin.api.put("/api/admin/security", base))
    fails(person.api.post("/api/auth/change-password", {"current_password": MEMBER_PASSWORD, "new_password": "short#1A"}), 422, "12")
    fails(person.api.post("/api/auth/change-password", {"current_password": MEMBER_PASSWORD, "new_password": "alllowercase#1234"}), 422)
    ok(person.api.post("/api/auth/change-password", {"current_password": MEMBER_PASSWORD, "new_password": "Long#Enough12345"}))
    fails(ws.admin.api.put("/api/admin/security", {**base, "ip_allowlist": "not-an-address"}), 422)
    # The test client has no real address, so any list would lock the admin out and is refused.
    fails(ws.admin.api.put("/api/admin/security", {**base, "ip_allowlist": "203.0.113.0/24"}), 422, "lock you out")


def test_admin_can_force_someone_out_everywhere(workspace):
    ws = workspace()
    person = ws.add_person()
    fails(person.api.post(f"/api/users/{ws.admin.id}/sign-out"), 403)
    ok(ws.admin.api.post(f"/api/users/{person.id}/sign-out"), 204)
    fails(person.api.get("/api/auth/me"), 401)


def test_only_admins_manage_users(workspace):
    ws = workspace()
    person = ws.add_person()
    fails(person.api.post("/api/users", {"username": unique(), "full_name": "x", "email": f"{unique()}@example.com"}), 403)
    fails(person.api.patch(f"/api/users/{ws.admin.id}", {"full_name": "Hacked"}), 403)
    created = ok(ws.admin.api.post("/api/users", {"username": unique("g"), "full_name": "Generated", "email": f"{unique()}@example.com"}), 201)
    assert len(created["temporary_password"]) >= 10  # generated when none is given
