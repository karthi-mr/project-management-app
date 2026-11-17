"""Project templates: reusable starting structure for new projects."""
import json
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Document, Feature, Milestone, PhaseCheck, Project, ProjectTemplate, Risk, User

PHASES = ["planning", "design", "development", "testing", "deployment", "live"]

DEFAULT_PHASE_CHECKS = {
    "planning": [
        "Goals and scope agreed",
        "Feature list written and prioritised",
        "Timeline and milestones set",
        "Risks identified",
    ],
    "design": [
        "Architecture and technical approach decided",
        "UI/UX designs approved",
        "Data model defined",
    ],
    "development": [
        "All planned features implemented",
        "Code reviewed",
        "No urgent bugs open",
    ],
    "testing": [
        "Test plan executed",
        "Acceptance criteria verified for every feature",
        "User acceptance testing signed off",
    ],
    "deployment": [
        "Deployment runbook reviewed",
        "Backup and rollback plan ready",
        "Production release deployed and smoke tested",
    ],
    "live": [
        "Monitoring in place",
        "Handover and documentation complete",
    ],
}

BUILTIN_TEMPLATE = {
    "name": "Software delivery",
    "description": "Phase checklists, key milestones, starter documents and common risks for a software project.",
    "data": {
        "phase_checks": DEFAULT_PHASE_CHECKS,
        "milestones": [
            {"name": "Requirements signed off", "offset_days": 14},
            {"name": "Design complete", "offset_days": 28},
            {"name": "Feature complete", "offset_days": 70},
            {"name": "UAT complete", "offset_days": 84},
            {"name": "Go-live", "offset_days": 90},
        ],
        "documents": [
            {"title": "Requirements", "content": "# Requirements\n\n## Goals\n- \n\n## In scope\n- \n\n## Out of scope\n- \n"},
            {"title": "Technical design", "content": "# Technical design\n\n## Architecture\n\n## Data model\n\n## Open questions\n- \n"},
            {"title": "Test plan", "content": "# Test plan\n\n## Scenarios\n- [ ] \n\n## Environments\n- Staging\n"},
            {"title": "Deployment runbook", "content": "# Deployment runbook\n\n## Before\n- [ ] Back up the database\n\n## Steps\n1. \n\n## Rollback\n1. \n"},
            {"title": "Meeting notes", "content": "# Meeting notes\n\n## Date\n\n**Attendees:** \n\n**Decisions**\n- \n\n**Actions**\n- [ ] \n"},
        ],
        "risks": [
            {"title": "Scope grows beyond the plan", "probability": "medium", "impact": "high",
             "mitigation": "Review new requests against the feature list; move extras to a later release."},
            {"title": "Key person unavailable", "probability": "low", "impact": "high",
             "mitigation": "Keep documents current so someone else can pick up the work."},
        ],
        "features": [],
    },
}


def seed_builtin_template(db: Session) -> None:
    if db.scalar(select(ProjectTemplate).where(ProjectTemplate.builtin)):
        return
    db.add(
        ProjectTemplate(
            name=BUILTIN_TEMPLATE["name"],
            description=BUILTIN_TEMPLATE["description"],
            data=json.dumps(BUILTIN_TEMPLATE["data"]),
            builtin=True,
        )
    )
    db.commit()


def add_phase_checks(db: Session, project: Project, checks: dict) -> int:
    added = 0
    for phase in PHASES:
        for text in checks.get(phase, []):
            if isinstance(text, str) and text.strip():
                db.add(PhaseCheck(project_id=project.id, phase=phase, text=text.strip()[:300]))
                added += 1
    return added


def apply_template(db: Session, project: Project, data: dict, user: User) -> None:
    base = project.start_date or date.today()
    add_phase_checks(db, project, data.get("phase_checks") or {})
    for m in data.get("milestones") or []:
        offset = m.get("offset_days")
        db.add(
            Milestone(
                project_id=project.id,
                name=str(m.get("name", "Milestone"))[:120],
                description=str(m.get("description", "")),
                due_date=base + timedelta(days=int(offset)) if isinstance(offset, (int, float)) else None,
            )
        )
    for f in data.get("features") or []:
        db.add(
            Feature(
                project_id=project.id,
                title=str(f.get("title", "Feature"))[:200],
                description=str(f.get("description", "")),
                acceptance_criteria=str(f.get("acceptance_criteria", "")),
                priority=f.get("priority") if f.get("priority") in ("low", "medium", "high", "urgent") else "medium",
                stage="planned",
            )
        )
    for d in data.get("documents") or []:
        db.add(
            Document(
                project_id=project.id,
                title=str(d.get("title", "Document"))[:200],
                content=str(d.get("content", "")),
                author_id=user.id,
                updated_by_id=user.id,
            )
        )
    levels = ("low", "medium", "high")
    for r in data.get("risks") or []:
        db.add(
            Risk(
                project_id=project.id,
                title=str(r.get("title", "Risk"))[:200],
                description=str(r.get("description", "")),
                mitigation=str(r.get("mitigation", "")),
                probability=r.get("probability") if r.get("probability") in levels else "medium",
                impact=r.get("impact") if r.get("impact") in levels else "medium",
            )
        )


def snapshot_project(project: Project) -> dict:
    """Capture a project's reusable structure (never its issues, people or progress)."""
    base = project.start_date
    checks: dict[str, list[str]] = {}
    for c in project.phase_checks:
        checks.setdefault(c.phase, []).append(c.text)
    return {
        "phase_checks": checks,
        "milestones": [
            {
                "name": m.name,
                "description": m.description,
                "offset_days": (m.due_date - base).days if base and m.due_date else None,
            }
            for m in project.milestones
        ],
        "features": [
            {
                "title": f.title,
                "description": f.description,
                "acceptance_criteria": f.acceptance_criteria,
                "priority": f.priority,
            }
            for f in project.features
        ],
        "documents": [{"title": d.title, "content": d.content} for d in project.documents],
        "risks": [
            {
                "title": r.title,
                "description": r.description,
                "mitigation": r.mitigation,
                "probability": r.probability,
                "impact": r.impact,
            }
            for r in project.risks
        ],
    }
