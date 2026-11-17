"""Two-factor sign-in with an authenticator app (TOTP, RFC 6238) and one-time recovery codes.

Works with Google Authenticator, Microsoft Authenticator, 1Password, Authy and similar apps:
30-second steps, 6 digits, SHA-1. One step either side is accepted to allow for clock drift,
and a code can be used only once.
"""
import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
from urllib.parse import quote

STEP_SECONDS = 30
DIGITS = 6
DRIFT_STEPS = 1
RECOVERY_CODE_COUNT = 10
_RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def new_secret() -> str:
    """160 random bits, base32 without padding, as authenticator apps expect."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _code_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10 ** DIGITS).zfill(DIGITS)


def current_step(now: float | None = None) -> int:
    return int((now if now is not None else time.time()) // STEP_SECONDS)


def check_code(secret: str, code: str, last_step: int | None = None, now: float | None = None) -> int | None:
    """The time step the code belongs to, or None. Steps at or before last_step are refused (replay)."""
    code = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(code) != DIGITS or not secret:
        return None
    step = current_step(now)
    for candidate in range(step - DRIFT_STEPS, step + DRIFT_STEPS + 1):
        if last_step is not None and candidate <= last_step:
            continue
        if hmac.compare_digest(_code_at(secret, candidate), code):
            return candidate
    return None


def provisioning_uri(secret: str, account: str, issuer: str) -> str:
    label = quote(f"{issuer}:{account}", safe="@:")
    return (
        f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer)}"
        f"&algorithm=SHA1&digits={DIGITS}&period={STEP_SECONDS}"
    )


def qr_svg(uri: str) -> str:
    """The setup link as an SVG QR code, for the authenticator app to scan."""
    import segno

    return segno.make(uri, error="m").svg_inline(scale=5, border=2, dark="#000", light="#fff")


# ───────────── Recovery codes ─────────────


def _normalise(code: str) -> str:
    return "".join(ch for ch in (code or "").lower() if ch.isalnum())


def _hash(code: str) -> str:
    # The codes are long and random, so a fast hash is enough; they are only stored hashed.
    return hashlib.sha256(_normalise(code).encode()).hexdigest()


def new_recovery_codes() -> tuple[list[str], str]:
    """Readable codes to show once, and what to store (their hashes, as JSON)."""
    codes = []
    for _ in range(RECOVERY_CODE_COUNT):
        raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(10))
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes, json.dumps([_hash(c) for c in codes])


def use_recovery_code(stored: str, code: str) -> str | None:
    """If the code is one of the unused ones, return the stored list without it; else None."""
    try:
        hashes = json.loads(stored or "[]")
    except ValueError:
        return None
    wanted = _hash(code)
    if len(_normalise(code)) < 10:
        return None
    for h in hashes:
        if hmac.compare_digest(h, wanted):
            remaining = [x for x in hashes if x != h]
            return json.dumps(remaining)
    return None


def recovery_left(stored: str) -> int:
    try:
        return len(json.loads(stored or "[]"))
    except ValueError:
        return 0
