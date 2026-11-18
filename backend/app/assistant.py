"""The Trackly assistant: a free, rule-based helper (no AI model, nothing leaves the server).

It understands a fixed set of everyday phrases ("my sign-offs", "overdue in Mobile App", "create bug
login fails for Dana due Friday") and answers from the workspace's own data. This module holds the
pure parts that need no database: understanding the words, names and dates.
"""
import re
from dataclasses import dataclass, field
from datetime import date, timedelta

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
ISSUE_TYPES = {"bug": "bug", "task": "task", "issue": "task", "story": "story", "epic": "epic", "todo": "task"}
PRIORITIES = ("urgent", "high", "medium", "low")

DATE_WORDS = (
    r"today|tomorrow|yesterday|next week|end of (?:the )?week|"
    r"(?:next |this |on |last )?(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?|"
    r"in \d+ (?:days?|weeks?)|\d+ (?:days?|weeks?) ago|\d{4}-\d{2}-\d{2}|"
    r"\d{1,2}(?:st|nd|rd|th)? (?:of )?[a-z]{3,9}|[a-z]{3,9} \d{1,2}(?:st|nd|rd|th)?"
)


def clean(text: str) -> str:
    text = text.strip().lower().replace("’", "'").replace("‘", "'")
    text = re.sub(r"[“”\"]", "", text)
    text = re.sub(r"[?!.,;]+$", "", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_date(words: str, today: date, past: bool = False) -> date | None:
    """A day from everyday words. Weekdays mean the next one (or, with past=True, the last one)."""
    w = clean(words)
    w = re.sub(r"^(on|by|due|before|until|for)\s+", "", w)
    if w in ("today", "now", "tonight"):
        return today
    if w == "tomorrow":
        return today + timedelta(days=1)
    if w == "yesterday":
        return today - timedelta(days=1)
    if w in ("next week",):
        return today + timedelta(days=7 - today.weekday())  # next Monday
    if w in ("end of week", "end of the week", "this week"):
        return today + timedelta(days=max(0, 4 - today.weekday()))  # Friday
    m = re.fullmatch(r"in (\d+) (day|days|week|weeks)", w)
    if m:
        n = int(m.group(1)) * (7 if m.group(2).startswith("week") else 1)
        return today + timedelta(days=n)
    m = re.fullmatch(r"(\d+) (day|days|week|weeks) ago", w)
    if m:
        n = int(m.group(1)) * (7 if m.group(2).startswith("week") else 1)
        return today - timedelta(days=n)
    m = re.fullmatch(r"(next |this |last )?([a-z]+)", w)
    if m:
        word = m.group(2)
        day = next((i for i, d in enumerate(WEEKDAYS) if word == d or (len(word) >= 3 and d.startswith(word))), None)
        if day is not None:
            if past or m.group(1) == "last ":
                return today - timedelta(days=(today.weekday() - day) % 7 or 7)
            return today + timedelta(days=(day - today.weekday()) % 7 or 7)
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", w)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]{3,9})", w) or re.fullmatch(r"([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?", w)
    if m:
        a, b = m.groups()
        day_s, month_s = (a, b) if a.isdigit() else (b, a)
        month = next((i + 1 for i, mo in enumerate(MONTHS) if month_s.startswith(mo)), None)
        if month:
            try:
                candidate = date(today.year, month, int(day_s))
            except ValueError:
                return None
            if not past and candidate < today - timedelta(days=60):
                candidate = date(today.year + 1, month, int(day_s))
            return candidate
    return None


def name_score(query: str, name: str) -> int:
    """How well a typed name matches a real one: 0 means no match."""
    q, n = clean(query), clean(name)
    if not q or not n:
        return 0
    if q == n:
        return 100
    if n.startswith(q):
        return 80
    words = n.split()
    if q in words:
        return 70
    if any(w.startswith(q) for w in words) and len(q) >= 3:
        return 60
    if len(q) >= 3 and q in n:
        return 40
    return 0


def best_match(query: str, items, name_of, minimum: int = 40):
    """The single best match, or None. Ties at the top score count as no clear match."""
    scored = sorted(((name_score(query, name_of(i)), i) for i in items), key=lambda pair: -pair[0])
    if not scored or scored[0][0] < minimum:
        return None
    if len(scored) > 1 and scored[1][0] == scored[0][0] and clean(name_of(scored[0][1])) != clean(query):
        # Two things fit equally well; prefer an exact name, otherwise do not guess.
        return None
    return scored[0][1]


@dataclass
class Parsed:
    intent: str
    rest: str = ""  # the words that name a thing (a feature, a project …)
    project: str | None = None  # "in Mobile App"
    person: str | None = None  # "for Dana"
    when: str | None = None  # "today", "this week"
    extra: dict = field(default_factory=dict)


HELP = [
    ("What is waiting for me?", "Sign-offs and approvals waiting for your decision"),
    ("My work", "Your open issues, soonest due first"),
    ("Overdue", "Late issues; add “in <project>” or “for <person>”"),
    ("Due this week", "Also: due today, due tomorrow, due next week"),
    ("Blocked", "Issues waiting for another issue"),
    ("Status of <feature, module or milestone>", "Its stage, sign-off and what holds it up"),
    ("Summary of <project>", "What happened this week"),
    ("Budget of <project>", "Spent, remaining and cost by feature"),
    ("Workload", "Who has the most open work"),
    ("Find <words>", "Search issues, features, modules and milestones"),
    ("Create bug <title> for <person> due <day>", "Drafts an issue for you to confirm"),
    ("Log 2h on <issue key or feature> yesterday", "Drafts a time entry for you to confirm"),
    ("Request sign-off for <feature, module or milestone>", "Drafts a sign-off request for you to confirm"),
]


def parse(raw: str) -> Parsed:
    """Work out what someone is asking. Order matters: actions first, then specific questions."""
    text = clean(raw)
    if not text or re.fullmatch(r"help|\?|hi|hello|hey|what can you do|commands|menu", text):
        return Parsed("help")

    # ── Actions (they are drafted, never done straight away) ──
    m = re.match(r"(?:create|add|new|raise|open|file|log|report)\s+(?:an?\s+|the\s+)?(?:new\s+)?(bug|task|issue|story|epic|todo)\b[:\s-]*(.*)$", text)
    if m:
        return Parsed("create_issue", rest=raw_tail(raw, m.group(2)), extra={"type": ISSUE_TYPES[m.group(1)]})
    m = re.match(r"(?:log|add|record|spent|track)\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b\s*(?:on|to|for|against)?\s*(.*)$", text)
    if m:
        hours = float(m.group(1)) / (60 if m.group(2).startswith("m") else 1)
        return Parsed("log_time", rest=m.group(3), extra={"hours": round(hours, 2)})
    m = re.match(r"(?:request|ask for|send|get)\s+(?:a\s+)?sign[- ]?off\s*(?:for|on|of)?\s*(.*)$", text)
    if m:
        return Parsed("request_signoff", rest=m.group(1))

    # ── Questions ──
    if re.search(r"sign[- ]?offs?|approvals?|waiting (?:for|on) me|needs? my (?:approval|decision|sign)|to approve", text):
        return Parsed("approvals")
    if re.search(r"\bmy (?:issues|tasks|work|todos?)\b|assigned to me|what should i (?:work on|do)|what do i have", text):
        return Parsed("my_work")
    if re.search(r"\b(overdue|late|past due|behind schedule)\b", text) and not re.search(r"\bwhy\b", text):
        who = re.search(r"\bfor ([a-z][a-z.'-]+)$", text) or re.search(r"\b([a-z][a-z.'-]+)'s\b", text)
        return Parsed("overdue", project=_after(text, ("in", "on")), person=who.group(1) if who else None)
    m = re.search(r"\bdue (today|tomorrow|this week|next week)\b", text)
    if m:
        return Parsed("due", when=m.group(1), project=_after(text, ("in", "on")))
    if re.search(r"\bblock(?:ed|ing|ers?)?\b|dependenc", text):
        return Parsed("blocked", project=_after(text, ("in", "on")))
    if re.search(r"\bbudget|\bcost|\bspent\b|\bmoney\b|\bexpenses?\b", text):
        return Parsed("budget", project=_after(text, ("in", "on", "of", "for")))
    if re.search(r"workload|overloaded|too much work|busiest|capacity|who is busy|who has", text):
        return Parsed("workload", project=_after(text, ("in", "on")))
    m = re.match(r"(?:find|search|search for|look for|look up|show me)\s+(.+)$", text)
    if m and not re.search(r"\b(summary|status)\b", m.group(1)):
        return Parsed("find", rest=m.group(1))
    if re.search(r"summary|summari[sz]e|what (?:changed|happened)|this week|progress|how is|how are|update on|report", text):
        target = re.sub(r"^.*?(?:summary|summari[sz]e|what (?:changed|happened)|progress|how is|how are|update on|report)\s*(?:of|for|in|on)?\s*", "", text)
        target = re.sub(r"\b(this|last) week\b|\bgoing\b|\bdoing\b", "", target).strip()
        return Parsed("summary", project=target or None)
    m = re.match(r"(?:what(?:'s| is)? the )?(?:status|stage|state)\s+(?:of|for)\s+(.+)$", text) or \
        re.match(r"(?:where is|why is|is)\s+(.+?)(?:\s+(?:stuck|late|blocked|delayed|done|ready|going))?$", text)
    if m:
        return Parsed("status", rest=m.group(1))
    if re.fullmatch(r"[a-z]{2,10}-\d+", text):
        return Parsed("status", rest=text)
    # Anything else: maybe it is just the name of something.
    return Parsed("status", rest=text, extra={"guess": True})


def _after(text: str, words) -> str | None:
    m = re.search(r"\b(?:%s)\s+(?:project\s+)?(.+)$" % "|".join(words), text)
    return m.group(1).strip() if m else None


def raw_tail(raw: str, lowered_tail: str) -> str:
    """The same words as typed (keeping capitals) for titles."""
    if not lowered_tail:
        return ""
    index = raw.lower().rfind(lowered_tail[: max(1, min(len(lowered_tail), 12))])
    return raw[index:].strip() if index >= 0 else lowered_tail


def _take_known(work: str, connectors: str, names: dict) -> tuple[str, object | None]:
    """Remove “<connector> <a known name>” from the text; longest names first, so “Mobile App 2.0”
    wins over “Mobile App”. names maps each spelling (name, key, first name …) to the thing."""
    for spelling in sorted(names, key=len, reverse=True):
        if not spelling:
            continue
        m = re.search(r"\s(?:%s)\s+(?:project\s+)?%s(?=\s)" % (connectors, re.escape(spelling)), work, re.I)
        if m:
            return work[: m.start()] + " " + work[m.end():], names[spelling]
    return work, None


def split_issue_text(text: str, projects: dict | None = None, people: dict | None = None) -> dict:
    """“Login fails on Safari for Dana in Mobile App due Friday high priority” → its parts. Projects
    and people are only recognised by their real names, so “on Safari” stays in the title."""
    parts = {"title": text.strip(), "person": None, "project": None, "when": None, "priority": None, "feature": None}
    work = " " + text.strip() + " "
    m = re.search(r"\s(urgent|high|medium|low)(?:\s+priority)?(?=\s)", work, re.I) or re.search(r"\spriority\s+(urgent|high|medium|low)(?=\s)", work, re.I)
    if m:
        parts["priority"] = m.group(1).lower()
        work = work[: m.start()] + " " + work[m.end():]
    m = re.search(r"\s(?:due|by|before)\s+(%s)(?=\s)" % DATE_WORDS, work, re.I)
    if m:
        parts["when"] = m.group(1)
        work = work[: m.start()] + " " + work[m.end():]
    m = re.search(r"\s(?:under|in|for)\s+feature\s+(.+?)(?=\s(?:for|assign(?:ed)?\s+to|in|on)\s|\s*$)", work, re.I)
    if m:
        parts["feature"] = m.group(1).strip()
        work = work[: m.start()] + " " + work[m.end():]
    work, parts["project"] = _take_known(work, "in|on|for", projects or {})
    work, parts["person"] = _take_known(work, "assign(?:ed)?\\s+to|for|to", people or {})
    parts["title"] = re.sub(r"\s+", " ", work).strip(" :-")
    return parts


def split_time_text(text: str) -> dict:
    """“APP-12 yesterday - fixing the form” → what it was on, which day, and a note."""
    parts = {"target": "", "key": None, "when": None, "note": ""}
    work = " " + text.strip() + " "
    m = re.search(r"\s(?:on\s+)?(%s)(?=\s)" % DATE_WORDS, work, re.I)
    if m:
        parts["when"] = m.group(1)
        work = work[: m.start()] + " " + work[m.end():]
    m = re.search(r"\s(?:-|:|doing|working on|note:?)\s+(.+?)\s*$", work, re.I)
    if m:
        parts["note"] = m.group(1).strip()
        work = work[: m.start()] + " "
    key = re.search(r"\b([a-z]{2,10}-\d+)\b", work, re.I)
    if key:
        parts["key"] = key.group(1).upper()
        leftover = (work[: key.start()] + " " + work[key.end():]).strip()
        if leftover and not parts["note"]:
            parts["note"] = re.sub(r"^(?:for|doing)\s+", "", leftover)
    parts["target"] = re.sub(r"^(?:the\s+)?(?:feature\s+)?", "", re.sub(r"\s+", " ", work).strip(" :-"), flags=re.I)
    return parts
