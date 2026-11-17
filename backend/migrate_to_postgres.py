"""Copy everything from an old SQLite database file into the configured database.

Used once when moving from the original SQLite setup to PostgreSQL:

    docker compose run --rm -v "$PWD/backend/data:/legacy:ro" app \
        python migrate_to_postgres.py /legacy/app.db

The SQLite file is never modified (the script works on a temporary copy). The target must be
empty apart from the automatically created administrator; pass --replace to overwrite a target
that already holds data.
"""
import shutil
import sys
import tempfile
from pathlib import Path

from sqlalchemy import func, select, text

import app.models  # noqa: F401  (registers every table)
from app.database import Base, engine, make_engine, migrate


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    replace = "--replace" in sys.argv
    if len(args) != 1:
        sys.exit(__doc__)
    source_file = Path(args[0])
    if not source_file.is_file():
        sys.exit(f"SQLite file not found: {source_file}")
    if engine.dialect.name == "sqlite":
        sys.exit("DATABASE_URL points at SQLite. Set it to the PostgreSQL database first.")

    # Work on a copy so the original file is left untouched, and bring it to the current schema.
    work = Path(tempfile.mkdtemp()) / "source.db"
    shutil.copy(source_file, work)
    source = make_engine(f"sqlite:///{work}")
    Base.metadata.create_all(source)
    migrate(source)

    Base.metadata.create_all(engine)
    migrate(engine)
    tables = Base.metadata.sorted_tables

    with engine.begin() as target, source.connect() as src:
        t = Base.metadata.tables
        users = target.scalar(select(func.count()).select_from(t["users"]))
        projects = target.scalar(select(func.count()).select_from(t["projects"]))
        if (users > 1 or projects > 0) and not replace:
            sys.exit(
                f"The target database already has {users} users and {projects} projects.\n"
                "Re-run with --replace to delete that data and import the SQLite file instead."
            )
        names = ", ".join(f'"{table.name}"' for table in tables)
        target.execute(text(f"TRUNCATE TABLE {names} RESTART IDENTITY CASCADE"))

        total = 0
        for table in tables:
            rows = [dict(row) for row in src.execute(select(table)).mappings()]
            for start in range(0, len(rows), 500):
                target.execute(table.insert(), rows[start:start + 500])
            total += len(rows)
            print(f"  {table.name:<26} {len(rows):>6} rows")

        # Continue numbering after the imported ids.
        for table in tables:
            if "id" in table.c and table.c.id.primary_key:
                target.execute(
                    text(
                        f"SELECT setval(pg_get_serial_sequence('{table.name}', 'id'), "
                        f'COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM "{table.name}"'
                    )
                )

    # Data from before workspaces existed becomes the first workspace.
    from app import saas
    from app.database import SessionLocal

    with SessionLocal() as db:
        saas.bootstrap(db)

    print(f"Imported {total} rows from {source_file.name}. Sign in with your existing username and password.")


if __name__ == "__main__":
    main()
