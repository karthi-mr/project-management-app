#!/usr/bin/env bash
# Development mode WITHOUT Docker: runs on a local SQLite file (backend/data/app.db).
# The normal way to run Trackly is `docker compose up -d` (PostgreSQL); see README.md.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8000}"

if [ ! -d backend/.venv ]; then
  echo "→ Creating Python virtual environment…"
  python3 -m venv backend/.venv
fi
backend/.venv/bin/pip install -q -r backend/requirements.txt

if [ ! -d frontend/node_modules ]; then
  echo "→ Installing frontend dependencies…"
  (cd frontend && npm install --no-audit --no-fund)
fi
if [ ! -d frontend/dist ] || [ -n "$(find frontend/src frontend/index.html -newer frontend/dist -print -quit)" ]; then
  echo "→ Building frontend…"
  (cd frontend && npm run build)
fi

echo "→ Trackly (development mode, SQLite) is running at http://localhost:${PORT}"
cd backend
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
