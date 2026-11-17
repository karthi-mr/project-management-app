"""Workspace IDs: the same username and email may exist in several workspaces, and people say
which workspace they mean by its ID when they sign in."""
import re

from conftest import Api, fails, ok, unique


def login(anon, workspace, username, password):
    return anon.post("/api/auth/login", {"workspace": workspace, "username": username, "password": password})


def test_every_workspace_gets_a_random_eight_digit_id(workspace):
    a, b = workspace(), workspace()
    for ws in (a, b):
        assert re.fullmatch(r"[1-9]\d{3}-\d{4}", ws.public_id)
    assert a.public_id != b.public_id
    assert ok(a.admin.api.get("/api/auth/me"))["org"]["public_id"] == a.public_id


def test_same_username_and_email_in_two_workspaces_are_separate_accounts(workspace, anon):
    a, b = workspace(), workspace()
    name = unique("sam")
    email = f"{name}@example.com"
    for ws, password in ((a, "Temp#Pass123"), (b, "Temp#Pass456")):
        ok(ws.admin.api.post("/api/users", {"username": name, "full_name": "Sam", "email": email, "password": password}), 201)

    in_a = ok(login(anon, a.public_id, name, "Temp#Pass123"))
    in_b = ok(login(anon, b.public_id, email.upper(), "Temp#Pass456"))
    assert in_a["user"]["id"] != in_b["user"]["id"]
    assert in_a["user"]["org"]["id"] == a.org_id and in_b["user"]["org"]["id"] == b.org_id
    # Each account has its own password: A's password does not open B.
    fails(login(anon, b.public_id, name, "Temp#Pass123"), 401)
    # Each account belongs to its own workspace.
    assert ok(Api(anon.client, in_a["access_token"]).get("/api/auth/me"))["org"]["id"] == a.org_id
    assert ok(Api(anon.client, in_b["access_token"]).get("/api/auth/me"))["org"]["id"] == b.org_id
    assert in_a["user"]["id"] not in {p["id"] for p in ok(b.admin.api.get("/api/users"))}


def test_usernames_and_emails_are_still_unique_inside_a_workspace(workspace):
    ws = workspace()
    person = ws.add_person()
    fails(ws.admin.api.post("/api/users", {"username": person.username, "full_name": "x", "email": f"{unique()}@example.com", "password": "Temp#Pass123"}), 409, "this workspace")
    fails(ws.admin.api.post("/api/users", {"username": unique("x"), "full_name": "x", "email": f"{person.username}@example.com", "password": "Temp#Pass123"}), 409, "this workspace")
    fails(ws.admin.api.patch(f"/api/users/{person.id}", {"email": f"{ws.username}@example.com"}), 409)


def test_the_same_person_can_sign_up_two_companies(anon):
    name = unique("founder")
    sessions = []
    for company in ("First Co", "Second Co"):
        sessions.append(ok(anon.post("/api/auth/register", {
            "company": company, "full_name": "Fran", "email": f"{name}@example.com", "username": name,
            "password": "Admin#Pass123", "accept_terms": True,
        }), 201))
    assert sessions[0]["user"]["org"]["public_id"] != sessions[1]["user"]["org"]["public_id"]


def test_wrong_workspace_gives_the_same_answer_as_a_wrong_password(workspace, anon):
    ws = workspace()
    other = workspace()
    wrong_password = fails(login(anon, ws.public_id, ws.username, "nope"), 401)
    unknown_workspace = fails(login(anon, "1234-0000", ws.username, ws.password), 401)
    wrong_workspace = fails(login(anon, other.public_id, ws.username, ws.password), 401)
    garbage = fails(login(anon, "not a workspace!", ws.username, ws.password), 401)
    assert wrong_password == unknown_workspace == wrong_workspace == garbage
    fails(anon.post("/api/auth/login", {"username": ws.username, "password": ws.password}), 422)


def test_the_id_may_be_typed_with_spaces_or_without_the_dash_or_as_the_sign_in_address(workspace, anon):
    ws = workspace()
    digits = ws.public_id.replace("-", "")
    ok(login(anon, digits, ws.username, ws.password))
    ok(login(anon, f" {digits[:4]} {digits[4:]} ", ws.username, ws.password))
    slug = unique("acme").lower()[:30]
    me = ok(ws.admin.api.get("/api/auth/me"))
    ok(ws.admin.api.patch("/api/billing/workspace", {"name": me["org"]["name"], "slug": slug}))
    ok(login(anon, slug.upper(), ws.username, ws.password))
    brand = ok(anon.get(f"/api/public/workspace/{slug}"))
    assert brand["public_id"] == ws.public_id


def test_find_my_workspace_needs_the_right_password(workspace, anon):
    a, b = workspace(), workspace()
    name = unique("multi")
    email = f"{name}@example.com"
    for ws in (a, b):
        person = ws.admin.api.post("/api/users", {"username": name, "full_name": "M", "email": email, "password": "Temp#Pass123"})
        ok(person, 201)
    found = ok(anon.post("/api/auth/find-workspace", {"email": email.upper(), "password": "Temp#Pass123"}))
    assert sorted(w["public_id"] for w in found) == sorted([a.public_id, b.public_id])
    assert {w["username"] for w in found} == {name}
    # Without the right password nothing is revealed, not even whether the email exists.
    missing = fails(anon.post("/api/auth/find-workspace", {"email": email, "password": "wrong"}), 404)
    nobody = fails(anon.post("/api/auth/find-workspace", {"email": f"{unique()}@example.com", "password": "wrong"}), 404)
    assert missing == nobody
    for _ in range(4):
        fails(anon.post("/api/auth/find-workspace", {"email": email, "password": "wrong"}), 404)
    fails(anon.post("/api/auth/find-workspace", {"email": email, "password": "Temp#Pass123"}), 429)


def test_forgot_password_goes_to_the_right_workspace(workspace, anon):
    a, b = workspace(), workspace()
    name = unique("lost")
    ids = {}
    for ws in (a, b):
        ids[ws.org_id] = ok(ws.admin.api.post("/api/users", {"username": name, "full_name": "L", "email": f"{name}@example.com", "password": "Temp#Pass123"}), 201)["user"]["id"]
    ok(anon.post("/api/auth/forgot-password", {"workspace": b.public_id, "identifier": name}))
    assert [r["user"]["id"] for r in ok(b.admin.api.get("/api/admin/reset-requests"))] == [ids[b.org_id]]
    assert ok(a.admin.api.get("/api/admin/reset-requests")) == []


def test_platform_owner_finds_a_workspace_by_its_id(owner, workspace):
    ws = workspace()
    found = ok(owner.api.get(f"/api/platform/organizations?q={ws.public_id}"))
    assert [o["id"] for o in found] == [ws.org_id]
    assert found[0]["public_id"] == ws.public_id
