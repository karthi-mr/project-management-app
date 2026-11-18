# Trackly — Project Management

A self-hosted project tracker: features, issues, planning, releases, chat and reporting.

- **Frontend:** React 18 + Vite (`frontend/`)
- **Backend:** FastAPI + SQLAlchemy (`backend/`)
- **Database:** PostgreSQL 17
- **Runs with:** Docker Compose

## Quick start (Docker)

1. Create the settings file and choose a database password (letters and digits only):

   ```bash
   cp .env.example .env
   ```

2. Build and start:

   ```bash
   docker compose up -d --build
   ```

3. Open <http://localhost:8000>.

Two containers run: `db` (PostgreSQL, not exposed outside Docker) and `app` (the API, which also
serves the web interface). Data lives in the Docker volumes `trackly_db_data` (database) and
`trackly_app_data` (signing key).

### First sign-in

| Username | Password    |
| -------- | ----------- |
| `admin`  | `Admin@123` |

You also need your **workspace ID**: the app prints it on the very first start
(`docker compose logs app | grep "Created administrator"`), and **Forgot your workspace ID?** on the
sign-in page shows it for your email and password. You are forced to choose a new password
immediately. To use a different initial password, set `PM_ADMIN_PASSWORD` in `.env` before the very
first start.

### Everyday commands

```bash
docker compose up -d          # start
docker compose down           # stop (data is kept)
docker compose logs -f app    # watch the application log
docker compose up -d --build  # rebuild after changing the code
```

Other people on your network can reach the app at `http://<this-computer's-address>:8000`.

## Features

**Accounts and security**
- Only administrators create accounts. They either set a temporary password or have a strong one
  generated (shown once, with a copy button).
- Every new or reset account must change its password on first sign-in — enforced by the API, not
  just the UI.
- **Forgot password:** the sign-in page lets a user request a reset. Administrators see pending
  requests under *Users → Password reset requests* (with a badge in the sidebar) and issue a new
  temporary password or dismiss the request.
- Changing or resetting a password signs out all other sessions. Five failed sign-ins lock the
  account name for 10 minutes. Passwords are hashed with bcrypt.
- Administrators can edit, promote, disable or delete users; the last active administrator is
  protected.

**Look and feel**
- Profile photos and project logos (PNG, JPEG, GIF or WebP up to 5 MB, stored in the database).
- Appearance settings on the Profile page: light / dark / system theme, an accent colour and a
  comfortable or compact density. These are remembered per browser.
- Collapsible sidebar (the button at the bottom, or press `[`), loading skeletons and illustrated
  empty states, and a phone layout where the board swipes column by column and dialogs open as
  bottom sheets.
- Project tabs are grouped into **Plan**, **Work**, **Deliver** and **Team**.
- **Customisable dashboard:** press *Customise* to reorder or hide cards; the layout is saved to
  your account. Includes a status donut and a 14-day created-versus-completed chart.

**Keyboard**
- `Ctrl K` / `⌘K` opens the command palette: jump to any project, issue or page, or run actions
  such as switching theme.
- `G` then `D` / `P` / `R` / `C` / `I` / `T` / `M` goes to Dashboard, Projects, Roadmap, Calendar,
  My issues, Timesheet or Chat. `/` focuses project search, `?` lists every shortcut.

**Rich text**
- Issue descriptions, comments and project documents use a formatting editor: headings, bold,
  italic, strikethrough, lists, task lists, quotes, code, links and tables, with a live preview.
- Paste or drop screenshots straight into the editor. Type `@` to mention a project member.

**Custom workflows and fields**
- Project owners can rename, recolour, reorder, add or remove issue statuses (Settings → Issue
  workflow). The board columns follow. The final status always means "finished"; issues in a
  removed status move to the first one.
- Custom issue fields per project: text, number, date, choice list or yes/no.

**Time tracking**
- Log time on an issue against a day, with an optional note; the total is compared with the
  estimate. The **Timesheet** page shows your week by issue and day, with CSV export.
  Administrators can view anyone's timesheet. Older single "spent hours" values were carried over
  as one entry each.

**Sprints**
- Plan fixed iterations per project (Work → Sprints): name, goal and dates. Add issues from the
  backlog, start the sprint (one runs at a time), and follow its burndown. Completing a sprint
  records what was committed and finished and moves unfinished issues to the next sprint or the
  backlog. Recent velocity is shown, and issues can be put in a sprint from the issue panel, the
  new-issue form or bulk edit.

**Workload and capacity**
- The Workload page shows each person's planned hours per week against their weekly capacity
  (green / amber / red). Planned hours are open issues' remaining estimates spread over working
  days up to the due date; overdue work counts in the current week, undated work is listed as
  unscheduled. Click a person to see their issues. Administrators set capacity under Users.

**Automation rules**
- Per project (Settings → Automation rules): when an issue is created, moves to a status, is due
  within N days, or when every issue of a feature is done — assign it, set its priority or status,
  add a label, post a comment, notify someone, or move the feature to a stage. Rules can be limited
  to an issue type or priority. Due-date rules are checked every 15 minutes and fire once per issue.
  Rule actions appear in the activity log with ⚡ and never trigger other rules.

**Issue templates**
- Per project (Settings → Issue templates): pre-filled title, description, type, priority, labels
  and checklist. A Bug report and a Feature request template can be added in one click. Pick a
  template at the top of the new-issue form.

**Watchers**
- Watch any issue or feature to be notified of every change and comment. Reporters, assignees,
  commenters and feature owners start watching automatically; use the Watch button to stop.

**Approvals**
- Ask a named person to sign off a feature, a release, a lifecycle phase or anything else
  (Deliver → Approvals, or the buttons on features, releases and the phase checklist). They approve
  or reject with a comment; requests waiting for you appear in the notification bell.

**Budgets and portfolio**
- Administrators set each person's hourly rate (Users → edit). Project owners set a budget and
  currency; the Overview shows cost (logged hours × the rate when the time was logged), what is
  left and a breakdown by person. Costs are visible only to project owners and administrators.
- The Portfolio page lists every project with health, phase, progress, overdue work, risks, next
  milestone and budget against cost, with CSV export and Print / Save as PDF.

**Recycle bin and undo**
- Deleting a project, issue, feature, release, milestone, document or risk moves it to the
  recycle bin instead of removing it; a toast offers **Undo**. The Recycle bin page (sidebar) lists
  deleted items you own or deleted yourself, with Restore. Items are removed permanently after 30
  days; project owners and administrators can delete forever sooner, and administrators can empty
  the bin.

**Roles and access**
- **Global roles** (set by an administrator under Users):
  - *Administrator* — manages users, sees and controls every project.
  - *Manager* — can create projects; whoever creates a project is its owner.
  - *Member* — cannot create projects; works only in projects they are added to.
- **Project roles** (set by the project owner or an administrator in the project's Members tab):
  - *Owner* — full control, including members, settings and deletion. Ownership can be transferred.
  - *Contributor* — can create and change work.
  - *Viewer* — read-only.
- **What each member can see:** per member, the owner ticks the sections they may open — Features,
  Issues (Board, List, Timeline), Milestones, Releases, Risks, Docs, Reports, Activity. Hidden
  sections disappear from the project's tabs and from the dashboard, calendar, roadmap and search.
- All of this is enforced by the API, not just hidden in the interface.
- Administrators can filter the Projects page by owner.

**Chat**
- Private one-to-one messages, and **group chats**: name a group, add people, rename it, add or
  remove members (the creator can remove others; anyone can leave).
- Messages arrive instantly over a live connection, with online indicators, "typing…" and read
  receipts ("Seen", or "Seen by …" in groups). Reply to a message, react with an emoji, and share
  images (paste, drop or use the picture button).
- Unread counts in the sidebar and per conversation.

**Projects**
- Projects with key, colour, status (planning / active / on hold / completed / archived), dates,
  owner and members. Members only see projects they belong to; administrators see everything.
- Kanban board with drag-and-drop between and within columns, sortable list view, and filters by
  text, assignee, status, priority and type.
- Milestones with progress, per-project activity feed, member management, project settings.

**From plan to deployment**
- **Project lifecycle:** every project has a phase (Planning → Design → Development → Testing →
  Deployment → Live), shown as a stepper on the Overview tab. Project owners click a phase to move
  the project.
- **Features** tab: the list of things the project delivers. Each feature has a description,
  acceptance criteria, owner, priority, target date and a stage (Proposed → Planned → Design →
  Development → Testing → Deployment → Released). Issues are linked to a feature, so each feature
  shows its own progress, and the board and list can be filtered by feature.
- **Releases** tab: plan deployments per environment (development / staging / production) with a
  version, planned date, notes or checklist, and the features they ship. Marking a production
  release as deployed moves its features to Released and records the date.

**Working inside a project**
- **Checklists:** every issue has a sub-task checklist with its own progress bar; the count shows
  on board cards.
- **Recurring issues:** set an issue to repeat daily, weekly or monthly. When it is marked done the
  next occurrence is created automatically with shifted dates and a fresh checklist.
- **@mentions:** type `@` in a comment to pick a project member; they are notified.
- **Docs** tab: project documents (requirements, design notes, meeting notes, runbooks) with a
  read/edit toggle and simple formatting — `#` headings, lists, `- [ ]` tasks, `**bold**`, `` `code` ``.
- **Phase checklists:** each lifecycle phase has exit criteria you tick off. Moving the project
  forward with unticked items asks for confirmation. New projects start with a suggested set.
- **Risks** tab: a register of risks and blockers with probability, impact, owner, mitigation and
  review date. Severity is probability × impact; an open high risk marks the project "At risk" and
  appears in its owner's notifications.
- **Reports** tab: burndown with an ideal line, weekly created-versus-completed throughput,
  velocity and a completion forecast, breakdowns by person and by feature. Export issues, features
  and risks to CSV, or use Print / Save as PDF.
- **Feature board:** the Features tab switches between a list and a drag-and-drop board by stage,
  and the Timeline can group issues by feature instead of milestone.
- **Saved filters and bulk edit:** save a filter combination under a name (private to you). In the
  List view, tick several issues to change status, priority, assignee, feature or milestone at
  once, or delete them.
- **Templates:** create a project from a template (a built-in "Software delivery" one is included),
  or save any project's structure as a template from its Settings tab. Templates carry features,
  milestones, phase checklists, documents and risks — never issues, people or progress.

**Administration**
- **Audit log** (Users → Audit log): sign-ins and failed sign-ins, password changes and resets,
  user creation, changes and deletion, and project deletion, with time and IP address.

**Notifications**
- The bell in the top bar counts everything waiting on you. *Needs attention* is worked out live:
  your overdue or soon-due issues (within 3 days), features you own, and milestone, release and
  project deadlines in your projects, plus failed releases and — for administrators — pending
  password reset requests.
- *Updates* lists events from other people: an issue assigned to you, a comment on your issue,
  being added to a project, being made a feature owner or a feature of yours changing stage.
- Notifications appear inside the app only and arrive instantly; no emails are sent.

**Planning and scheduling**
- **Overview** tab per project: schedule health (on track / at risk / overdue), time elapsed
  against work completed, days remaining, upcoming deadlines, team workload and milestone progress.
- **Timeline** tab (Gantt chart): issues as bars grouped under milestones, with a today line and
  Day / Week / Month zoom. Drag a bar to move it, or drag an edge to change its start or due date.
- **Dependencies:** set "Blocked by" on an issue. The Gantt draws arrows between linked issues and
  turns an arrow red when an issue is scheduled to start before its blocker finishes. Circular
  dependencies are rejected.
- **Roadmap** page: every project and milestone on one timeline; projects you manage can be
  dragged to reschedule.
- **Calendar** page: month view of project, milestone and issue deadlines, filterable by project.
- **Time tracking:** estimate and time-spent hours per issue, totalled on the project Overview.
- Start and due dates on projects, milestones and issues.

**Issues**
- Types (task, bug, story, epic), priority, status, assignee, due date, estimate, labels, milestone.
- Detail panel with inline editing, comments and a full change history.
- The top bar searches projects by name, key, description or owner. Issues are filtered inside
  each project, the Features tab has its own search, and a *My issues* page lists yours across
  projects.

**Dashboard**
- Open / overdue / assigned-to-me counts, status and priority breakdowns, a 14-day
  created-vs-completed chart, upcoming deadlines, project progress and recent activity.

**Appearance**
- Light and dark themes. The default is **System**, which follows the device setting live; the
  choice is remembered per browser.

## Moving data from the old SQLite version

If you used the earlier SQLite-based version, import its data once (the SQLite file is not changed):

```bash
docker compose run --rm -v "$PWD/backend/data:/legacy:ro" app python migrate_to_postgres.py /legacy/app.db
```

Add `--replace` to overwrite a PostgreSQL database that already contains data.

## Configuration (`.env`)

| Variable              | Default             | Purpose                                              |
| --------------------- | ------------------- | ---------------------------------------------------- |
| `POSTGRES_PASSWORD`   | *(required)*        | Database password                                    |
| `PORT`                | `8000`              | Port the app is published on                         |
| `PM_ADMIN_USERNAME`   | `admin`             | First administrator (only used on an empty database) |
| `PM_ADMIN_PASSWORD`   | `Admin@123`         | Its temporary password                               |
| `PM_ADMIN_EMAIL`      | `admin@example.com` | Its email                                            |
| `PM_SECRET_KEY`       | generated           | Sign-in token key; generated and kept in a volume    |
| `PM_TOKEN_TTL_HOURS`  | `12`                | Session length                                       |

## Locked out of the admin account?

```bash
docker compose exec app python reset_admin.py admin
```

This prints the workspace ID and a new temporary password for that administrator. If several
workspaces have an administrator with that username, it lists them; run it again with the ID:
`python reset_admin.py admin 4821-7390`.

## Backups

A copy taken before each upgrade I made is kept in the `backups/` folder (ignored by git).


Back up the database to a file:

```bash
docker compose exec -T db pg_dump -U trackly trackly > trackly-backup.sql
```

Restore it into an empty database:

```bash
docker compose exec -T db psql -U trackly trackly < trackly-backup.sql
```

`docker compose down -v` deletes the volumes and all data — only use it to start from scratch.

## Upgrading

Rebuild with `docker compose up -d --build`. New tables and columns are added automatically on
start-up, so existing data is kept.

## Development without Docker

`./start.sh` runs the app on a local SQLite file (`backend/data/app.db`) for quick development.
For hot reload, run the API and the Vite dev server separately:

```bash
cd backend && .venv/bin/uvicorn app.main:app --reload --port 8001
```

```bash
cd frontend && npm run dev
```

Then open <http://localhost:5173>. Port 8001 keeps development away from the live app on 8000.
API documentation is at <http://localhost:8001/docs>. **For the full step-by-step way to change the
app and make it live, see [MAKING-CHANGES.md](MAKING-CHANGES.md).**

## Selling Trackly as a service (workspaces and licenses)

Trackly is multi-tenant: every company that signs up gets its own private **workspace** with its own
users, projects, chat and audit log. Nothing is shared between workspaces.

**How a customer buys a license**

1. They create a workspace at `/signup` and get a free trial (14 days by default, every feature,
   up to 5 users and 3 projects).
2. Their administrator opens **Billing**, picks a plan, the number of users and monthly or yearly
   billing, and sends a request. The page shows your payment instructions (your bank details).
   **No payment is taken by the app.**
3. They transfer the money to your company account and can enter the transfer reference.
4. You open **Owner console → License requests**, check the money has arrived and click **Activate**.
   That starts the license, creates a license key and a numbered invoice, and notifies the customer.

**The owner console** (`/platform`, only for the platform owner) lets you:

- see every workspace, its plan, users, projects, expiry date and last sign-in;
- change a plan, seats or expiry date by hand, extend a trial, suspend, reactivate or delete a workspace;
- create a workspace for a customer yourself (useful if you turn public sign-up off);
- edit plans, prices, limits and which features each plan includes;
- view all invoices, monthly recurring revenue and money received;
- set your company name, currency, trial length, bank / payment instructions, and open or close sign-up.

**What a license controls**

- *Seats*: active users cannot exceed the purchased number.
- *Projects*: limited by the plan.
- *Features*: sprints, custom workflows/fields/issue templates, automation, approvals, workload,
  budgets, group chats and the audit log are switched on per plan. Locked features show an upgrade notice.
- *Expiry*: when a trial or license ends, the workspace becomes **read-only** (data stays safe and
  visible) until it is renewed. Suspended workspaces are also read-only.

Default plans (edit them in the owner console): Starter, Business, Enterprise. Prices are per user.

**Who is the platform owner?** The first administrator of the installation. Data that existed before
workspaces were introduced became the workspace "My workspace", on an Enterprise license that never
expires. Start by opening **Owner console → Settings** and entering your bank details and currency.

Usernames and emails are unique across all workspaces, so everyone signs in on the same page.

## Stage sign-off, roles and the rest of the product layer

**Project roles.** Besides the owner, a member is a *Manager*, *Contributor*, *Tester* or *Viewer*
(Team tab). Managers can sign off stages and approve requests; testers work like contributors.

**Signed-off lifecycle.** Every feature (proposed → planned → design → development → testing →
deployment → released) and every milestone (planned → design → development → testing → deployment →
completed) moves one stage at a time. A stage is finished when the project owner or a manager signs
it off; any one of them is enough, and stages cannot be skipped. Other members press
**Request sign-off**, which notifies the owner and managers. Only the owner or a manager can move
something back. Switch the rule off per project under Settings → Stage sign-off. It needs a plan
that includes approvals.

**Also included**

- Public home page with pricing (`/welcome`), terms (`/terms`) and privacy policy (`/privacy`);
  the texts are edited in Owner console → Settings and are placeholders until you replace them.
  New sign-ups must accept them.
- Workspace data: **Billing → Your data** exports everything as one JSON file, or deletes the workspace.
- New workspaces get an example project and a getting-started checklist on the dashboard.
- **Client access:** project Settings → Client access creates read-only progress links (`/share/...`)
  that need no account.
- **Branding:** Billing → Edit sets a workspace logo, colour, time zone and a branded sign-in page at
  `/w/<name>`. Real subdomains such as `acme.yourproduct.com` need a wildcard DNS record and a reverse
  proxy that redirects `acme.yourproduct.com` to `/w/acme`.
- **Language and time zone:** Profile → Language and time zone (English, Hindi, Tamil, Spanish,
  French, German). Menus, sign-in and public pages are translated; add more strings in
  `frontend/src/i18n.js`.
- **Owner console:** Analytics (sign-ups, trial conversion, trials going cold), Coupons, a standing
  discount per workspace, a custom price when activating a request, Announcements and a Support inbox.
  Customers reach you from **Help and support** in the sidebar.

## Quality, client feedback, security and status

- **Sign-off checklists.** Project Settings → Stage sign-off → *Checklist for each stage*. Lines are
  ticked by a person, or checked automatically ("every linked issue is done", "every test case has
  passed"). A stage cannot be requested or signed off until its checklist is complete. Moving an
  item back clears the ticks of the stages it has to redo.
- **Sign-off deadlines.** The same card sets after how many days the owner and managers are
  reminded (default 2) and after how many the workspace administrators are told (default 5).
  Reminders are sent by a job that runs every 15 minutes. Overdue sign-offs are red in the bell.
- **Tests.** Project → Work → Tests. Write test cases per feature, mark them passed, failed or
  blocked; a failed case can raise a bug assigned to the feature owner. "New test round" sets
  every case back to *not run* and keeps the history.
- **Client feedback.** Share links can let clients comment and approve milestones or features.
  Feedback appears under the project's Approvals tab and Settings; the owner or a manager can reply.
- **Security** (Users → Security): password rules, active sessions with sign-out, and an allowed
  networks list (Enterprise). Everyone sees their own sessions in their profile.
  Behind a reverse proxy set `PM_TRUST_PROXY=1` so real visitor addresses are used; with plain
  Docker Desktop every visitor appears as the Docker gateway address, so the allowed-networks list
  is only meaningful on a real server.
- **Status page** at `/status`: current state, 90 days of uptime and incidents. Report incidents in
  Owner console → Status. The service checks itself every minute and counts gaps as downtime; it
  cannot alert you while it is down, so also point an outside monitor (UptimeRobot, Better Stack,
  …) at `/api/health`.

## Features and milestones move together

Give a feature a **Milestone** in its form. From then on (in projects with stage sign-off on):

- When every feature of a milestone has been signed off past a stage, the milestone moves to that
  stage by itself; the features' sign-offs are its approval.
- Signing off the milestone's stage signs off, in the same step, its features that are still at
  that stage. It is refused while a feature is further behind.
- A feature moved back takes its milestone back; a milestone moved back takes its features back.
- Nothing moves forward without an approved sign-off, and every automatic move is recorded as one.

Only one sign-off can be waiting per feature or milestone, and a phase, feature or release
approval cannot be requested again while it is waiting or after it was approved.

## Sign-off is always request, then approval

The lifecycle is shown on every feature and every milestone (its stages, checklist and sign-off),
not as one project-wide phase on the Overview.

- Anyone who can edit presses **Request sign-off** and chooses who to ask: the owner and all
  managers (first to answer decides), or one of them by name.
- Only the project **owner** or a project **manager** can approve. Workspace administrators can
  approve only if they are the owner or have the Manager role in that project.
- Nobody moves a stage forward without an approved request, including the owner. A request you
  sent yourself is approved by someone else, unless you are the only person who can approve.
- Deploying a release no longer marks its features as released; each feature gets there through
  its own sign-off.

## Two-factor sign-in

Anyone can turn it on under **Profile → Two-factor sign-in**: scan the QR code with an authenticator
app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…), confirm with a code, and save
the 10 recovery codes. From then on, signing in asks for the 6-digit code after the password.

- **Lost phone:** sign in with a recovery code (each works once), or ask a workspace administrator to
  reset two-factor under **Users** (shield icon). The person is signed out everywhere.
- **Require it for everyone:** Users → Security → *Require two-factor sign-in for everyone*. You must
  have it on yourself first. People without it must set it up before they can use the app.
- **Locked out as the platform owner:** `docker compose exec app python reset_admin.py admin` gives a
  temporary password and switches off two-factor for that account.
- Five wrong codes lock that account's code checks for ten minutes.

## Tests

**Backend** (`backend/tests/`, 114 tests): sign-in and two-factor, workspace isolation, plans and
licences, billing, the sign-off lifecycle and its modes, approvals, modules, projects and issues, test
management, client links and the owner console. Each run uses a brand-new database.

```bash
cd backend && .venv/bin/pip install -r requirements-dev.txt
```

```bash
cd backend && .venv/bin/pytest
```

On PostgreSQL, point `TEST_DATABASE_URL` at an empty database whose name contains `test`:

```bash
cd backend && TEST_DATABASE_URL=postgresql://trackly:trackly@127.0.0.1:55432/trackly_test .venv/bin/pytest
```

**Browser** (`frontend/e2e/`, Playwright): signs up, signs in, signs off stages in simple and strict
mode, decides approvals, switches modules, requests and activates a licence, and opens every page and
project tab checking for errors. It builds the frontend and starts the app on a throwaway database.

```bash
cd frontend && npx playwright install chromium
```

```bash
cd frontend && npm run test:e2e
```

GitHub runs all of this on every push (`.github/workflows/tests.yml`).

## Sign-off modes, approvals and modules

- **Sign-off mode per project**, chosen when the project is created and changeable in its settings:
  *Off* (stages move freely), *Simple* (default: the owner and managers sign a stage off in one click,
  others ask them) or *Strict* (every stage needs a request approved by the owner or a manager, never by
  the person who asked). Projects created before modes existed kept *Strict* (or *Off* if they had
  sign-off switched off).
- **One rule for every approval.** Stage sign-offs, phase, feature, release and other approvals are all
  decided by the person they were sent to, or else the owner or any manager, following the project's
  mode. The project's **Approvals** tab shows them in one place: waiting for you, waiting for others,
  and decided.
- **Modules** (Workspace settings, for administrators): sprints, test cases, documents, risks, time
  tracking, budgets, portfolio, workload, chat, automation and client links can each be hidden for the
  whole workspace. Hiding only hides; nothing is deleted. New workspaces start with time tracking,
  budgets, portfolio, workload, automation, test cases and risks hidden. Existing workspaces keep everything.

## Workspace IDs

Every workspace has a random 8-digit **workspace ID** (shown as `4821-7390`). Usernames and emails are
unique only inside a workspace, so the same person can have an account in two companies: two separate
accounts, each with its own password and two-factor setup.

- **Signing in** asks for the workspace ID, then the username or email and password. The ID may be
  typed with or without the dash, or replaced by the workspace's sign-in address (the `acme` in `/w/acme`).
  The device remembers it after the first sign-in, so people normally type it once.
- **Wrong ID, wrong person or wrong password** all give the same answer, so nobody can find out which IDs
  exist by trying them. Failed attempts are counted per workspace and username.
- **Forgot your workspace ID?** asks for an email and password and lists the workspaces they open. Without
  the right password nothing is shown. It is locked for a while after 5 failures.
- **Where to find it:** the profile page (everyone) and Workspace settings (administrators), both with
  a button that copies a sign-in link with the ID filled in. It is also shown when someone is added or
  their password is reset, after sign-up, and to the platform owner, who can search workspaces by ID.
- **Upgrading** gives every existing workspace an ID automatically; nobody's password changes.

## Plans and add-ons

Prices are per user, in the currency set in the owner console (Owner console → Settings). Yearly is
ten times the monthly price. The table shows the built-in US-dollar prices.

**Changing the currency converts the prices too.** When you change the currency in Owner console →
Settings, enter the exchange rate (a rough one is suggested) and you see every plan, add-on and coupon
in the new currency before saving, optionally rounded to friendly prices such as ₹499 and ₹999.
At ₹84 to the dollar the built-in prices become Starter ₹499, Professional ₹749, Business ₹999 and
Enterprise ₹1,699 per user per month, and add-ons ₹149 or ₹249. Requests and invoices already sent
keep their own currency.

| Plan | Per user / month | Users | Projects | Adds |
| --- | --- | --- | --- | --- |
| Free trial | — | 5 | 3 | everything, for 14 days |
| Free | 0 | 3 | 2 | the core app; starts at once, no approval needed |
| Starter | 6 | 10 | 10 | sprints, custom workflows, group chat |
| Professional | 9 | 25 | unlimited | simple stage sign-off, time tracking, workload |
| Business | 12 | 100 | unlimited | strict sign-off, budgets, automation, portfolio, client portal |
| Enterprise | 20 | unlimited | unlimited | everything, including test management and advanced security |

**Add-ons** are extras bought on top of any plan, in the same licence request, per user:
Approvals Pro (2), Client portal (2), Time and budgets (3), Test management (2), Automation (2),
Resource planning (2) and Advanced security (3). An add-on the plan already includes is never charged.

- **Customers** pick add-ons on the Billing page (an *Add* button on each, or in the request form).
  Anything their plan lacks shows an upgrade notice naming the add-on that unlocks it.
- **The platform owner** edits the add-on catalogue (Owner console → Add-ons), sees add-ons on each
  request and invoice, and can give a workspace any add-on free of charge from its page. Free add-ons
  stay when the workspace buys a licence without them; bought ones follow each licence.
- **Upgrading** an existing installation changes the built-in plans only if you never edited them, and
  workspaces that already existed keep, free of charge, the add-ons for features every workspace used to
  have (client portal, time tracking, test management, portfolio).

## Modules

A **module** is a part of the product made of several features (for example "Payments" with card,
UPI and refund features). A **milestone** holds several modules and can also hold features of its own.
Modules are on the project's *Plan → Modules* tab.

- **Sign-off for everything.** A module goes through the same stages as a feature (Proposed → … →
  Released), one stage at a time, and every step needs an approved sign-off from the project owner or
  a manager. Nothing moves to the next stage without it.
- **Features → module.** When every feature of a module has been signed off past a stage, the module
  moves on by itself (the features' sign-offs are its approval). A module is never ahead of its
  features: adding a feature that is further behind, or moving a feature back, takes the module back.
- **Module → features.** Signing off a module's stage signs off, in the same step, its features that
  are at that stage. Moving a module back moves its features back.
- **Milestones** follow all their features, including those in their modules, the same way.
- A feature in a module is always part of the module's milestone; move the module to move them all.
  Deleting a module keeps its features, in the same milestone.

The workspace switches that hide parts of the app (Workspace settings) are now called *Optional tools*.

## Time on features

Time can be logged on a feature itself (design, analysis, reviews) as well as on its issues. A feature
shows its total hours and, for the project owner and administrators, its cost; the project budget
breaks the cost down by feature; timesheets and workload include this time.

## Assistant

A free chat helper (the round button at the bottom right, or **Ctrl+J**). It uses no AI service:
it understands a fixed set of everyday phrases and answers from the workspace's own data, so nothing
leaves Trackly and it costs nothing to run. Type **help** to see everything it understands.

- **Questions:** "What is waiting for me?", "My work", "Overdue in Mobile App", "Dana's overdue",
  "Due this week", "Blocked", "Status of Payments", "Why is Beta release stuck", "APP-12",
  "Summary of Mobile App", "Budget of Store Redesign", "Who is overloaded", "Find checkout".
- **Actions, drafted for you to confirm:** "Create bug Login fails for Dana in Mobile App due Friday
  high priority", "Log 2h on APP-12 yesterday - fixing the form", "Log 30m on Checkout - design review",
  "Request sign-off for Payments". Nothing changes until you press the button on the draft, and
  confirming uses the normal app actions, so every permission and sign-off rule still applies.
- **What it can see:** exactly what the person asking could open themselves - their projects and the
  sections they may view; costs only for project owners and administrators.
- Admins can switch it off for everyone under Workspace settings → Optional tools.

## Chat: mentions and shortcuts

- **@mentions.** Type **@** in a message to pick someone from the conversation (arrow keys, then
  Enter or Tab). The person gets a notification that opens the chat, the message is highlighted for
  them, and the conversation shows an **@** badge until they read it. In a group, **@all** (or
  @everyone) notifies every member. Only members of the conversation can be mentioned.
- **/ shortcuts.** Type **/** at the start of a message:
  `/issue APP-12` shares an issue as a link (any issue key in a message is clickable),
  `/task <title>` and `/bug <title>` draft an issue with the assistant,
  `/ask <question>` asks the assistant, `/me <action>` posts "Dana is reviewing designs",
  `/shrug` adds ¯\_(ツ)_/¯, and `/help` lists them.
