"""Two-factor sign-in with an authenticator app."""
import pytest

from app import twofactor
from conftest import Api, fails, ok


@pytest.fixture
def clock(monkeypatch):
    """Control the authenticator's 30-second steps: clock.advance() moves to the next code."""
    real = twofactor.current_step

    class Clock:
        offset = 0

        def advance(self, steps=1):
            self.offset += steps

        def code(self, secret, ahead=0):
            return twofactor._code_at(secret, real() + self.offset + ahead)

    c = Clock()
    monkeypatch.setattr(twofactor, "current_step", lambda now=None: real(now) + c.offset)
    return c


def turn_on(person, clock):
    setup = ok(person.api.post("/api/auth/2fa/setup"))
    secret = setup["secret"].replace(" ", "")
    enabled = ok(person.api.post("/api/auth/2fa/enable", {"code": clock.code(secret)}))
    clock.advance()
    return secret, enabled["recovery_codes"]


def sign_in(anon, username, password, code):
    first = ok(anon.post("/api/auth/login", {"username": username, "password": password}))
    assert first["two_factor_required"] and "access_token" not in first
    return anon.post("/api/auth/login/2fa", {"challenge": first["challenge"], "code": code})


def test_setup_gives_a_qr_code_and_needs_a_correct_code(workspace, clock):
    ws = workspace()
    status = ok(ws.admin.api.get("/api/auth/2fa"))
    assert status == {"enabled": False, "enabled_at": None, "recovery_codes_left": 0, "required": False}
    setup = ok(ws.admin.api.post("/api/auth/2fa/setup"))
    secret = setup["secret"].replace(" ", "")
    assert setup["uri"].startswith("otpauth://totp/") and f"secret={secret}" in setup["uri"]
    assert setup["qr_svg"].startswith("<svg")
    wrong = "000000" if clock.code(secret) != "000000" else "111111"
    fails(ws.admin.api.post("/api/auth/2fa/enable", {"code": wrong}), 422)
    enabled = ok(ws.admin.api.post("/api/auth/2fa/enable", {"code": clock.code(secret)}))
    assert len(enabled["recovery_codes"]) == 10 and enabled["user"]["two_factor_enabled"]
    fails(ws.admin.api.post("/api/auth/2fa/setup"), 400)
    ok(ws.admin.api.get("/api/projects"))  # the current session keeps working


def test_sign_in_needs_the_code_and_codes_cannot_be_replayed(workspace, anon, clock):
    ws = workspace()
    secret, _ = turn_on(ws.admin, clock)
    first = ok(anon.post("/api/auth/login", {"username": ws.username, "password": ws.password}))
    challenge = first["challenge"]
    # The half-finished sign-in is not a sign-in.
    fails(Api(anon.client, challenge).get("/api/projects"), 401)
    fails(Api(anon.client, challenge).get("/api/auth/me"), 401)
    code = clock.code(secret)
    session = ok(anon.post("/api/auth/login/2fa", {"challenge": challenge, "code": code}))
    ok(Api(anon.client, session["access_token"]).get("/api/projects"))
    fails(anon.post("/api/auth/login/2fa", {"challenge": challenge, "code": code}), 401)  # replay
    fails(anon.post("/api/auth/login/2fa", {"challenge": "garbage", "code": "123456"}), 401, "expired")
    fails(anon.post("/api/auth/login/2fa", {"challenge": session["access_token"], "code": "123456"}), 401)


def test_recovery_codes_work_once_and_can_be_renewed(workspace, anon, clock):
    ws = workspace()
    secret, codes = turn_on(ws.admin, clock)
    session = ok(sign_in(anon, ws.username, ws.password, codes[0].upper()))
    assert session["recovery_codes_left"] == 9
    fails(sign_in(anon, ws.username, ws.password, codes[0]), 401)
    renewed = ok(ws.admin.api.post("/api/auth/2fa/recovery-codes", {"code": clock.code(secret)}))["recovery_codes"]
    clock.advance()
    fails(sign_in(anon, ws.username, ws.password, codes[1]), 401)  # old ones are dead
    ok(sign_in(anon, ws.username, ws.password, renewed[0]))
    assert ok(ws.admin.api.get("/api/auth/2fa"))["recovery_codes_left"] == 9


def test_wrong_codes_lock_the_account_codes_for_a_while(workspace, anon, clock):
    ws = workspace()
    secret, _ = turn_on(ws.admin, clock)
    challenge = ok(anon.post("/api/auth/login", {"username": ws.username, "password": ws.password}))["challenge"]
    statuses = [anon.post("/api/auth/login/2fa", {"challenge": challenge, "code": f"99999{n}"}).status_code for n in range(6)]
    assert statuses == [401] * 5 + [429]
    fails(anon.post("/api/auth/login/2fa", {"challenge": challenge, "code": clock.code(secret)}), 429)


def test_turning_it_off_needs_password_and_code(workspace, anon, clock):
    ws = workspace()
    secret, codes = turn_on(ws.admin, clock)
    fails(ws.admin.api.post("/api/auth/2fa/disable", {"password": "wrong", "code": codes[0]}), 403)
    me = ok(ws.admin.api.post("/api/auth/2fa/disable", {"password": ws.password, "code": codes[0]}))
    assert me["two_factor_enabled"] is False
    assert "access_token" in ok(anon.post("/api/auth/login", {"username": ws.username, "password": ws.password}))


def test_workspace_can_require_two_factor(workspace, anon, clock):
    ws = workspace()
    person = ws.add_person()
    settings = {"password_min_length": 8, "password_require_symbol": False, "password_require_mixed_case": False, "ip_allowlist": ""}
    # The admin must have it first, so they cannot lock themselves out.
    fails(ws.admin.api.put("/api/admin/security", {**settings, "require_two_factor": True}), 422)
    turn_on(ws.admin, clock)
    saved = ok(ws.admin.api.put("/api/admin/security", {**settings, "require_two_factor": True}))
    assert saved["require_two_factor"] and saved["two_factor_users"] == 1

    fails(person.api.get("/api/projects"), 403, "TWO_FACTOR_SETUP_REQUIRED")
    assert ok(person.api.get("/api/auth/me"))["two_factor_setup_required"] is True
    secret, codes = turn_on(person, clock)
    ok(person.api.get("/api/projects"))
    fails(person.api.post("/api/auth/2fa/disable", {"password": person.password, "code": codes[0]}), 403, "requires")


def test_admin_reset_for_a_lost_phone(workspace, anon, clock):
    ws = workspace()
    person = ws.add_person()
    turn_on(person, clock)
    users = {u["id"]: u for u in ok(ws.admin.api.get("/api/users"))}
    assert users[person.id]["two_factor_enabled"] is True
    fails(person.api.post(f"/api/users/{ws.admin.id}/reset-2fa"), 403)
    fails(ws.admin.api.post(f"/api/users/{ws.admin.id}/reset-2fa"), 400)
    ok(ws.admin.api.post(f"/api/users/{person.id}/reset-2fa"), 204)
    fails(person.api.get("/api/auth/me"), 401)  # signed out everywhere
    assert "access_token" in ok(anon.post("/api/auth/login", {"username": person.username, "password": person.password}))


def test_two_factor_belongs_to_one_workspace(workspace, clock):
    a, b = workspace(), workspace()
    person = a.add_person()
    turn_on(person, clock)
    fails(b.admin.api.post(f"/api/users/{person.id}/reset-2fa"), 404)
