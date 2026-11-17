import os
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("PM_DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# PostgreSQL in Docker / production (DATABASE_URL); a local SQLite file when it is not set.
DATABASE_URL = os.getenv("DATABASE_URL") or f"sqlite:///{DATA_DIR / 'app.db'}"
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgres://"):]
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgresql://"):]


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        eng = create_engine(url, connect_args={"check_same_thread": False})

        @event.listens_for(eng, "connect")
        def _enable_foreign_keys(dbapi_connection, _record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        return eng
    return create_engine(url, pool_pre_ping=True, pool_size=10, max_overflow=10)


engine = make_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


# Columns added after the first release. Fresh databases get them from create_all();
# this only upgrades databases created by an older version.
ADDED_COLUMNS = {
    "issues": {
        "start_date": "DATE",
        "spent_hours": "FLOAT",
        "feature_id": "INTEGER REFERENCES features(id) ON DELETE SET NULL",
        "recurrence": "VARCHAR(10) NOT NULL DEFAULT ''",
        "custom": "TEXT NOT NULL DEFAULT ''",
        "sprint_id": "INTEGER REFERENCES sprints(id) ON DELETE SET NULL",
    },
    "users": {
        "org_id": "INTEGER REFERENCES organizations(id) ON DELETE CASCADE",
        "is_platform_admin": "BOOLEAN NOT NULL DEFAULT FALSE",
        "terms_accepted_at": "TIMESTAMP",
        "totp_secret": "VARCHAR(64)",
        "totp_pending_secret": "VARCHAR(64)",
        "totp_enabled_at": "TIMESTAMP",
        "totp_last_step": "INTEGER",
        "recovery_codes": "TEXT NOT NULL DEFAULT ''",
        "avatar_url": "VARCHAR(200)",
        "preferences": "TEXT NOT NULL DEFAULT ''",
        "hourly_rate": "FLOAT",
        "weekly_capacity": "FLOAT NOT NULL DEFAULT 40",
    },
    "time_entries": {"rate": "FLOAT"},
    "features": {"milestone_id": "INTEGER REFERENCES milestones(id) ON DELETE SET NULL"},
    "conversations": {
        "name": "VARCHAR(80)",
        "created_by_id": "INTEGER REFERENCES users(id) ON DELETE SET NULL",
    },
    "chat_messages": {
        "image_url": "VARCHAR(200)",
        "reply_to_id": "INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL",
    },
    "milestones": {"start_date": "DATE", "stage": "VARCHAR(20) NOT NULL DEFAULT 'planned'"},
    "approvals": {"target_type": "VARCHAR(12)", "stage": "VARCHAR(20)", "to_stage": "VARCHAR(20)",
                  "reminded_at": "TIMESTAMP", "escalated_at": "TIMESTAMP"},
    "share_links": {"allow_feedback": "BOOLEAN NOT NULL DEFAULT TRUE"},
    "organizations": {
        "logo_url": "VARCHAR(200)",
        "brand_color": "VARCHAR(9)",
        "slug": "VARCHAR(40)",
        "timezone": "VARCHAR(60) NOT NULL DEFAULT ''",
        "discount_percent": "FLOAT NOT NULL DEFAULT 0",
        "onboarding_done": "BOOLEAN NOT NULL DEFAULT TRUE",
        "password_min_length": "INTEGER NOT NULL DEFAULT 8",
        "password_require_symbol": "BOOLEAN NOT NULL DEFAULT FALSE",
        "password_require_mixed_case": "BOOLEAN NOT NULL DEFAULT FALSE",
        "ip_allowlist": "TEXT NOT NULL DEFAULT ''",
        "require_two_factor": "BOOLEAN NOT NULL DEFAULT FALSE",
        "hidden_modules": "TEXT NOT NULL DEFAULT ''",
        "public_id": "VARCHAR(8)",
        "addons": "TEXT NOT NULL DEFAULT ''",
        "free_addons": "TEXT NOT NULL DEFAULT ''",
    },
    "license_requests": {
        "addons": "TEXT NOT NULL DEFAULT ''",
        "list_amount": "FLOAT",
        "coupon_code": "VARCHAR(40) NOT NULL DEFAULT ''",
        "discount_note": "VARCHAR(200) NOT NULL DEFAULT ''",
    },
    "invoices": {"addon_names": "TEXT NOT NULL DEFAULT ''", "list_amount": "FLOAT", "discount_note": "VARCHAR(200) NOT NULL DEFAULT ''"},
    "project_templates": {"org_id": "INTEGER REFERENCES organizations(id) ON DELETE CASCADE"},
    "audit_logs": {"org_id": "INTEGER REFERENCES organizations(id) ON DELETE CASCADE"},
    "projects": {
        "org_id": "INTEGER REFERENCES organizations(id) ON DELETE CASCADE",
        "signoff_required": "BOOLEAN NOT NULL DEFAULT TRUE",
        "signoff_mode": "VARCHAR(10) NOT NULL DEFAULT 'strict'",
        "signoff_remind_days": "INTEGER NOT NULL DEFAULT 2",
        "signoff_escalate_days": "INTEGER NOT NULL DEFAULT 5",
        "phase": "VARCHAR(20) NOT NULL DEFAULT 'planning'",
        "logo_url": "VARCHAR(200)",
        "workflow": "TEXT",
        "budget": "FLOAT",
        "currency": "VARCHAR(3) NOT NULL DEFAULT 'USD'",
    },
    "project_members": {
        "role": "VARCHAR(20) NOT NULL DEFAULT 'contributor'",
        "sections": "VARCHAR(200) NOT NULL DEFAULT 'all'",
    },
}


SOFT_DELETE_TABLES = ("projects", "milestones", "issues", "releases", "features", "documents", "risks")
for _table in SOFT_DELETE_TABLES:
    ADDED_COLUMNS.setdefault(_table, {}).update(
        {"deleted_at": "TIMESTAMP", "deleted_by_id": "INTEGER REFERENCES users(id) ON DELETE SET NULL"}
    )


def migrate(target: Engine | None = None) -> None:
    """Add columns introduced after the first release to an existing database."""
    eng = target or engine
    inspector = inspect(eng)
    dialect = eng.dialect.name
    tables = set(inspector.get_table_names())
    with eng.begin() as conn:
        for table, columns in ADDED_COLUMNS.items():
            if table not in tables:
                continue
            existing = {col["name"] for col in inspector.get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
                    if (table, name) == ("projects", "signoff_mode"):
                        # Projects from before modes keep the rule they had: strict, or off if it was switched off.
                        conn.exec_driver_sql("UPDATE projects SET signoff_mode = 'off' WHERE signoff_required = FALSE")
                    if (table, name) == ("milestones", "stage"):
                        # Milestones closed before stages existed have finished their lifecycle.
                        conn.exec_driver_sql("UPDATE milestones SET stage = 'completed' WHERE status = 'closed'")
                    if (table, name) == ("organizations", "slug"):
                        conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_slug ON organizations (slug)")
        # Only one sign-off can be waiting for a feature or milestone at a time. The database
        # enforces it, so two clicks at the same instant cannot both get through.
        if "approvals" in tables:
            conn.exec_driver_sql(
                "UPDATE approvals SET status = 'cancelled' WHERE kind = 'stage' AND status = 'pending' AND id NOT IN ("
                "SELECT MIN(id) FROM approvals WHERE kind = 'stage' AND status = 'pending' GROUP BY target_type, target_id)"
            )
            conn.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_approvals_pending_stage ON approvals (target_type, target_id) "
                "WHERE kind = 'stage' AND status = 'pending'"
            )
        # Project keys used to be unique across the whole installation; with workspaces they are
        # unique per workspace instead.
        if "projects" in tables:
            indexes = {ix["name"]: ix for ix in inspector.get_indexes("projects")}
            uniques = {uc["name"] for uc in inspector.get_unique_constraints("projects")}
            if indexes.get("ix_projects_key", {}).get("unique"):
                conn.exec_driver_sql("DROP INDEX ix_projects_key")
                conn.exec_driver_sql("CREATE INDEX ix_projects_key ON projects (key)")
            if "uq_projects_org_key" not in indexes and "uq_projects_org_key" not in uniques:
                conn.exec_driver_sql("CREATE UNIQUE INDEX uq_projects_org_key ON projects (org_id, key)")
            for name in ("ix_projects_org_id",):
                if name not in indexes:
                    conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_projects_org_id ON projects (org_id)")
        if "users" in tables and "ix_users_org_id" not in {ix["name"] for ix in inspector.get_indexes("users")}:
            conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_users_org_id ON users (org_id)")
        # Usernames and emails used to be unique across the whole installation; now they are unique
        # per workspace, so the same person can have an account in two workspaces.
        if "users" in tables:
            indexes = {ix["name"]: ix for ix in inspector.get_indexes("users")}
            uniques = {uc["name"] for uc in inspector.get_unique_constraints("users")}
            for column in ("username", "email"):
                name = f"ix_users_{column}"
                if indexes.get(name, {}).get("unique"):
                    conn.exec_driver_sql(f"DROP INDEX {name}")
                    conn.exec_driver_sql(f"CREATE INDEX {name} ON users ({column})")
                for uc in inspector.get_unique_constraints("users"):
                    # A plain UNIQUE on the column alone (rather than an index) is dropped as well.
                    if uc["column_names"] == [column] and uc["name"] and dialect != "sqlite":
                        conn.exec_driver_sql('ALTER TABLE users DROP CONSTRAINT "%s"' % uc["name"])
                target = f"uq_users_org_{column}"
                if target not in indexes and target not in uniques:
                    conn.exec_driver_sql(f"CREATE UNIQUE INDEX {target} ON users (org_id, {column})")
        # Every workspace has a random 8-digit ID that people type to sign in.
        if "organizations" in tables:
            from .models import new_public_id

            taken = {row[0] for row in conn.exec_driver_sql("SELECT public_id FROM organizations WHERE public_id IS NOT NULL")}
            for (org_id,) in conn.exec_driver_sql("SELECT id FROM organizations WHERE public_id IS NULL ORDER BY id").fetchall():
                value = new_public_id()
                while value in taken:
                    value = new_public_id()
                taken.add(value)
                conn.execute(text("UPDATE organizations SET public_id = :v WHERE id = :i"), {"v": value, "i": org_id})
            indexes = {ix["name"] for ix in inspector.get_indexes("organizations")}
            uniques = {uc["name"] for uc in inspector.get_unique_constraints("organizations")}
            if not any("public_id" in (n or "") for n in indexes | uniques):
                conn.exec_driver_sql("CREATE UNIQUE INDEX uq_organizations_public_id ON organizations (public_id)")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
