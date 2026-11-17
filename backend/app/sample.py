"""A small example project for a brand-new workspace, so the trial is not an empty screen."""
from datetime import date, timedelta

from sqlalchemy.orm import Session

from .models import Document, Feature, Issue, Milestone, Organization, Project, Release, User


def create_sample_project(db: Session, org: Organization, user: User) -> Project:
    today = date.today()
    project = Project(
        org_id=org.id, name="Website launch (example)", key="DEMO", color="#6366f1", owner_id=user.id,
        description="An example project to explore. Change anything, or delete it when you start your own.",
        status="active", phase="development", start_date=today - timedelta(days=14), due_date=today + timedelta(days=45),
    )
    project.members.append(user)
    db.add(project)
    db.flush()

    design = Milestone(project_id=project.id, name="Design approved", stage="completed", status="closed",
                       start_date=today - timedelta(days=14), due_date=today - timedelta(days=3))
    build = Milestone(project_id=project.id, name="Site built", stage="development",
                      start_date=today - timedelta(days=3), due_date=today + timedelta(days=21))
    launch = Milestone(project_id=project.id, name="Public launch", stage="planned",
                       start_date=today + timedelta(days=21), due_date=today + timedelta(days=45))
    release = Release(project_id=project.id, version="1.0", environment="production", status="planned",
                      planned_date=today + timedelta(days=45), notes="First public version.")
    db.add_all([design, build, launch, release])
    db.flush()

    home = Feature(project_id=project.id, title="Home page", stage="development", priority="high", owner_id=user.id,
                   release_id=release.id, start_date=today - timedelta(days=5), target_date=today + timedelta(days=10),
                   description="The first page visitors see.", acceptance_criteria="- Loads in under two seconds\n- Works on phones")
    contact = Feature(project_id=project.id, title="Contact form", stage="planned", priority="medium", owner_id=user.id,
                      release_id=release.id, target_date=today + timedelta(days=25))
    db.add_all([home, contact])
    db.flush()

    rows = [
        ("Agree on the page layout", "task", "done", "medium", design, home, -6),
        ("Write the home page text", "task", "in_progress", "high", build, home, 4),
        ("Build the hero section", "story", "todo", "high", build, home, 8),
        ("Menu overlaps the logo on phones", "bug", "todo", "urgent", build, home, 2),
        ("Send form submissions by email", "task", "backlog", "medium", build, contact, 20),
        ("Final checks before launch", "task", "backlog", "medium", launch, None, 40),
    ]
    for n, (title, kind, status, priority, milestone, feature, due) in enumerate(rows, start=1):
        db.add(Issue(
            project_id=project.id, number=n, title=title, type=kind, status=status, priority=priority,
            assignee_id=user.id, reporter_id=user.id, milestone_id=milestone.id,
            feature_id=feature.id if feature else None, due_date=today + timedelta(days=due), position=n,
        ))
    project.issue_counter = len(rows)
    db.add(Document(
        project_id=project.id, title="Welcome to Trackly", author_id=user.id, updated_by_id=user.id,
        content=(
            "# How this example is organised\n\n"
            "- **Features** are what the project delivers. Each one moves through stages, and every "
            "stage is signed off by the project owner or a manager before the next one starts.\n"
            "- **Issues** are the day-to-day work under a feature.\n"
            "- **Milestones** are the big dates, and follow the same signed-off stages.\n"
            "- **Releases** are deployments.\n\n"
            "Delete this project from its Settings tab when you no longer need it."
        ),
    ))
    return project
