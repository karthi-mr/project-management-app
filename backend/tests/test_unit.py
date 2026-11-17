"""Unit tests for the rules that do not need the web layer."""
import base64
import json
from types import SimpleNamespace

import pytest

from app import signoff, twofactor
from app.saas import license_status, quote, seat_limit
from app.security import parse_allowlist, validate_password
from app.models import utcnow
from datetime import timedelta
from fastapi import HTTPException


# ───────────── Two-factor codes ─────────────

RFC_SECRET = base64.b32encode(b"12345678901234567890").decode().rstrip("=")


@pytest.mark.parametrize("when, expected", [
    (59, "287082"), (1111111109, "081804"), (1111111111, "050471"), (1234567890, "005924"), (2000000000, "279037"),
])
def test_totp_matches_rfc6238_vectors(when, expected):
    # RFC 6238 appendix B (SHA-1), last six digits.
    assert twofactor._code_at(RFC_SECRET, when // 30) == expected


def test_totp_accepts_one_step_of_drift_and_refuses_replay():
    now = 1_000_000_000
    step = now // 30
    current = twofactor._code_at(RFC_SECRET, step)
    assert twofactor.check_code(RFC_SECRET, current, now=now) == step
    assert twofactor.check_code(RFC_SECRET, twofactor._code_at(RFC_SECRET, step - 1), now=now) == step - 1
    assert twofactor.check_code(RFC_SECRET, twofactor._code_at(RFC_SECRET, step + 1), now=now) == step + 1
    assert twofactor.check_code(RFC_SECRET, twofactor._code_at(RFC_SECRET, step + 2), now=now) is None
    assert twofactor.check_code(RFC_SECRET, current, last_step=step, now=now) is None  # already used
    assert twofactor.check_code(RFC_SECRET, "12345", now=now) is None
    assert twofactor.check_code(RFC_SECRET, f"{current[:3]} {current[3:]}", now=now) == step  # spaces are fine


def test_new_secret_is_valid_base32_of_160_bits():
    secret = twofactor.new_secret()
    assert len(base64.b32decode(secret + "=" * (-len(secret) % 8))) == 20


def test_provisioning_uri():
    uri = twofactor.provisioning_uri("ABC", "ann@example.com", "Trackly")
    assert uri.startswith("otpauth://totp/Trackly:ann@example.com?")
    assert "secret=ABC" in uri and "issuer=Trackly" in uri and "period=30" in uri


def test_recovery_codes_work_once_and_ignore_case_and_dashes():
    codes, stored = twofactor.new_recovery_codes()
    assert len(codes) == 10 and len(set(codes)) == 10
    assert all(len(c) == 11 and c[5] == "-" for c in codes)
    assert not any(c in stored for c in codes), "codes must only be stored hashed"
    remaining = twofactor.use_recovery_code(stored, codes[3].upper().replace("-", ""))
    assert twofactor.recovery_left(remaining) == 9
    assert twofactor.use_recovery_code(remaining, codes[3]) is None
    assert twofactor.use_recovery_code(stored, "short") is None


# ───────────── Passwords and networks ─────────────


def test_default_password_policy():
    validate_password("abcdefg1")
    for bad in ("short1", "onlyletters", "12345678", "a" * 80 + "1"):
        with pytest.raises(HTTPException):
            validate_password(bad)


def test_workspace_password_policy():
    org = SimpleNamespace(password_min_length=12, password_require_symbol=True, password_require_mixed_case=True)
    validate_password("Abcdefghij1!", org)
    for bad in ("abcdefghij1!", "Abcdefghij12", "Abc1!"):
        with pytest.raises(HTTPException):
            validate_password(bad, org)


def test_allowlist_parsing():
    networks = parse_allowlist("203.0.113.7\n10.0.0.0/8, 2001:db8::/32\n\n")
    assert [str(n) for n in networks] == ["203.0.113.7/32", "10.0.0.0/8", "2001:db8::/32"]
    assert parse_allowlist("not-an-ip") == []
    with pytest.raises(ValueError):
        parse_allowlist("not-an-ip", strict=True)


# ───────────── Licences ─────────────


def _org(**kw):
    defaults = dict(suspended=False, valid_until=None, is_trial=False, seats=None, plan=None)
    return SimpleNamespace(**{**defaults, **kw})


def test_license_status():
    assert license_status(_org()) == "active"
    assert license_status(_org(is_trial=True, valid_until=utcnow() + timedelta(days=3))) == "trial"
    assert license_status(_org(valid_until=utcnow() - timedelta(seconds=1))) == "expired"
    assert license_status(_org(suspended=True, valid_until=utcnow() - timedelta(days=1))) == "suspended"


def test_seat_limit_is_the_smaller_of_purchase_and_plan():
    plan = SimpleNamespace(max_users=10)
    assert seat_limit(_org(seats=8, plan=plan)) == 8
    assert seat_limit(_org(seats=20, plan=plan)) == 10
    assert seat_limit(_org(seats=None, plan=SimpleNamespace(max_users=None))) is None


def test_quote_is_price_times_seats():
    plan = SimpleNamespace(price_monthly=6, price_yearly=60)
    assert quote(plan, 8, "monthly") == 48
    assert quote(plan, 8, "yearly") == 480


# ───────────── Lifecycle stages ─────────────


def test_next_stage():
    assert signoff.next_stage("feature", "proposed") == "planned"
    assert signoff.next_stage("feature", "released") is None
    assert signoff.next_stage("milestone", "deployment") == "completed"
    assert signoff.next_stage("milestone", "completed") is None


def test_feature_level_lines_up_with_milestone_stages():
    # A milestone stage corresponds to the feature stage of the same name; "proposed" is before "planned".
    for index, stage in enumerate(signoff.MILESTONE_STAGES[:-1]):
        assert signoff.feature_level(SimpleNamespace(stage=stage)) == index
    assert signoff.feature_level(SimpleNamespace(stage="proposed")) == -1
    assert signoff.feature_level(SimpleNamespace(stage="released")) == len(signoff.MILESTONE_STAGES) - 1


def test_stage_lists_are_what_the_interface_expects():
    assert signoff.FEATURE_STAGES == ("proposed", "planned", "design", "development", "testing", "deployment", "released")
    assert signoff.MILESTONE_STAGES == ("planned", "design", "development", "testing", "deployment", "completed")
    assert json.dumps(signoff.STAGES)  # serialisable
