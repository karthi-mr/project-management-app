import os
from contextlib import asynccontextmanager
from pathlib import Path

import asyncio
from datetime import timedelta

import jwt
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import event
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .database import Base, SessionLocal, engine, migrate
from .models import User
from .access import request_agent, request_ip, request_method, request_path
from . import saas
from .models import Conversation, Organization, Plan
from .realtime import hub
from .routers import auth, billing, chat, delivery, extras, growth, quality, issues, planning, platform, projects, users, workspace
from . import automation
from .trash import purge_expired
from .security import ALGORITHM, SECRET_KEY, hash_password
from .templates import seed_builtin_template

DEFAULT_ADMIN_USERNAME = os.getenv("PM_ADMIN_USERNAME", "admin")
DEFAULT_ADMIN_PASSWORD = os.getenv("PM_ADMIN_PASSWORD", "Admin@123")


def seed_admin() -> None:
    """Create the first administrator. They must change the password on first login."""
    with SessionLocal() as db:
        if db.scalar(select(User).limit(1)):
            return
        org = Organization(
            name="My workspace", plan_id=db.scalar(select(Plan.id).where(Plan.key == "enterprise")),
            seats=None, is_trial=False, valid_until=None, license_key=saas.new_license_key(),
            notes="Platform owner's workspace",
        )
        db.add(org)
        db.flush()
        db.add(
            User(
                org_id=org.id,
                is_platform_admin=True,
                username=DEFAULT_ADMIN_USERNAME.lower(),
                email=os.getenv("PM_ADMIN_EMAIL", "admin@example.com"),
                full_name="Administrator",
                role="admin",
                password_hash=hash_password(DEFAULT_ADMIN_PASSWORD),
                must_change_password=True,
            )
        )
        db.commit()
        print(f"[setup] Created administrator '{DEFAULT_ADMIN_USERNAME}' with the default password.")


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    migrate()
    with SessionLocal() as db:
        saas.bootstrap(db)
    seed_admin()
    with SessionLocal() as db:
        seed_builtin_template(db)
        workspace.import_legacy_time(db)
    hub.loop = asyncio.get_running_loop()
    background = asyncio.create_task(_scheduler())
    monitor = asyncio.create_task(_health_monitor())
    yield
    background.cancel()
    monitor.cancel()


app = FastAPI(title="Project Management API", version="1.0.0", lifespan=lifespan)

TRUST_PROXY = os.getenv("PM_TRUST_PROXY", "").lower() in ("1", "true", "yes")


class RequestMethodMiddleware:
    """Expose the HTTP method to the access layer so writes can be recognised centrally."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)
        token = request_method.set(scope["method"])
        path_token = request_path.set(scope.get("path", ""))
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        ip = scope["client"][0] if scope.get("client") else ""
        # Behind a reverse proxy the visitor's address arrives in a header; trust it only when told to.
        if TRUST_PROXY and headers.get("x-forwarded-for"):
            ip = headers["x-forwarded-for"].split(",")[0].strip()
        ip_token = request_ip.set(ip)
        agent_token = request_agent.set(headers.get("user-agent", "")[:300])
        try:
            await self.inner(scope, receive, send)
        finally:
            request_method.reset(token)
            request_path.reset(path_token)
            request_ip.reset(ip_token)
            request_agent.reset(agent_token)


app.add_middleware(RequestMethodMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv(
        "PM_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(projects.router)
app.include_router(issues.router)
app.include_router(planning.router)
app.include_router(extras.router)
app.include_router(chat.router)
app.include_router(workspace.router)
app.include_router(delivery.router)
app.include_router(billing.router)
app.include_router(platform.router)
app.include_router(growth.router)
app.include_router(quality.router)


def _scheduled_jobs() -> None:
    with SessionLocal() as db:
        automation.run_scheduled(db)
        purge_expired(db)
        from . import signoff

        signoff.run_reminders(db)


async def _scheduler():
    """Every 15 minutes: due-date automation rules and recycle-bin clean-up."""
    while True:
        try:
            await run_in_threadpool(_scheduled_jobs)
        except Exception as err:  # never let a bad rule stop the scheduler
            print(f"[scheduler] {err!r}")
        await asyncio.sleep(900)


def _health_check() -> None:
    """One self-check: can the database be reached, and how quickly?"""
    import time as _time

    from sqlalchemy import delete, text

    from .models import HealthCheck, utcnow

    started = _time.perf_counter()
    ok, detail = True, ""
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
    except Exception as err:
        ok, detail = False, repr(err)[:200]
    elapsed = (_time.perf_counter() - started) * 1000
    with SessionLocal() as db:
        now = utcnow()
        db.add(HealthCheck(checked_at=now, ok=ok, db_ms=elapsed, detail=detail))
        if now.minute == 0:  # hourly: keep three months of history
            db.execute(delete(HealthCheck).where(HealthCheck.checked_at < now - timedelta(days=91)))
        db.commit()


async def _health_monitor():
    """Every minute. A gap in these records is how the status page knows the service was down."""
    while True:
        try:
            await run_in_threadpool(_health_check)
        except Exception as err:
            print(f"[health] {err!r}")
        await asyncio.sleep(60)


@event.listens_for(SessionLocal, "after_commit")
def _push_notifications(session):
    """After a request commits, ping the people it created notifications for."""
    users = session.info.pop("notify_users", None)
    if users:
        hub.push(users, {"type": "notify"})


@event.listens_for(SessionLocal, "after_rollback")
def _drop_notifications(session):
    session.info.pop("notify_users", None)


def _ws_user(token: str) -> tuple[int, int | None] | None:
    """Validate a sign-in token for the live connection; returns (user id, workspace id)."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError, TypeError):
        return None
    if payload.get("purpose"):
        return None
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if not user or not user.is_active or user.must_change_password or payload.get("ver") != user.token_version:
            return None
        if payload.get("sid"):
            from .models import UserSession

            live = db.scalar(select(UserSession).where(UserSession.key == payload["sid"]))
            if live is None or live.revoked:
                return None
        return user.id, user.org_id


def _typing_targets(conversation_id: int, user_id: int) -> list[int]:
    from .models import ConversationMember

    with SessionLocal() as db:
        conv = db.get(Conversation, conversation_id)
        if not conv:
            return []
        if conv.kind == "direct":
            if user_id not in (conv.user_a_id, conv.user_b_id):
                return []
            return [u for u in (conv.user_a_id, conv.user_b_id) if u and u != user_id]
        members = [m.user_id for m in db.query(ConversationMember).filter_by(conversation_id=conv.id)]
        return [u for u in members if u != user_id] if user_id in members else []


@app.websocket("/api/ws")
async def live(ws: WebSocket):
    """Live channel. The first message must be {"type": "auth", "token": "..."}."""
    await ws.accept()
    user_id = None
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=10)
        identity = None
        if first.get("type") == "auth" and isinstance(first.get("token"), str):
            identity = await run_in_threadpool(_ws_user, first["token"])
        if identity is None:
            await ws.close(code=4401)
            return
        user_id, org_id = identity
        await hub.connect(user_id, org_id, ws)
        await ws.send_json({"type": "ready", "online": hub.online(org_id)})
        while True:
            message = await ws.receive_json()
            if message.get("type") == "typing" and isinstance(message.get("conversation_id"), int):
                targets = await run_in_threadpool(_typing_targets, message["conversation_id"], user_id)
                if targets:
                    await hub.send(
                        targets,
                        {"type": "chat.typing", "conversation_id": message["conversation_id"], "user_id": user_id},
                    )
            elif message.get("type") == "ping":
                await ws.send_json({"type": "pong"})
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError, RuntimeError):
        pass
    finally:
        if user_id is not None:
            await hub.disconnect(user_id, ws)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Serve the built frontend (frontend/dist) when it exists, so one process runs everything.
DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        candidate = (DIST / path).resolve()
        if path and candidate.is_file() and DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
