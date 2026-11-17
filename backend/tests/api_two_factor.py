"""API test for two-factor sign-in.

Runs against a running server with a fresh or throwaway database (it creates workspaces and users):

    BASE=http://127.0.0.1:8791 PW='<admin password>' python tests/api_two_factor.py

PW is the admin's current password; it is changed to Owner#12345 during the test.
It waits about 30 seconds once, for a fresh authenticator code. Never point it at real data.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.environ.get("BASE", "http://127.0.0.1:8791")
OWNER_PW = os.environ.get("PW", "Admin@123")
fails = []


def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            data = r.read()
            return r.status, (json.loads(data) if data else None)
    except urllib.error.HTTPError as e:
        data = e.read()
        try:
            return e.code, json.loads(data)
        except Exception:
            return e.code, data.decode()[:300]


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else str(extra)[:400])
    if not cond:
        fails.append(name)


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import twofactor as tf
def code(secret, offset=0): return tf._code_at(secret, tf.current_step() + offset)

s, r = call("POST", "/api/auth/login", body={"username": "admin", "password": OWNER_PW}); T0 = r["access_token"]
s, r = call("POST", "/api/auth/change-password", T0, {"current_password": OWNER_PW, "new_password": "Owner#12345"})
reg = {"company": "Twofa", "full_name": "Tia T", "email": "tia@twofa.example.com", "username": "tia", "password": "Secret#123", "accept_terms": True}
s, r = call("POST", "/api/auth/register", body=reg); TA = r["access_token"]; check("register", s == 201, r)
s, r = call("POST", "/api/users", TA, {"username": "tfdev", "full_name": "Dev", "email": "dev@twofa.example.com", "password": "Temp#12345"}); DEV = r["user"]["id"]
s, r = call("POST", "/api/auth/login", body={"username": "tfdev", "password": "Temp#12345"})
s, r = call("POST", "/api/auth/change-password", r["access_token"], {"current_password": "Temp#12345", "new_password": "Final#12345"}); TD = r["access_token"]

# setup
s, r = call("GET", "/api/auth/2fa", TA); check("status off", s == 200 and r["enabled"] is False and r["required"] is False, r)
s, r = call("POST", "/api/auth/2fa/setup", TA); check("setup", s == 200 and r["uri"].startswith("otpauth://totp/") and "<svg" in r["qr_svg"], {k: str(v)[:60] for k, v in (r.items() if isinstance(r, dict) else [])}); SECRET = r["secret"].replace(" ", "")
check("uri carries secret and issuer", f"secret={SECRET}" in r["uri"] and "issuer=" in r["uri"], r["uri"])
s, r = call("POST", "/api/auth/2fa/enable", TA, {"code": "000000" if code(SECRET) != "000000" else "111111"}); check("wrong code refused", s == 422, r)
s, r = call("POST", "/api/auth/2fa/enable", TA, {"code": code(SECRET)}); check("enabled", s == 200 and len(r["recovery_codes"]) == 10 and r["user"]["two_factor_enabled"], r); RC = r["recovery_codes"]
s, r = call("POST", "/api/auth/2fa/setup", TA); check("no second setup while on", s == 400, r)
s, r = call("GET", "/api/projects", TA); check("existing session keeps working", s == 200, r)

# login
s, r = call("POST", "/api/auth/login", body={"username": "tia", "password": "Secret#123"}); check("password step asks for code", s == 200 and r.get("two_factor_required") and "access_token" not in r, r); CH = r["challenge"]
s, r = call("GET", "/api/projects", CH); check("challenge is not a sign-in", s == 401, r)
s, r = call("GET", "/api/auth/me", CH); check("challenge cannot read me", s == 401, r)
s, r = call("POST", "/api/auth/login/2fa", body={"challenge": CH, "code": code(SECRET)}); check("same code cannot be reused", s == 401, r)
s, r = call("POST", "/api/auth/login/2fa", body={"challenge": CH, "code": code(SECRET, 1)}); check("next code signs in", s == 200 and r["access_token"], r); TA2 = r["access_token"]
s, r = call("POST", "/api/auth/login/2fa", body={"challenge": CH, "code": code(SECRET, 1)}); check("replay refused", s == 401, r)
s, r = call("POST", "/api/auth/login/2fa", body={"challenge": "garbage", "code": "123456"}); check("bad challenge", s == 401, r)
s, r = call("POST", "/api/auth/login/2fa", body={"challenge": T0, "code": "123456"}); check("access token is not a challenge", s == 401, r)
# recovery code
s, r = call("POST", "/api/auth/login", body={"username": "tia", "password": "Secret#123"}); CH = r["challenge"]
s, r = call("POST", "/api/auth/login/2fa", body={"challenge": CH, "code": RC[0].upper()}); check("recovery code signs in", s == 200 and r["recovery_codes_left"] == 9, r)
s, r = call("POST", "/api/auth/login/2fa", body={"challenge": CH, "code": RC[0]}); check("recovery code works once", s == 401, r)

# admin requires 2fa
s, r = call("PUT", "/api/admin/security", TA2, {"password_min_length": 8, "password_require_symbol": False, "password_require_mixed_case": False, "ip_allowlist": "", "require_two_factor": True}); check("require saved", s == 200 and r["require_two_factor"] and r["two_factor_users"] == 1, r)
s, r = call("GET", "/api/projects", TD); check("member without 2fa is held", s == 403 and r["detail"] == "TWO_FACTOR_SETUP_REQUIRED", r)
s, r = call("GET", "/api/auth/me", TD); check("me says setup required", s == 200 and r["two_factor_setup_required"], r)
s, r = call("POST", "/api/auth/2fa/setup", TD); DS = r["secret"].replace(" ", "")
s, r = call("POST", "/api/auth/2fa/enable", TD, {"code": code(DS)}); check("member sets up", s == 200, r)
s, r = call("GET", "/api/projects", TD); check("member released", s == 200, r)
s, r = call("POST", "/api/auth/2fa/disable", TD, {"password": "Final#12345", "code": code(DS, 1)}); check("cannot turn off when required", s == 403, r)
s, r = call("GET", "/api/admin/security", TD); check("member cannot change security", s == 403, r)
# admin can't require without own 2fa: check on a fresh workspace
reg2 = {"company": "NoTwo", "full_name": "Nia", "email": "nia@notwo.example.com", "username": "nia", "password": "Secret#123", "accept_terms": True}
s, r = call("POST", "/api/auth/register", body=reg2); TN = r["access_token"]
s, r = call("PUT", "/api/admin/security", TN, {"password_min_length": 8, "password_require_symbol": False, "password_require_mixed_case": False, "ip_allowlist": "", "require_two_factor": True}); check("cannot require without own 2fa", s == 422, r)

# admin reset for lost phone
s, r = call("POST", f"/api/users/{DEV}/reset-2fa", TA2); check("admin reset", s == 204, r)
s, r = call("GET", "/api/auth/me", TD); check("reset signs them out", s == 401, r)
s, r = call("POST", "/api/auth/login", body={"username": "tfdev", "password": "Final#12345"}); check("after reset: password only, then setup", s == 200 and "access_token" in r, r); TD = r["access_token"]
s, r = call("GET", "/api/projects", TD); check("held for setup again", s == 403 and r["detail"] == "TWO_FACTOR_SETUP_REQUIRED", r)
s, r = call("GET", "/api/users", TA2); dev = [u for u in r if u["id"] == DEV][0]; check("users list shows 2fa", dev["two_factor_enabled"] is False and [u for u in r if u["username"] == "tia"][0]["two_factor_enabled"], dev)

# turn off (optional workspace) + new recovery codes
s, r = call("PUT", "/api/admin/security", TA2, {"password_min_length": 8, "password_require_symbol": False, "password_require_mixed_case": False, "ip_allowlist": "", "require_two_factor": False})
print("  waiting 31s for a fresh authenticator code…"); time.sleep(31)
s, r = call("POST", "/api/auth/2fa/recovery-codes", TA2, {"code": code(SECRET, 1)}); check("new recovery codes", s == 200 and len(r["recovery_codes"]) == 10, r); RC2 = r["recovery_codes"]
s, r = call("POST", "/api/auth/login", body={"username": "tia", "password": "Secret#123"}); CH = r.get("challenge")
s, r = call("POST", "/api/auth/login/2fa", body={"challenge": CH, "code": RC[1]}); check("old recovery codes dead", s in (401, 429), r)
s, r = call("POST", "/api/auth/2fa/disable", TA2, {"password": "wrong", "code": RC2[0]}); check("disable needs password", s == 403, r)
s, r = call("POST", "/api/auth/2fa/disable", TA2, {"password": "Secret#123", "code": RC2[0]}); check("disable with recovery code", s == 200 and r["two_factor_enabled"] is False, r)
s, r = call("POST", "/api/auth/login", body={"username": "tia", "password": "Secret#123"}); check("password-only sign-in again", s == 200 and "access_token" in r, r)
# throttle (last: it locks the account's code checks for ten minutes)
s, r = call("POST", "/api/auth/2fa/setup", TA2); SECRET = r["secret"].replace(" ", "")
s, r = call("POST", "/api/auth/2fa/enable", TA2, {"code": code(SECRET)})
s, r = call("POST", "/api/auth/login", body={"username": "tia", "password": "Secret#123"}); CH = r["challenge"]
codes = [call("POST", "/api/auth/login/2fa", body={"challenge": CH, "code": "99999" + str(i)})[0] for i in range(6)]
check("wrong codes are throttled", codes[:5] == [401] * 5 and codes[-1] == 429, codes)
s, r = call("POST", "/api/auth/login/2fa", body={"challenge": CH, "code": code(SECRET, 1)}); check("even a right code waits out the lock", s == 429, r)
print("\nFAILED:", fails or "none")
sys.exit(1 if fails else 0)
