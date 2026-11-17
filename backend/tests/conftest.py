"""Shared fixtures for the API tests.

The whole app runs in-process against a brand-new database:
  * by default a SQLite file in a temporary folder;
  * with TEST_DATABASE_URL set, that PostgreSQL database (it must be empty and its name must
    contain "test", so real data can never be used by mistake).

Every test makes its own workspaces and people, so tests do not depend on each other.
"""
import os
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

# ── Point the app at a throwaway database before it is imported ──
_TMP = tempfile.mkdtemp(prefix="trackly-tests-")
os.environ["PM_DATA_DIR"] = _TMP
os.environ["PM_SECRET_KEY"] = "test-secret-key-not-for-production-0123456789"
os.environ["PM_ADMIN_USERNAME"] = "admin"
os.environ["PM_ADMIN_PASSWORD"] = "Admin@123"
os.environ["PM_ADMIN_EMAIL"] = "owner@example.com"
_test_db = os.environ.get("TEST_DATABASE_URL")
if _test_db:
    if "test" not in _test_db.rsplit("/", 1)[-1]:
        raise SystemExit("TEST_DATABASE_URL must name a database with 'test' in its name.")
    os.environ["DATABASE_URL"] = _test_db
else:
    os.environ.pop("DATABASE_URL", None)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bcrypt  # noqa: E402

# Password hashing is deliberately slow; in tests the cheapest setting is plenty.
_gensalt = bcrypt.gensalt
bcrypt.gensalt = lambda rounds=4, prefix=b"2b": _gensalt(4, prefix)

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.routers import auth as auth_router  # noqa: E402
from app.routers import billing as billing_router  # noqa: E402
from app.routers import quality as quality_router  # noqa: E402

OWNER_PASSWORD = "Owner#Pass123"
MEMBER_PASSWORD = "Member#Pass123"


def unique(prefix: str = "u") -> str:
    return f"{prefix}{uuid.uuid4().hex[:8]}"


class Api:
    """A signed-in (or anonymous) caller. Each method returns the response; use .ok() to check."""

    def __init__(self, client: TestClient, token: str | None = None):
        self.client = client
        self.token = token

    def _headers(self):
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def call(self, method: str, path: str, json=None, **kwargs):
        return self.client.request(method, path, json=json, headers=self._headers(), **kwargs)

    def get(self, path, **kw):
        return self.call("GET", path, **kw)

    def post(self, path, json=None, **kw):
        return self.call("POST", path, json=json, **kw)

    def put(self, path, json=None, **kw):
        return self.call("PUT", path, json=json, **kw)

    def patch(self, path, json=None, **kw):
        return self.call("PATCH", path, json=json, **kw)

    def delete(self, path, **kw):
        return self.call("DELETE", path, **kw)


def ok(response, status: int = 200):
    """Assert the status code and return the JSON body (None for an empty body)."""
    assert response.status_code == status, f"{response.request.method} {response.request.url.path} -> {response.status_code}: {response.text[:500]}"
    return response.json() if response.content else None


def fails(response, status: int, contains: str | None = None):
    """Assert an error status (and optionally part of the message); return the detail."""
    assert response.status_code == status, f"expected {status}, got {response.status_code}: {response.text[:500]}"
    detail = response.json().get("detail") if response.content else None
    if contains is not None:
        assert contains.lower() in str(detail).lower(), f"{contains!r} not in {detail!r}"
    return detail


class Person:
    def __init__(self, api: Api, user: dict, password: str):
        self.api = api
        self.user = user
        self.id = user["id"]
        self.username = user["username"]
        self.password = password


class Workspace:
    """A customer workspace on the free trial, with its administrator signed in."""

    def __init__(self, client: TestClient, name: str):
        self.client = client
        self.username = unique("adm")
        self.password = "Admin#Pass123"
        body = ok(client.post("/api/auth/register", json={
            "company": name, "full_name": f"Admin of {name}", "email": f"{self.username}@example.com",
            "username": self.username, "password": self.password, "accept_terms": True,
        }), 201)
        self.admin = Person(Api(client, body["access_token"]), body["user"], self.password)
        self.org_id = body["user"]["org"]["id"]
        self.name = name

    def add_person(self, role: str = "member", full_name: str | None = None) -> Person:
        """Create someone in this workspace and complete their first sign-in."""
        username = unique("p")
        created = ok(self.admin.api.post("/api/users", {
            "username": username, "full_name": full_name or username.title(), "email": f"{username}@example.com",
            "role": role, "password": "Temp#Pass123",
        }), 201)
        first = ok(self.client.post("/api/auth/login", json={"username": username, "password": "Temp#Pass123"}))
        changed = ok(Api(self.client, first["access_token"]).post("/api/auth/change-password", {
            "current_password": "Temp#Pass123", "new_password": MEMBER_PASSWORD,
        }))
        return Person(Api(self.client, changed["access_token"]), created["user"], MEMBER_PASSWORD)

    def project(self, key: str = "PRJ", by: Person | None = None, **extra) -> dict:
        return ok((by or self.admin).api.post("/api/projects", {"name": f"Project {key}", "key": key, **extra}), 201)


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    """The sign-in, sign-up and client-feedback throttles are per process; start each test clean."""
    auth_router._failures.clear()
    billing_router._signups.clear()
    quality_router._feedback_times.clear()
    yield


@pytest.fixture(scope="session")
def owner(client) -> Person:
    """The platform owner (the first administrator), with the forced password change done."""
    first = ok(client.post("/api/auth/login", json={"username": "admin", "password": "Admin@123"}))
    if first["user"]["must_change_password"]:
        first = ok(Api(client, first["access_token"]).post("/api/auth/change-password", {
            "current_password": "Admin@123", "new_password": OWNER_PASSWORD,
        }))
    return Person(Api(client, first["access_token"]), first["user"], OWNER_PASSWORD)


@pytest.fixture
def workspace(client):
    """A factory: workspace("Acme") makes a new workspace on the free trial."""
    return lambda name=None: Workspace(client, name or unique("Company "))


@pytest.fixture
def anon(client) -> Api:
    return Api(client)


@pytest.fixture
def plans(anon) -> dict:
    return {p["key"]: p for p in ok(anon.get("/api/public/plans"))["plans"]}
