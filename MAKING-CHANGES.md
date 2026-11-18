# Making a change and putting it live

This is the routine for every change, big or small, to the frontend (the screens) or the backend
(the server and database). Follow the steps in order. Each step says **what to run**, **where**
and **what you should see**.

```
1. Start a branch        →  2. Run it locally       →  3. Make the change
4. Test it               →  5. Back up live data    →  6. Put it live
7. Check it is live      →  8. Save it to GitHub    →  (9. Undo, if something went wrong)
```

The live app runs in Docker on this computer at <http://localhost:8000>, with its data in a
PostgreSQL database inside Docker. While you work, you use a **separate development copy** at
<http://localhost:5173> with its own small database, so nothing you try can affect real users until
step 6.

---

## 0. One-time setup (only the first time, on a new computer)

You need **Git**, **Docker Desktop**, **Node.js 22 or newer** and **Python 3.13 or newer**.

Open a terminal in the project folder (`project-management`) and run:

```bash
cp .env.example .env
```

Open `.env` and set `POSTGRES_PASSWORD` to a long password of letters and digits. Then install
what the development copy needs:

```bash
python3 -m venv backend/.venv
```

```bash
backend/.venv/bin/pip install -r backend/requirements-dev.txt
```

```bash
cd frontend && npm ci && npx playwright install chromium && cd ..
```

Start the live app once, if it is not already running:

```bash
docker compose up -d --build
```

**You should see:** the app at <http://localhost:8000>.

---

## 1. Start a branch

A branch keeps your change separate from the version that is live until it is ready.

```bash
git checkout main
```

```bash
git pull
```

```bash
git checkout -b short-name-of-the-change
```

Use a short name such as `fix-login-message` or `add-export-button`.

---

## 2. Run the development copy

Open **two terminal windows** in the project folder.

**Terminal 1 — the backend (API).** It restarts by itself whenever you save a Python file:

```bash
cd backend && .venv/bin/uvicorn app.main:app --reload --port 8001
```

**Terminal 2 — the frontend (screens).** It refreshes the browser by itself whenever you save a
frontend file:

```bash
cd frontend && npm run dev
```

**You should see:** the app at <http://localhost:5173>. Sign in with `admin` and the password
`Admin@123` (you are asked to choose a new one); the workspace ID is printed in Terminal 1 on its
first start, or use *Forgot your workspace ID?* on the sign-in page with `admin@example.com`.

This development copy keeps its data in `backend/data/app.db`. Delete that file to start again from
an empty app.

> Keep port **8001** for development. Port 8000 is the live app.

---

## 3. Make the change

Where things are:

| What you want to change | Where |
| --- | --- |
| A screen or page | `frontend/src/pages/` (for example `Billing.jsx`, `Chat.jsx`) |
| Parts used on many screens | `frontend/src/components/` |
| Colours, spacing, layout | `frontend/src/styles.css` |
| Labels in the six languages | `frontend/src/i18n.js` |
| What the server does for a request | `backend/app/routers/` (for example `issues.py`, `billing.py`) |
| Sign-off rules | `backend/app/signoff.py` |
| Plans, add-ons, licences | `backend/app/saas.py` |
| Database tables and columns | `backend/app/models.py` |

**Adding a column to an existing table?** Add it in `backend/app/models.py` **and** in the
`ADDED_COLUMNS` list in `backend/app/database.py`, with a default value. The live database then
gets the new column automatically when the app starts, and its data is kept. A brand-new table only
needs `models.py`.

**Never** rename or delete a column that holds live data in one step. Ask for help or add a new
column instead.

Save your files, then try the change at <http://localhost:5173>.

---

## 4. Test it

Run all three. Each one must finish without failures before you continue.

**Backend tests** (about 10 seconds):

```bash
cd backend && .venv/bin/python -m pytest && cd ..
```

**You should see:** a row of dots and no `FAILED` lines.

**Frontend build** (catches mistakes in the screens):

```bash
cd frontend && npm run build && cd ..
```

**You should see:** `✓ built in …`.

**Browser tests** (about 30 seconds; they start their own temporary app):

```bash
cd frontend && npm run test:e2e && cd ..
```

**You should see:** `… passed` and nothing failed.

If something fails, read the first error, fix it and run the tests again. If you changed something
on purpose that a test checks (for example a button's text), update that test in `backend/tests/`
or `frontend/e2e/app.spec.js`.

---

## 5. Back up the live data

Always do this right before going live. It takes a few seconds.

```bash
mkdir -p backups && docker compose exec -T db pg_dump -U trackly trackly > "backups/before-$(date +%Y%m%d-%H%M).sql"
```

**You should see:** a new file in the `backups` folder of a few hundred kB (check with
`ls -lh backups | tail -3`). A file of 0 bytes means the backup failed: stop and find out why.

The `backups` folder is never sent to GitHub.

---

## 6. Put it live

This builds the new version (screens and server together) and replaces the running one. Users are
offline for a few seconds while it restarts.

```bash
docker compose up -d --build
```

**You should see:** `Container trackly-app-1 Started` after a minute or two.

---

## 7. Check it is live

Wait until the app reports healthy:

```bash
docker compose ps
```

**You should see:** `trackly-app-1 … Up … (healthy)`. If it says `(health: starting)`, wait 20
seconds and run it again.

Look for errors in the server log:

```bash
docker compose logs --tail 50 app
```

**You should see:** no `Traceback` or `ERROR` lines.

Open <http://localhost:8000>, press **Ctrl+Shift+R** (Cmd+Shift+R on a Mac) to load the new
screens, and try your change once more.

---

## 8. Save it to GitHub

Save the change with a short message saying what it does and why:

```bash
git add -A
```

```bash
git commit -m "Short description of the change"
```

Make it part of the main version and send it to GitHub:

```bash
git checkout main
```

```bash
git merge short-name-of-the-change
```

```bash
git push
```

GitHub then runs all the tests again on its own. You can watch them on the repository's **Actions**
tab; a green tick means everything passed.

---

## 9. If something went wrong after going live

**The new version has a bug, but the data is fine:** go back to the previous version of the code
and rebuild.

```bash
git log --oneline -5
```

Find the line of the last good version, copy its code (the first 7 characters), then:

```bash
git checkout THAT-CODE
```

```bash
docker compose up -d --build
```

When the fix is ready, return with `git checkout main` and continue from step 1.

**The data itself went wrong** (only if the change damaged data): restore the backup from step 5.
This replaces **everything** in the live database with the backup, so changes users made after the
backup are lost.

```bash
docker compose stop app
```

```bash
docker compose exec -T db psql -U trackly -d postgres -c "DROP DATABASE trackly WITH (FORCE);" -c "CREATE DATABASE trackly OWNER trackly;"
```

```bash
docker compose exec -T db psql -q -U trackly trackly < backups/THE-BACKUP-FILE.sql
```

```bash
docker compose start app
```

**Never run `docker compose down -v`**: the `-v` deletes the database and all data.

---

## Quick reference

| Task | Command |
| --- | --- |
| Development API | `cd backend && .venv/bin/uvicorn app.main:app --reload --port 8001` |
| Development screens | `cd frontend && npm run dev` → <http://localhost:5173> |
| Backend tests | `cd backend && .venv/bin/python -m pytest` |
| Frontend build | `cd frontend && npm run build` |
| Browser tests | `cd frontend && npm run test:e2e` |
| Back up live data | `docker compose exec -T db pg_dump -U trackly trackly > backups/before-DATE.sql` |
| Put it live | `docker compose up -d --build` |
| Is it healthy? | `docker compose ps` |
| Server log | `docker compose logs --tail 50 app` |
| Stop / start the live app | `docker compose stop app` / `docker compose start app` |
| Locked out as admin | `docker compose exec app python reset_admin.py admin` |
