"""Per-project issue workflow (the list of statuses an issue can be in).

Every workflow ends in the fixed "done" status, which is what the rest of the application
treats as completed. Its label and colour can be changed, but it cannot be removed.
"""
import json
import re

from .models import Project

DEFAULT_STATUSES = [
    {"key": "backlog", "label": "Backlog", "color": "#94a3b8"},
    {"key": "todo", "label": "To do", "color": "#3b82f6"},
    {"key": "in_progress", "label": "In progress", "color": "#f59e0b"},
    {"key": "in_review", "label": "In review", "color": "#a855f7"},
    {"key": "done", "label": "Done", "color": "#22c55e"},
]
MAX_STATUSES = 12
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def project_statuses(project: Project) -> list[dict]:
    cached = getattr(project, "_statuses_cache", None)
    if cached is not None and cached[0] == project.workflow:
        return cached[1]
    statuses = DEFAULT_STATUSES
    if project.workflow:
        try:
            parsed = json.loads(project.workflow)
            if isinstance(parsed, list) and any(s.get("key") == "done" for s in parsed):
                statuses = parsed
        except (ValueError, AttributeError):
            pass
    project._statuses_cache = (project.workflow, statuses)
    return statuses


def status_meta(project: Project, key: str) -> dict:
    for status in project_statuses(project):
        if status["key"] == key:
            return status
    return {"key": key, "label": key.replace("_", " ").capitalize(), "color": "#94a3b8"}


def status_keys(project: Project) -> list[str]:
    return [s["key"] for s in project_statuses(project)]


def default_status(project: Project) -> str:
    keys = status_keys(project)
    if "todo" in keys:
        return "todo"
    return next((k for k in keys if k != "done"), "done")


def slugify(label: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:16] or "status"
    if base == "done":
        base = "done_2"
    key, n = base, 2
    while key in taken:
        key, n = f"{base[:13]}_{n}", n + 1
    return key
