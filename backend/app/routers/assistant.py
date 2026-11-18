"""The Trackly assistant: answers everyday questions from the workspace's own data and drafts
actions for the person to confirm. Free: no AI model, nothing is sent anywhere.

Every answer only uses projects and sections the person can open. Actions are never carried out
here: the assistant returns a draft, and the app saves it through the normal endpoints when the
person confirms, so all the usual permission and sign-off rules apply.
"""
import re
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import signoff
from ..access import access
from ..assistant import HELP, best_match, clean, parse, parse_date, split_issue_text, split_time_text
from ..database import get_db
from ..models import Approval, Feature, Issue, Milestone, ProjectModule, User, utcnow
from ..saas import has_feature
from ..security import get_current_user
from .projects import visible_projects_query

router = APIRouter(prefix="/api", tags=["assistant"])

LIMIT = 15
STAGE_LABEL = {s: s.capitalize() for s in signoff.FEATURE_STAGES + signoff.MILESTONE_STAGES}


class AskIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    project_id: int | None = None  # the project page the person is on, if any


class Context:
    """What this person can see, worked out once per question."""

    def __init__(self, db: Session, user: User, project_id: int | None):
        self.db, self.user, self.today = db, user, date.today()
        self.projects = [p for p in db.scalars(visible_projects_query(user)).all() if p.status != "archived"]
        self.access = {p.id: access(db, p, user) for p in self.projects}
        self.current = next((p for p in self.projects if p.id == project_id), None)

    def can(self, project, section: str) -> bool:
        acc = self.access.get(project.id)
        return bool(acc and section in acc["sections"])

    def projects_with(self, section: str):
        return [p for p in self.projects if self.can(p, section)]

    def project_named(self, words: str | None):
        if not words:
            return None
        words = clean(words)
        exact = next((p for p in self.projects if p.key.lower() == words), None)
        return exact or best_match(words, self.projects, lambda p: p.name)

    def people(self):
        return self.db.scalars(select(User).where(User.is_active).order_by(User.full_name)).all()

    def person_named(self, words: str | None):
        if not words:
            return None
        words = clean(words)
        if words in ("me", "myself", "i"):
            return self.user
        people = self.people()
        return next((u for u in people if u.username.lower() == words), None) or best_match(words, people, lambda u: u.full_name)

    def open_issues(self, projects=None):
        projects = projects if projects is not None else self.projects_with("issues")
        ids = [p.id for p in projects if self.can(p, "issues")]
        if not ids:
            return []
        return self.db.scalars(select(Issue).where(Issue.project_id.in_(ids), Issue.status != "done")).all()


# ───────────── How things are shown ─────────────


def day_text(d: date | None, today: date) -> str:
    if d is None:
        return "no due date"
    delta = (d - today).days
    if delta == 0:
        return "due today"
    if delta == 1:
        return "due tomorrow"
    if delta == -1:
        return "1 day late"
    if delta < 0:
        return f"{-delta} days late"
    if delta < 7:
        return f"due {d.strftime('%A')}"
    return f"due {d.strftime('%-d %b')}"


def status_label(i: Issue) -> str:
    """“To do” rather than “todo”: the label from the project's own workflow."""
    from ..workflow import project_statuses

    return next((s["label"] for s in project_statuses(i.project) if s["key"] == i.status), i.status.replace("_", " "))


def issue_item(i: Issue, today: date, note: str | None = None) -> dict:
    return {
        "type": "issue", "id": i.id, "project_id": i.project_id,
        "title": f"{i.project.key}-{i.number} {i.title}",
        "subtitle": " · ".join(x for x in (i.project.name, i.assignee.full_name if i.assignee else "unassigned",
                                           note or day_text(i.due_date, today)) if x),
        "badge": status_label(i), "late": bool(i.due_date and i.due_date < today),
    }


def feature_item(f: Feature, note: str = "") -> dict:
    return {"type": "feature", "id": f.id, "project_id": f.project_id, "title": f.title,
            "subtitle": " · ".join(x for x in (f.project.name, note) if x), "badge": STAGE_LABEL.get(f.stage, f.stage)}


def module_item(m: ProjectModule, note: str = "") -> dict:
    return {"type": "module", "id": m.id, "project_id": m.project_id, "title": m.name,
            "subtitle": " · ".join(x for x in (m.project.name, note) if x), "badge": STAGE_LABEL.get(m.stage, m.stage)}


def milestone_item(m: Milestone, today: date, note: str = "") -> dict:
    due = day_text(m.due_date, today) if m.due_date and m.status != "closed" else ""
    return {"type": "milestone", "id": m.id, "project_id": m.project_id, "title": m.name,
            "subtitle": " · ".join(x for x in (m.project.name, note or due) if x), "badge": STAGE_LABEL.get(m.stage, m.stage),
            "late": bool(m.due_date and m.due_date < today and m.status != "closed")}


def reply(text: str, items=None, stats=None, action=None, suggestions=None, help=None) -> dict:
    return {"text": text, "items": items or [], "stats": stats or [], "action": action,
            "suggestions": suggestions or [], "help": help}


def plural(n: int, word: str, words: str | None = None) -> str:
    return f"{n} {word if n == 1 else (words or word + 's')}"


# ───────────── Questions ─────────────


def answer_help(ctx: Context, parsed) -> dict:
    return reply(
        "Here is what I understand. I answer from your own projects only, and I never change anything "
        "until you confirm.",
        help=[{"example": e, "meaning": m} for e, m in HELP],
        suggestions=["What is waiting for me?", "My work", "Overdue", "Due this week"],
    )


def answer_approvals(ctx: Context, parsed) -> dict:
    waiting, mine = [], 0
    for a in ctx.db.scalars(select(Approval).where(Approval.status == "pending").order_by(Approval.created_at)).all():
        project = next((p for p in ctx.projects if p.id == a.project_id), None)
        if project is None:
            continue
        if signoff.may_decide(ctx.db, project, a, ctx.user):
            age = (utcnow() - a.created_at).days
            waiting.append({
                "type": "approval", "id": a.id, "project_id": a.project_id, "title": a.title,
                "subtitle": f"{project.name} · asked by {a.requester.full_name if a.requester else 'someone'}"
                            f" · {'today' if age == 0 else plural(age, 'day') + ' ago'}",
                "badge": "Stage sign-off" if a.kind == "stage" else "Approval", "late": age >= (project.signoff_remind_days or 2),
            })
        elif a.requester_id == ctx.user.id:
            mine += 1
    text = (f"{plural(len(waiting), 'request is', 'requests are')} waiting for your decision." if waiting
            else "Nothing is waiting for your decision.")
    if mine:
        text += f" {plural(mine, 'request')} you sent {'is' if mine == 1 else 'are'} waiting for others."
    return reply(text, waiting[:LIMIT], suggestions=["My work", "Overdue", "Due this week"])


def answer_my_work(ctx: Context, parsed) -> dict:
    issues = [i for i in ctx.open_issues() if i.assignee_id == ctx.user.id]
    issues.sort(key=lambda i: (i.due_date or date.max, i.id))
    late = sum(1 for i in issues if i.due_date and i.due_date < ctx.today)
    if not issues:
        return reply("You have no open issues. Enjoy it!", suggestions=["What is waiting for me?", "Due this week"])
    text = f"You have {plural(len(issues), 'open issue')}"
    text += f", {late} of them late." if late else "."
    return reply(text, [issue_item(i, ctx.today) for i in issues[:LIMIT]], suggestions=["Overdue", "Blocked", "Due this week"])


def answer_overdue(ctx: Context, parsed) -> dict:
    project = ctx.project_named(parsed.project) if parsed.project else None
    if parsed.project and project is None and ctx.person_named(parsed.project):
        parsed.person, project = parsed.project, None  # “overdue for Dana” read as a project at first
    elif parsed.project and project is None:
        return reply(f"I could not find a project called “{parsed.project}”.", suggestions=["Overdue"])
    person = ctx.person_named(parsed.person) if parsed.person else None
    issues = [i for i in ctx.open_issues([project] if project else None) if i.due_date and i.due_date < ctx.today]
    if person:
        issues = [i for i in issues if i.assignee_id == person.id]
    issues.sort(key=lambda i: (i.due_date, i.id))
    where = f" in {project.name}" if project else ""
    who = f" for {person.full_name}" if person else ""
    if not issues:
        return reply(f"Nothing is overdue{where}{who}. 🎉", suggestions=["Due this week", "Blocked"])
    counts: dict[str, int] = {}
    for i in issues:
        name = i.assignee.full_name if i.assignee else "Unassigned"
        counts[name] = counts.get(name, 0) + 1
    stats = [{"label": name, "value": n} for name, n in sorted(counts.items(), key=lambda kv: -kv[1])[:4]] if not person else []
    return reply(f"{plural(len(issues), 'issue is', 'issues are')} overdue{where}{who}.",
                 [issue_item(i, ctx.today) for i in issues[:LIMIT]], stats, suggestions=["Blocked", "Workload"])


def answer_due(ctx: Context, parsed) -> dict:
    today = ctx.today
    start, end = {
        "today": (today, today),
        "tomorrow": (today + timedelta(days=1), today + timedelta(days=1)),
        "this week": (today, today + timedelta(days=6 - today.weekday())),
        "next week": (today + timedelta(days=7 - today.weekday()), today + timedelta(days=13 - today.weekday())),
    }[parsed.when]
    project = ctx.project_named(parsed.project) if parsed.project else None
    scope = [project] if project else ctx.projects
    items = [issue_item(i, today) for i in sorted(
        (i for i in ctx.open_issues([p for p in scope if ctx.can(p, "issues")]) if i.due_date and start <= i.due_date <= end),
        key=lambda i: (i.due_date, i.id))]
    for p in scope:
        if ctx.can(p, "milestones"):
            items += [milestone_item(m, today) for m in p.milestones
                      if m.deleted_at is None and m.status != "closed" and m.due_date and start <= m.due_date <= end]
        if ctx.can(p, "features"):
            items += [feature_item(f, day_text(f.target_date, today)) for f in p.features
                      if f.deleted_at is None and f.stage != "released" and f.target_date and start <= f.target_date <= end]
    where = f" in {project.name}" if project else ""
    if not items:
        return reply(f"Nothing is due {parsed.when}{where}.", suggestions=["Overdue", "Due next week"])
    return reply(f"{plural(len(items), 'thing is', 'things are')} due {parsed.when}{where}.", items[:LIMIT * 2],
                 suggestions=["Overdue", "Blocked"])


def answer_blocked(ctx: Context, parsed) -> dict:
    project = ctx.project_named(parsed.project) if parsed.project else None
    rows = []
    for i in ctx.open_issues([project] if project else None):
        blockers = [b for b in i.blocked_by if b.status != "done" and b.deleted_at is None]
        if blockers:
            rows.append(issue_item(i, ctx.today, "waiting for " + ", ".join(f"{b.project.key}-{b.number}" for b in blockers)))
    where = f" in {project.name}" if project else ""
    if not rows:
        return reply(f"Nothing is blocked{where}.", suggestions=["Overdue", "Due this week"])
    return reply(f"{plural(len(rows), 'issue is', 'issues are')} waiting for other work{where}.", rows[:LIMIT],
                 suggestions=["Overdue", "Workload"])


def _features(ctx: Context):
    return [f for p in ctx.projects_with("features") for f in p.features if f.deleted_at is None]


def _modules(ctx: Context):
    ids = [p.id for p in ctx.projects_with("features")]
    return ctx.db.scalars(select(ProjectModule).where(ProjectModule.project_id.in_(ids or [0]))).all()


def _milestones(ctx: Context):
    return [m for p in ctx.projects_with("milestones") for m in p.milestones if m.deleted_at is None]


def _signoff_note(ctx: Context, target_type: str, obj) -> str:
    state = signoff.state(ctx.db, target_type, obj)
    pending = state["signoff"]
    if pending:
        days = pending["waiting_days"]
        who = pending["requester"]["full_name"] if pending["requester"] else "someone"
        return (f"Sign-off of {STAGE_LABEL.get(obj.stage, obj.stage)} was requested by {who} "
                f"{'today' if days == 0 else plural(days, 'day') + ' ago'} and waits for the owner or a manager.")
    if state["next_stage"]:
        return f"Next step: sign off {STAGE_LABEL.get(obj.stage, obj.stage)} to move to {STAGE_LABEL.get(state['next_stage'], state['next_stage'])}."
    return "It has finished every stage."


def answer_status(ctx: Context, parsed) -> dict:
    words = clean(parsed.rest or "")
    if not words:
        return answer_help(ctx, parsed)
    # An issue key such as APP-12.
    m = re.fullmatch(r"([a-z]{2,10})-(\d+)", words)
    if m:
        project = next((p for p in ctx.projects if p.key.lower() == m.group(1) and ctx.can(p, "issues")), None)
        issue = next((i for i in (project.issues if project else []) if i.number == int(m.group(2)) and i.deleted_at is None), None)
        if issue is None:
            return reply(f"I could not find {words.upper()}.", suggestions=["Find " + words])
        blockers = [b for b in issue.blocked_by if b.status != "done"]
        text = (f"{issue.project.key}-{issue.number} is {status_label(issue).lower()}, "
                f"{'assigned to ' + issue.assignee.full_name if issue.assignee else 'not assigned'}, {day_text(issue.due_date, ctx.today)}.")
        if blockers:
            text += " It waits for " + ", ".join(f"{b.project.key}-{b.number}" for b in blockers) + "."
        return reply(text, [issue_item(issue, ctx.today)])

    candidates = [("milestone", x, x.name) for x in _milestones(ctx)] + [("module", x, x.name) for x in _modules(ctx)] + \
                 [("feature", x, x.title) for x in _features(ctx)]
    found = best_match(words, candidates, lambda c: c[2])
    if found is None:
        project = ctx.project_named(words)
        if project:
            parsed.project = words
            return answer_summary(ctx, parsed)
        close = [c for c in candidates if words in clean(c[2]) or clean(c[2]) in words][:6]
        if close:
            items = [milestone_item(o, ctx.today) if t == "milestone" else module_item(o) if t == "module" else feature_item(o) for t, o, _ in close]
            return reply("Which one do you mean?", items)
        if parsed.extra.get("guess"):
            return reply("Sorry, I did not understand that. Here are things I can answer:",
                         help=[{"example": e, "meaning": m} for e, m in HELP], suggestions=["What is waiting for me?", "My work", "Overdue"])
        return reply(f"I could not find a feature, module, milestone or project called “{parsed.rest}”.", suggestions=["Find " + parsed.rest])

    kind, obj, _ = found
    stage = STAGE_LABEL.get(obj.stage, obj.stage)
    if kind == "feature":
        issues = [i for i in obj.issues if i.deleted_at is None]
        done = sum(1 for i in issues if i.status == "done")
        late = [i for i in issues if i.status != "done" and i.due_date and i.due_date < ctx.today]
        text = f"Feature “{obj.title}” is in {stage}. {_signoff_note(ctx, 'feature', obj)}"
        if issues:
            text += f" {done} of {plural(len(issues), 'issue')} done" + (f", {len(late)} late." if late else ".")
        where = [x for x in (f"module {obj.module.name}" if obj.module else "", f"milestone {obj.milestone.name}" if obj.milestone else "") if x]
        if where:
            text += " Part of " + " and ".join(where) + "."
        items = [feature_item(obj)] + [issue_item(i, ctx.today) for i in sorted(issues, key=lambda i: (i.status == "done", i.due_date or date.max))[:8]]
        return reply(text, items, suggestions=[f"Request sign-off for {obj.title}", f"Log 1h on {obj.title}"])
    gate = signoff.container_gate(kind, obj)
    if kind == "module":
        text = f"Module “{obj.name}” is in {stage}."
    else:
        due = f", {day_text(obj.due_date, ctx.today)}" if obj.due_date and obj.status != "closed" else ""
        text = f"Milestone “{obj.name}” is in {stage}{due}."
    items = [module_item(obj) if kind == "module" else milestone_item(obj, ctx.today)]
    if gate:
        text += f" {gate['signed_off']} of {plural(gate['total'], 'feature')} {'is' if gate['signed_off'] == 1 else 'are'} signed off past {stage}."
        if gate["behind"]:
            text += f" Holding it up: {', '.join(b['title'] for b in gate['behind'][:3])}{' and more' if len(gate['behind']) > 3 else ''}."
        else:
            text += f" It moves on by itself when the rest are, or sign it off to sign them off with it."
        features = sorted((f for f in obj.features if f.deleted_at is None), key=lambda f: signoff.FEATURE_STAGES.index(f.stage) if f.stage in signoff.FEATURE_STAGES else 0)
        items += [feature_item(f, "behind" if any(b["id"] == f.id for b in gate["behind"]) else "") for f in features[:10]]
    else:
        text += " It has no features yet."
    text += " " + _signoff_note(ctx, kind, obj)
    if kind == "milestone":
        items[1:1] = [module_item(mod) for mod in obj.modules]
    return reply(text, items[: LIMIT + 5], suggestions=[f"Request sign-off for {obj.name}", "What is waiting for me?"])


def answer_summary(ctx: Context, parsed) -> dict:
    project = ctx.project_named(parsed.project) if parsed.project else ctx.current
    if project is None and len(ctx.projects) == 1:
        project = ctx.projects[0]
    week_ago_dt = utcnow() - timedelta(days=7)
    if project is None:
        if parsed.project:
            return reply(f"I could not find a project called “{parsed.project}”.", suggestions=["Summary"])
        items = []
        for p in ctx.projects[:LIMIT]:
            issues = [i for i in p.issues if i.deleted_at is None] if ctx.can(p, "issues") else []
            done = sum(1 for i in issues if i.completed_at and i.completed_at >= week_ago_dt)
            late = sum(1 for i in issues if i.status != "done" and i.due_date and i.due_date < ctx.today)
            items.append({"type": "project", "id": p.id, "project_id": p.id, "title": p.name,
                          "subtitle": f"{done} done this week · {late} late", "badge": p.status.replace("_", " "), "late": late > 0})
        return reply(f"This week across your {plural(len(ctx.projects), 'project')}. Ask “summary of <project>” for one project.", items)

    issues = [i for i in project.issues if i.deleted_at is None] if ctx.can(project, "issues") else []
    created = sum(1 for i in issues if i.created_at >= week_ago_dt)
    done = sum(1 for i in issues if i.completed_at and i.completed_at >= week_ago_dt)
    open_ = [i for i in issues if i.status != "done"]
    late = [i for i in open_ if i.due_date and i.due_date < ctx.today]
    signed = ctx.db.scalars(select(Approval).where(
        Approval.project_id == project.id, Approval.status == "approved", Approval.decided_at >= week_ago_dt, Approval.kind == "stage")).all()
    pending = ctx.db.scalars(select(Approval).where(Approval.project_id == project.id, Approval.status == "pending")).all()
    soon = [m for m in project.milestones if m.deleted_at is None and m.status != "closed" and m.due_date
            and m.due_date <= ctx.today + timedelta(days=14)] if ctx.can(project, "milestones") else []
    stats = [
        {"label": "Done this week", "value": done}, {"label": "New this week", "value": created},
        {"label": "Open", "value": len(open_)}, {"label": "Late", "value": len(late)},
        {"label": "Stages signed off", "value": len(signed)}, {"label": "Sign-offs waiting", "value": len(pending)},
    ]
    text = f"{project.name} this week: {plural(done, 'issue')} done and {created} new. {len(open_)} open"
    text += f", {len(late)} late." if late else ", none late."
    if pending:
        text += f" {plural(len(pending), 'sign-off is', 'sign-offs are')} waiting."
    if soon:
        text += f" Coming up: {', '.join(m.name + ' (' + day_text(m.due_date, ctx.today) + ')' for m in soon[:3])}."
    items = [milestone_item(m, ctx.today) for m in soon] + [issue_item(i, ctx.today) for i in sorted(late, key=lambda i: i.due_date)[:8]]
    return reply(text, items, stats, suggestions=[f"Budget of {project.name}", f"Overdue in {project.name}", f"Blocked in {project.name}"])


def answer_budget(ctx: Context, parsed) -> dict:
    project = ctx.project_named(parsed.project) if parsed.project else ctx.current
    if project is None:
        return reply("Which project? Try “budget of <project name>”.",
                     suggestions=[f"Budget of {p.name}" for p in ctx.projects[:4]])
    if not has_feature(ctx.db, project.org_id, "budgets"):
        return reply("Budgets are not part of your plan. Add the Time and budgets add-on on the Billing page.")
    if not (ctx.user.role == "admin" or project.owner_id == ctx.user.id):
        return reply(f"Only the owner of {project.name} and administrators can see its costs.")
    from .delivery import project_cost

    cost = project_cost(ctx.db, project)
    money = lambda v: f"{cost['currency']} {v:,.0f}"  # noqa: E731
    if cost["budget"] is None:
        text = f"{project.name} has no budget set. {money(cost['cost'])} spent so far ({cost['hours']}h logged)."
    else:
        text = (f"{project.name} has used {cost['used_percent']}% of its budget: {money(cost['cost'])} of {money(cost['budget'])}, "
                f"{'over by ' + money(-cost['remaining']) if cost['remaining'] < 0 else money(cost['remaining']) + ' left'}.")
    if cost["unpriced_hours"]:
        text += f" {cost['unpriced_hours']}h have no hourly rate yet."
    features = {f.id: f for f in project.features}
    items = [feature_item(features[r["feature"]["id"]], f"{money(r['cost'])} · {r['hours']}h")
             for r in cost["features"] if r["feature"] and r["feature"]["id"] in features][:8]
    stats = [{"label": "Spent", "value": money(cost["cost"])}, {"label": "Hours", "value": cost["hours"]}]
    if cost["budget"] is not None:
        stats += [{"label": "Budget", "value": money(cost["budget"])}, {"label": "Used", "value": f"{cost['used_percent']}%"}]
    return reply(text, items, stats, suggestions=[f"Summary of {project.name}"])


def answer_workload(ctx: Context, parsed) -> dict:
    project = ctx.project_named(parsed.project) if parsed.project else None
    rows: dict[int, dict] = {}
    for i in ctx.open_issues([project] if project else None):
        if i.assignee is None:
            continue
        row = rows.setdefault(i.assignee_id, {"user": i.assignee, "open": 0, "late": 0, "hours": 0.0})
        row["open"] += 1
        row["late"] += 1 if i.due_date and i.due_date < ctx.today else 0
        row["hours"] += max(0.0, (i.estimate_hours or 0) - (i.spent_hours or 0))
    if not rows:
        return reply("Nobody has open issues assigned right now.")
    ranked = sorted(rows.values(), key=lambda r: (-r["open"], -r["late"]))
    top = ranked[0]
    text = f"{top['user'].full_name} has the most open work: {plural(top['open'], 'issue')}" + (f", {top['late']} late." if top["late"] else ".")
    items = [{"type": "person", "id": r["user"].id, "title": r["user"].full_name,
              "subtitle": f"{plural(r['open'], 'open issue')} · {r['late']} late" + (f" · {r['hours']:g}h estimated left" if r["hours"] else ""),
              "badge": "busy" if r["open"] >= 8 else "", "late": r["late"] > 0} for r in ranked[:10]]
    return reply(text, items, suggestions=["Overdue", "Blocked"])


def answer_find(ctx: Context, parsed) -> dict:
    words = clean(parsed.rest)
    items = []
    for i in ctx.open_issues() + [i for p in ctx.projects_with("issues") for i in p.issues if i.status == "done" and i.deleted_at is None]:
        if words in i.title.lower():
            items.append(issue_item(i, ctx.today))
    items = items[:10]
    items += [feature_item(f) for f in _features(ctx) if words in f.title.lower()][:6]
    items += [module_item(m) for m in _modules(ctx) if words in m.name.lower()][:4]
    items += [milestone_item(m, ctx.today) for m in _milestones(ctx) if words in m.name.lower()][:4]
    if not items:
        return reply(f"Nothing matches “{parsed.rest}”.")
    return reply(f"{plural(len(items), 'match', 'matches')} for “{parsed.rest}”.", items)


# ───────────── Actions (drafts to confirm) ─────────────


def _project_options(ctx: Context, section: str):
    out = []
    for p in ctx.projects:
        acc = ctx.access.get(p.id)
        if not acc or not acc["can_edit"] or section not in acc["sections"]:
            continue
        people = {p.owner_id: p.owner} if p.owner else {}
        people.update({m.id: m for m in p.members})
        out.append({
            "id": p.id, "name": p.name, "key": p.key,
            "people": [{"id": u.id, "name": u.full_name} for u in sorted(people.values(), key=lambda u: u.full_name) if u.is_active],
            "features": [{"id": f.id, "title": f.title} for f in p.features if f.deleted_at is None],
        })
    return out


def answer_create_issue(ctx: Context, parsed) -> dict:
    options = _project_options(ctx, "issues")
    if not options:
        return reply("You cannot create issues in any project.")
    projects = {p.id: p for p in ctx.projects}
    spell_projects = {}
    for o in options:
        spell_projects[o["name"].lower()] = o["id"]
        spell_projects[o["key"].lower()] = o["id"]
    spell_people = {}
    for u in ctx.people():
        spell_people[u.full_name.lower()] = u.id
        spell_people[u.username.lower()] = u.id
        spell_people.setdefault(u.full_name.split()[0].lower(), u.id)
    spell_people["me"] = ctx.user.id
    parts = split_issue_text(parsed.rest, spell_projects, spell_people)
    project_id = parts["project"] or (ctx.current.id if ctx.current and any(o["id"] == ctx.current.id for o in options) else None)
    if project_id is None and len(options) == 1:
        project_id = options[0]["id"]
    due = parse_date(parts["when"], ctx.today) if parts["when"] else None
    feature_id = None
    if parts["feature"] and project_id:
        feature = best_match(parts["feature"], [f for f in projects[project_id].features if f.deleted_at is None], lambda f: f.title)
        feature_id = feature.id if feature else None
    assignee = parts["person"]
    if assignee and project_id:
        members = next(o for o in options if o["id"] == project_id)["people"]
        if all(m["id"] != assignee for m in members):
            assignee = None  # not in that project: leave it for the person to pick
    fields = {
        "project_id": project_id, "title": parts["title"][:200], "type": parsed.extra["type"],
        "priority": parts["priority"] or "medium", "assignee_id": assignee,
        "due_date": due.isoformat() if due else None, "feature_id": feature_id,
    }
    missing = [x for x, ok in (("a title", fields["title"]), ("a project", project_id)) if not ok]
    text = "Here is the issue I would create. Check it and confirm." if not missing else \
        f"I need {' and '.join(missing)}. Fill {'it' if len(missing) == 1 else 'them'} in below, then confirm."
    return reply(text, action={"type": "create_issue", "fields": fields, "options": {"projects": options}})


def _find_target(ctx: Context, words: str, kinds=("feature", "module", "milestone")):
    candidates = []
    if "milestone" in kinds:
        candidates += [("milestone", x, x.name) for x in _milestones(ctx)]
    if "module" in kinds:
        candidates += [("module", x, x.name) for x in _modules(ctx)]
    if "feature" in kinds:
        candidates += [("feature", x, x.title) for x in _features(ctx)]
    return best_match(words, candidates, lambda c: c[2])


def answer_log_time(ctx: Context, parsed) -> dict:
    if not has_feature(ctx.db, ctx.user.org_id, "time_tracking"):
        return reply("Time tracking is not part of your plan. Add the Time and budgets add-on on the Billing page.")
    parts = split_time_text(parsed.rest)
    day = parse_date(parts["when"], ctx.today, past=True) if parts["when"] else ctx.today
    if day is None or day > ctx.today + timedelta(days=1):
        day = ctx.today
    target = None
    if parts["key"]:
        m = re.fullmatch(r"([A-Z]{2,10})-(\d+)", parts["key"])
        project = next((p for p in ctx.projects if p.key == m.group(1) and ctx.can(p, "issues")), None)
        issue = next((i for i in (project.issues if project else []) if i.number == int(m.group(2)) and i.deleted_at is None), None)
        if issue:
            target = {"type": "issue", "id": issue.id, "label": f"{project.key}-{issue.number} {issue.title}"}
    elif parts["target"]:
        found = _find_target(ctx, parts["target"], kinds=("feature",))
        if found:
            target = {"type": "feature", "id": found[1].id, "label": f"Feature: {found[1].title}"}
    if target is None:
        what = parts["key"] or parts["target"] or "that"
        return reply(f"I could not find {what}. Try an issue key like APP-12, or a feature name.",
                     suggestions=["Log 1h on APP-1", "My work"])
    fields = {"target_type": target["type"], "target_id": target["id"], "target_label": target["label"],
              "hours": parsed.extra["hours"], "day": day.isoformat(), "note": parts["note"][:300]}
    return reply(f"Log {parsed.extra['hours']:g}h on {target['label']} for {day.strftime('%A %-d %b')}? Confirm below.",
                 action={"type": "log_time", "fields": fields})


def answer_request_signoff(ctx: Context, parsed) -> dict:
    if not parsed.rest:
        return reply("Which feature, module or milestone? Try “request sign-off for <name>”.")
    found = _find_target(ctx, parsed.rest)
    if found is None:
        return reply(f"I could not find a feature, module or milestone called “{parsed.rest}”.")
    kind, obj, name = found
    project = obj.project
    if not signoff.gated(ctx.db, project):
        return reply(f"{project.name} does not use stage sign-off, so its stages can be changed directly.")
    acc = ctx.access.get(project.id)
    if not acc or not acc["can_edit"]:
        return reply(f"You can view {project.name} but not request sign-offs in it.")
    state = signoff.state(ctx.db, kind, obj)
    if state["signoff"]:
        return reply(f"A sign-off for {STAGE_LABEL.get(obj.stage, obj.stage)} of {name} is already waiting for the owner or a manager.")
    if not state["next_stage"]:
        return reply(f"{name} has already finished its last stage.")
    gate = state.get("feature_gate")
    if gate and gate.get("behind"):
        behind = ", ".join(b["title"] for b in gate["behind"][:3])
        return reply(f"{name} cannot be signed off yet: {behind} {'is' if len(gate['behind']) == 1 else 'are'} still behind.")
    open_checks = [c["text"] for c in state["checklist"] if not c["done"]]
    if open_checks:
        return reply(f"The {STAGE_LABEL.get(obj.stage, obj.stage)} checklist of {name} is not complete: {'; '.join(open_checks[:2])}.")
    approvers = [a.full_name for a in signoff.approvers(ctx.db, project) if a.id != ctx.user.id]
    fields = {"project_id": project.id, "target_type": kind, "target_id": obj.id, "label": f"{kind.capitalize()}: {name}",
              "stage": obj.stage, "to_stage": state["next_stage"], "note": ""}
    who = ", ".join(approvers) if approvers else "the project owner"
    return reply(f"Ask {who} to sign off {STAGE_LABEL.get(obj.stage, obj.stage)} of {name} "
                 f"(it then moves to {STAGE_LABEL.get(state['next_stage'], state['next_stage'])})? Confirm below.",
                 action={"type": "request_signoff", "fields": fields})


ANSWERS = {
    "help": answer_help, "approvals": answer_approvals, "my_work": answer_my_work, "overdue": answer_overdue,
    "due": answer_due, "blocked": answer_blocked, "status": answer_status, "summary": answer_summary,
    "budget": answer_budget, "workload": answer_workload, "find": answer_find,
    "create_issue": answer_create_issue, "log_time": answer_log_time, "request_signoff": answer_request_signoff,
}


@router.post("/assistant")
def ask(data: AskIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Answer one question. Read-only: actions come back as drafts for the person to confirm."""
    parsed = parse(data.text)
    answer = ANSWERS[parsed.intent](Context(db, user, data.project_id), parsed)
    return {"intent": parsed.intent, **answer}
