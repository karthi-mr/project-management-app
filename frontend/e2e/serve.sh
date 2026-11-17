#!/bin/sh
# Starts the real app for the browser tests: the backend serving the built frontend, on a brand-new
# SQLite database in a temporary folder. It never touches your data.
set -e
DATA_DIR=$(mktemp -d)
cd "$(dirname "$0")/../../backend"
PY=${PYTHON:-.venv/bin/python}
[ -x "$PY" ] || PY=python
unset DATABASE_URL
PM_DATA_DIR="$DATA_DIR" PM_SECRET_KEY=e2e-only-secret-key-0123456789 PM_ADMIN_PASSWORD=Admin@123 \
  PM_SIGNUPS_PER_HOUR=1000 exec "$PY" -m uvicorn app.main:app --port "${E2E_PORT:-8799}"
