"""The free assistant: it understands everyday phrases, answers only from what the person may see,
and never changes anything itself (actions come back as drafts)."""
from datetime import date, timedelta

import pytest

from app.assistant import parse, parse_date, split_issue_text, split_time_text
from conftest import ok, unique

WED = date(2026, 11, 18)


# ───────────── Understanding words ─────────────


@pytest.mark.parametrize("words,expected", [
    ("today", WED), ("tomorrow", WED + timedelta(days=1)), ("friday", date(2026, 11, 20)), ("fri", date(2026, 11, 20)),
    ("next monday", date(2026, 11, 23)), ("in 3 days", date(2026, 11, 21)), ("25 nov", date(2026, 11, 25)),
    ("Nov 25th", date(2026, 11, 25)), ("2026-12-01", date(2026, 12, 1)), ("next week", date(2026, 11, 23)),
    ("wednesday", date(2026, 11, 25)), ("nonsense", None),
])
def test_dates(words, expected):
    assert parse_date(words, WED) == expected


def test_past_dates_for_time_logging():
    assert parse_date("monday", WED, past=True) == date(2026, 11, 16)
    assert parse_date("yesterday", WED, past=True) == date(2026, 11, 17)


@pytest.mark.parametrize("text,intent", [
    ("What is waiting for me?", "approvals"), ("my sign-offs", "approvals"), ("approvals", "approvals"),
    ("My work", "my_work"), ("what should I work on", "my_work"), ("Overdue in Mobile App", "overdue"),
    ("due this week", "due"), ("Blocked", "blocked"), ("budget of Store", "budget"), ("who is overloaded", "workload"),
    ("find checkout", "find"), ("summary of Mobile App", "summary"), ("what happened this week", "summary"),
    ("status of Beta", "status"), ("why is Payments stuck", "status"), ("APP-12", "status"),
    ("create bug login fails", "create_issue"), ("add a task: write docs", "create_issue"),
    ("log 2h on APP-3", "log_time"), ("log 30 min on checkout", "log_time"), ("request sign-off for Payments", "request_signoff"),
    ("help", "help"), ("hi", "help"),
])
def test_intents(text, intent):
    assert parse(text).intent == intent


def test_issue_text_only_takes_real_names():
    parts = split_issue_text("Login fails on Safari for Dana in Mobile App due Friday urgent",
                             {"mobile app": 1, "app": 1}, {"dana": 7})
    assert parts == {"title": "Login fails on Safari", "person": 7, "project": 1, "when": "Friday",
                     "priority": "urgent", "feature": None}
    assert split_issue_text("Fix the app header", {"app": 1}, {})["title"] == "Fix the app header"


def test_time_text():
    assert split_time_text("APP-12 yesterday - fixing the form") == {
        "target": "APP-12", "key": "APP-12", "when": "yesterday", "note": "fixing the form"}
    assert split_time_text("checkout - design review")["target"] == "checkout"


# ───────────── Answers ─────────────


class Shop:
    """A workspace with a project, people, a milestone, a module and features at known stages."""

    def __init__(self, workspace):
        ws = self.ws = workspace()
        self.dana = ws.add_person(full_name="Dana Lee")
        self.viewer = ws.add_person(full_name="Vic Viewer")
        self.project = ws.project("SHP", name="Shop app", signoff_mode="strict")
        pid = self.pid = self.project["id"]
        ok(ws.admin.api.post(f"/api/projects/{pid}/members", {"user_id": self.dana.id, "role": "contributor"}))
        ok(ws.admin.api.post(f"/api/projects/{pid}/members", {"user_id": self.viewer.id, "role": "viewer", "sections": ["features"]}))
        api = ws.admin.api
        self.beta = ok(api.post(f"/api/projects/{pid}/milestones", {"name": "Beta release", "due_date": (date.today() + timedelta(days=5)).isoformat()}), 201)
        self.card = ok(api.post(f"/api/projects/{pid}/features", {"title": "Card payments", "stage": "proposed"}), 201)
        self.upi = ok(api.post(f"/api/projects/{pid}/features", {"title": "UPI payments", "stage": "proposed"}), 201)
        self.module = ok(api.post(f"/api/projects/{pid}/modules", {"name": "Payments", "milestone_id": self.beta["id"],
                                                                   "feature_ids": [self.card["id"], self.upi["id"]]}), 201)
        late = (date.today() - timedelta(days=2)).isoformat()
        self.late = ok(api.post("/api/issues", {"project_id": pid, "title": "Card form crashes", "assignee_id": self.dana.id,
                                                "due_date": late, "feature_id": self.card["id"]}), 201)
        self.blocker = ok(api.post("/api/issues", {"project_id": pid, "title": "Gateway contract", "assignee_id": ws.admin.id}), 201)
        ok(api.patch(f"/api/issues/{self.late['id']}", {"blocked_by_ids": [self.blocker["id"]]}))

    def ask(self, person, text, **extra):
        return ok(person.api.post("/api/assistant", {"text": text, **extra}))


@pytest.fixture
def shop(workspace):
    return Shop(workspace)


def test_waiting_for_me_and_my_work(shop):
    ok(shop.dana.api.post(f"/api/projects/{shop.pid}/signoffs", {"target_type": "feature", "target_id": shop.upi["id"]}), 201)
    answer = shop.ask(shop.ws.admin, "What is waiting for me?")
    assert answer["text"].startswith("1 request is waiting") and answer["items"][0]["type"] == "approval"
    assert "waiting for others" in shop.ask(shop.dana, "my sign-offs")["text"]
    mine = shop.ask(shop.dana, "my work")
    assert mine["items"][0]["title"].endswith("Card form crashes") and "1 of them late" in mine["text"]


def test_overdue_blocked_and_due(shop):
    assert shop.ask(shop.ws.admin, "overdue")["text"].startswith("1 issue is overdue")
    assert shop.ask(shop.ws.admin, "overdue for Dana")["items"][0]["id"] == shop.late["id"]
    assert shop.ask(shop.ws.admin, "overdue in Shop app")["items"]
    assert "could not find a project" in shop.ask(shop.ws.admin, "overdue in Nowhere land")["text"]
    blocked = shop.ask(shop.ws.admin, "blocked")
    assert "waiting for SHP-" in blocked["items"][0]["subtitle"]
    due = shop.ask(shop.ws.admin, "due next week" if date.today().weekday() >= 2 else "due this week")
    assert any(i["type"] == "milestone" for i in due["items"]) or "Nothing is due" in due["text"]


def test_status_of_feature_module_and_milestone(shop):
    feature = shop.ask(shop.ws.admin, "status of card payments")
    assert feature["text"].startswith("Feature “Card payments” is in Proposed") and "1 late" in feature["text"]
    module = shop.ask(shop.ws.admin, "why is Payments stuck")
    assert module["text"].startswith("Module “Payments” is in Proposed") and "0 of 2 features" in module["text"]
    milestone = shop.ask(shop.ws.admin, "status of beta release")
    assert milestone["text"].startswith("Milestone “Beta release”") and any(i["type"] == "module" for i in milestone["items"])
    issue = shop.ask(shop.ws.admin, shop.late['key'])
    assert "waits for SHP-" in issue["text"]


def test_summary_budget_workload_and_find(shop):
    summary = shop.ask(shop.ws.admin, "summary of shop app")
    assert summary["text"].startswith("Shop app this week") and {s["label"] for s in summary["stats"]} >= {"Late", "Open"}
    assert shop.ask(shop.ws.admin, "summary", project_id=shop.pid)["text"].startswith("Shop app")
    assert "Only the owner" in shop.ask(shop.dana, "budget of shop app")["text"]
    assert "has no budget set" in shop.ask(shop.ws.admin, "budget of shop app")["text"]
    workload = shop.ask(shop.ws.admin, "who is overloaded")
    assert {i["title"] for i in workload["items"]} == {"Dana Lee", shop.ws.admin.user["full_name"]}
    found = shop.ask(shop.ws.admin, "find payments")
    assert {i["type"] for i in found["items"]} >= {"feature", "module"}


def test_answers_respect_sections_and_workspaces(shop, workspace):
    # The viewer may only open features: no issues, no milestones, in any answer.
    assert shop.ask(shop.viewer, "overdue")["text"].startswith("Nothing is overdue")
    assert not [i for i in shop.ask(shop.viewer, "find card")["items"] if i["type"] == "issue"]
    assert "could not find" in shop.ask(shop.viewer, "status of beta release")["text"].lower() or \
        not shop.ask(shop.viewer, "status of beta release")["items"]
    stranger = workspace()
    assert shop.ask(stranger.admin, "find payments")["text"].startswith("Nothing matches")
    assert shop.ask(stranger.admin, "overdue")["text"].startswith("Nothing is overdue")


def test_actions_are_drafts_only(shop):
    before = len(ok(shop.ws.admin.api.get(f"/api/issues?project_id={shop.pid}&limit=100")))
    draft = shop.ask(shop.ws.admin, "create bug Checkout fails on Safari for Dana in Shop app due Friday high priority")
    fields = draft["action"]["fields"]
    assert draft["action"]["type"] == "create_issue"
    assert fields["title"] == "Checkout fails on Safari" and fields["assignee_id"] == shop.dana.id
    assert fields["project_id"] == shop.pid and fields["priority"] == "high" and fields["type"] == "bug"
    assert date.fromisoformat(fields["due_date"]).weekday() == 4
    assert len(ok(shop.ws.admin.api.get(f"/api/issues?project_id={shop.pid}&limit=100"))) == before  # nothing created
    assert "need a title" in shop.ask(shop.ws.admin, "create task", project_id=shop.pid)["text"]

    time = shop.ask(shop.dana, f"log 1.5h on {shop.late['key']} yesterday - fixing the form")
    assert time["action"]["fields"]["hours"] == 1.5 and time["action"]["fields"]["note"] == "fixing the form"
    assert time["action"]["fields"]["day"] == (date.today() - timedelta(days=1)).isoformat()
    feature_time = shop.ask(shop.dana, "log 30m on card payments - design review")
    assert feature_time["action"]["fields"]["target_type"] == "feature"

    request = shop.ask(shop.dana, "request sign-off for card payments")
    assert request["action"]["fields"]["to_stage"] == "planned" and request["action"]["type"] == "request_signoff"
    # Confirming uses the normal endpoint, with its normal rules.
    ok(shop.dana.api.post(f"/api/projects/{shop.pid}/signoffs", {"target_type": "feature", "target_id": shop.card["id"]}), 201)
    assert "already waiting" in shop.ask(shop.dana, "request sign-off for card payments")["text"]
    # The module's features are all at its stage, so the module itself can be asked for.
    module = shop.ask(shop.dana, "request sign-off for Payments")
    assert module["action"]["fields"]["target_type"] == "module"


def test_unknown_words_get_help(shop):
    answer = shop.ask(shop.ws.admin, unique("qwzx"))
    assert answer["help"] and "did not understand" in answer["text"]
