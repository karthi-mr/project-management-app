from datetime import date, datetime, timezone

from sqlalchemy import (
    LargeBinary,
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


project_members = Table(
    "project_members",
    Base.metadata,
    Column("project_id", ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role", String(20), nullable=False, server_default="contributor"),  # manager | contributor | tester | viewer
    Column("sections", String(200), nullable=False, server_default="all"),  # "all" or a,b,c
)


issue_dependencies = Table(
    "issue_dependencies",
    Base.metadata,
    Column("issue_id", ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True),
    Column("depends_on_id", ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True),
)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        # The same username or email may exist in different workspaces as separate accounts;
        # people sign in with their workspace ID to say which one they mean.
        UniqueConstraint("org_id", "username", name="uq_users_org_username"),
        UniqueConstraint("org_id", "email", name="uq_users_org_email"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), index=True)
    email: Mapped[str] = mapped_column(String(255), index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(20), default="member")  # admin | manager | member
    password_hash: Mapped[str] = mapped_column(String(255))
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    avatar_color: Mapped[str] = mapped_column(String(20), default="#6366f1")
    avatar_url: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # The workspace (customer) this person belongs to; every user belongs to exactly one.
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True)
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, default=False)  # runs the SaaS itself
    terms_accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Two-factor sign-in (see twofactor.py). The pending secret is the one being set up.
    totp_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    totp_pending_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    totp_enabled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    totp_last_step: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recovery_codes: Mapped[str] = mapped_column(Text, default="")  # JSON list of hashes
    hourly_rate: Mapped[float | None] = mapped_column(Float, nullable=True)  # cost per hour, for budgets
    weekly_capacity: Mapped[float] = mapped_column(Float, default=40)  # hours per week, for workload
    preferences: Mapped[str] = mapped_column(Text, default="")  # JSON, per-user UI settings
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PasswordResetRequest(Base):
    __tablename__ = "password_reset_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    note: Mapped[str] = mapped_column(String(500), default="")
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | approved | rejected
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    user: Mapped[User] = relationship(foreign_keys=[user_id])


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("org_id", "key", name="uq_projects_org_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    name: Mapped[str] = mapped_column(String(120))
    # Features and milestones move one stage at a time, each signed off by the owner or a manager.
    signoff_required: Mapped[bool] = mapped_column(Boolean, default=True)  # kept in step with signoff_mode
    # off: stages move freely. simple: owners and managers sign off in one click, others ask them.
    # strict: every stage needs a request approved by the owner or a manager, never by the requester.
    signoff_mode: Mapped[str] = mapped_column(String(10), default="simple")
    signoff_remind_days: Mapped[int] = mapped_column(Integer, default=2)
    signoff_escalate_days: Mapped[int] = mapped_column(Integer, default=5)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True)
    key: Mapped[str] = mapped_column(String(10), index=True)  # unique within a workspace
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="active")
    phase: Mapped[str] = mapped_column(String(20), default="planning")  # lifecycle stage
    logo_url: Mapped[str | None] = mapped_column(String(200), nullable=True)
    budget: Mapped[float | None] = mapped_column(Float, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    workflow: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list of issue statuses
    color: Mapped[str] = mapped_column(String(20), default="#6366f1")
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    issue_counter: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    owner: Mapped[User | None] = relationship(foreign_keys=[owner_id])
    members: Mapped[list[User]] = relationship(secondary=project_members)
    issues: Mapped[list["Issue"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    milestones: Mapped[list["Milestone"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    activities: Mapped[list["Activity"]] = relationship(cascade="all, delete-orphan")
    features: Mapped[list["Feature"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    releases: Mapped[list["Release"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    documents: Mapped[list["Document"]] = relationship(cascade="all, delete-orphan")
    phase_checks: Mapped[list["PhaseCheck"]] = relationship(
        cascade="all, delete-orphan", order_by="PhaseCheck.id"
    )
    risks: Mapped[list["Risk"]] = relationship(cascade="all, delete-orphan")
    fields: Mapped[list["ProjectField"]] = relationship(
        cascade="all, delete-orphan", order_by="ProjectField.position"
    )


class Milestone(Base):
    __tablename__ = "milestones"

    id: Mapped[int] = mapped_column(primary_key=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | closed
    # planned | design | development | testing | deployment | completed (see signoff.py)
    stage: Mapped[str] = mapped_column(String(20), default="planned")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="milestones")
    issues: Mapped[list["Issue"]] = relationship(back_populates="milestone")
    features: Mapped[list["Feature"]] = relationship(back_populates="milestone")
    modules: Mapped[list["ProjectModule"]] = relationship(back_populates="milestone")


class Issue(Base):
    __tablename__ = "issues"
    __table_args__ = (UniqueConstraint("project_id", "number"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    type: Mapped[str] = mapped_column(String(20), default="task")
    status: Mapped[str] = mapped_column(String(20), default="todo", index=True)
    priority: Mapped[str] = mapped_column(String(20), default="medium")
    assignee_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    reporter_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    milestone_id: Mapped[int | None] = mapped_column(
        ForeignKey("milestones.id", ondelete="SET NULL"), nullable=True
    )
    feature_id: Mapped[int | None] = mapped_column(
        ForeignKey("features.id", ondelete="SET NULL"), nullable=True, index=True
    )
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    estimate_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    spent_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    labels: Mapped[str] = mapped_column(String(300), default="")  # comma separated
    recurrence: Mapped[str] = mapped_column(String(10), default="")  # "" | daily | weekly | monthly
    custom: Mapped[str] = mapped_column(Text, default="")  # JSON {field id: value}
    sprint_id: Mapped[int | None] = mapped_column(
        ForeignKey("sprints.id", ondelete="SET NULL"), nullable=True, index=True
    )
    sprint: Mapped["Sprint | None"] = relationship(foreign_keys=[sprint_id], viewonly=True)
    position: Mapped[float] = mapped_column(Float, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    project: Mapped[Project] = relationship(back_populates="issues")
    assignee: Mapped[User | None] = relationship(foreign_keys=[assignee_id])
    reporter: Mapped[User | None] = relationship(foreign_keys=[reporter_id])
    milestone: Mapped[Milestone | None] = relationship(back_populates="issues")
    feature: Mapped["Feature | None"] = relationship(back_populates="issues")
    checklist: Mapped[list["ChecklistItem"]] = relationship(
        cascade="all, delete-orphan", order_by="ChecklistItem.id"
    )
    time_entries: Mapped[list["TimeEntry"]] = relationship(
        back_populates="issue", cascade="all, delete-orphan"
    )
    comments: Mapped[list["Comment"]] = relationship(
        back_populates="issue", cascade="all, delete-orphan", order_by="Comment.created_at"
    )
    # Issues that must finish before this one can start (Gantt dependencies).
    blocked_by: Mapped[list["Issue"]] = relationship(
        secondary=issue_dependencies,
        primaryjoin=lambda: Issue.id == issue_dependencies.c.issue_id,
        secondaryjoin=lambda: Issue.id == issue_dependencies.c.depends_on_id,
        backref="blocking",
    )


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    issue: Mapped[Issue] = relationship(back_populates="comments")
    author: Mapped[User | None] = relationship()


class Activity(Base):
    __tablename__ = "activities"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    issue_id: Mapped[int | None] = mapped_column(
        ForeignKey("issues.id", ondelete="SET NULL"), nullable=True
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    message: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    user: Mapped[User | None] = relationship()
    issue: Mapped[Issue | None] = relationship()
    project: Mapped[Project] = relationship(overlaps="activities")


class Release(Base):
    """A deployment of the project to an environment."""

    __tablename__ = "releases"

    id: Mapped[int] = mapped_column(primary_key=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version: Mapped[str] = mapped_column(String(60))
    environment: Mapped[str] = mapped_column(String(20), default="production")
    status: Mapped[str] = mapped_column(String(20), default="planned")
    planned_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    deployed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="releases")
    features: Mapped[list["Feature"]] = relationship(back_populates="release")


class Feature(Base):
    """Something the project sets out to deliver; issues are the work items under it."""

    __tablename__ = "features"

    id: Mapped[int] = mapped_column(primary_key=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    acceptance_criteria: Mapped[str] = mapped_column(Text, default="")
    stage: Mapped[str] = mapped_column(String(20), default="planned", index=True)
    priority: Mapped[str] = mapped_column(String(20), default="medium")
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    release_id: Mapped[int | None] = mapped_column(
        ForeignKey("releases.id", ondelete="SET NULL"), nullable=True
    )
    # The milestone this feature is part of; their stages move together (see signoff.py).
    milestone_id: Mapped[int | None] = mapped_column(
        ForeignKey("milestones.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # The module this feature belongs to. A feature in a module is part of the module's milestone.
    module_id: Mapped[int | None] = mapped_column(
        ForeignKey("project_modules.id", ondelete="SET NULL"), nullable=True, index=True
    )
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    target_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="features")
    module: Mapped["ProjectModule | None"] = relationship(back_populates="features")
    owner: Mapped[User | None] = relationship(foreign_keys=[owner_id])
    release: Mapped[Release | None] = relationship(back_populates="features")
    milestone: Mapped["Milestone | None"] = relationship(back_populates="features")
    issues: Mapped[list[Issue]] = relationship(back_populates="feature")


class ProjectModule(Base):
    """A part of the product made of several features (for example "Payments"). It goes through the
    same stages as its features, with sign-off, and moves together with them (see signoff.py). A
    milestone can hold several modules as well as features of its own."""

    __tablename__ = "project_modules"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    stage: Mapped[str] = mapped_column(String(20), default="proposed")
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    milestone_id: Mapped[int | None] = mapped_column(ForeignKey("milestones.id", ondelete="SET NULL"), nullable=True, index=True)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    target_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    project: Mapped[Project] = relationship()
    owner: Mapped[User | None] = relationship()
    milestone: Mapped["Milestone | None"] = relationship(back_populates="modules")
    features: Mapped[list["Feature"]] = relationship(back_populates="module")

    deleted_at = None  # modules are deleted outright; their features stay


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    message: Mapped[str] = mapped_column(String(500))
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=True
    )
    issue_id: Mapped[int | None] = mapped_column(
        ForeignKey("issues.id", ondelete="CASCADE"), nullable=True
    )
    feature_id: Mapped[int | None] = mapped_column(
        ForeignKey("features.id", ondelete="CASCADE"), nullable=True
    )
    # A chat @mention: opens that conversation.
    conversation_id: Mapped[int | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=True
    )
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class ChecklistItem(Base):
    """A sub-task inside an issue."""

    __tablename__ = "checklist_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), index=True)
    text: Mapped[str] = mapped_column(String(300))
    done: Mapped[bool] = mapped_column(Boolean, default=False)


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text, default="")
    author_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    updated_by: Mapped[User | None] = relationship(foreign_keys=[updated_by_id])


class PhaseCheck(Base):
    """An exit criterion for one lifecycle phase of a project."""

    __tablename__ = "phase_checks"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    phase: Mapped[str] = mapped_column(String(20))
    text: Mapped[str] = mapped_column(String(300))
    done: Mapped[bool] = mapped_column(Boolean, default=False)
    done_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    done_by: Mapped[User | None] = relationship()


class Risk(Base):
    __tablename__ = "risks"

    id: Mapped[int] = mapped_column(primary_key=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    mitigation: Mapped[str] = mapped_column(Text, default="")
    probability: Mapped[str] = mapped_column(String(10), default="medium")  # low | medium | high
    impact: Mapped[str] = mapped_column(String(10), default="medium")
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | mitigating | occurred | closed
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    review_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    owner: Mapped[User | None] = relationship(foreign_keys=[owner_id])
    project: Mapped[Project] = relationship(overlaps="risks")


class ProjectTemplate(Base):
    __tablename__ = "project_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True)  # None = built-in
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(500), default="")
    data: Mapped[str] = mapped_column(Text)  # JSON
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SavedFilter(Base):
    __tablename__ = "saved_filters"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    data: Mapped[str] = mapped_column(Text)  # JSON


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    actor_name: Mapped[str] = mapped_column(String(120), default="")
    action: Mapped[str] = mapped_column(String(60), index=True)
    detail: Mapped[str] = mapped_column(String(500), default="")
    ip: Mapped[str] = mapped_column(String(60), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Conversation(Base):
    """A chat thread: a direct conversation between two users, or a project channel."""

    __tablename__ = "conversations"
    __table_args__ = (UniqueConstraint("user_a_id", "user_b_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(10))  # direct | group (project channels were retired)
    name: Mapped[str | None] = mapped_column(String(80), nullable=True)  # group chats only
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, unique=True
    )
    # For direct conversations: the two participants, lower id first.
    user_a_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    user_b_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    project: Mapped[Project | None] = relationship()
    user_a: Mapped[User | None] = relationship(foreign_keys=[user_a_id])
    user_b: Mapped[User | None] = relationship(foreign_keys=[user_b_id])


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    sender_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    body: Mapped[str] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(String(200), nullable=True)
    reply_to_id: Mapped[int | None] = mapped_column(
        ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True
    )
    # Who was @mentioned (user ids, comma separated), and whether it was @all in a group.
    mentions: Mapped[str] = mapped_column(Text, default="")
    mentions_all: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    sender: Mapped[User | None] = relationship()
    reply_to: Mapped["ChatMessage | None"] = relationship(remote_side="ChatMessage.id")
    reactions: Mapped[list["ChatReaction"]] = relationship(cascade="all, delete-orphan")


class ConversationRead(Base):
    """How far each user has read in each conversation."""

    __tablename__ = "conversation_reads"

    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    last_read_id: Mapped[int] = mapped_column(Integer, default=0)


class ChatReaction(Base):
    __tablename__ = "chat_reactions"

    message_id: Mapped[int] = mapped_column(
        ForeignKey("chat_messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    emoji: Mapped[str] = mapped_column(String(16), primary_key=True)


class StoredFile(Base):
    """An uploaded image (profile photo, project logo, pasted or shared picture)."""

    __tablename__ = "files"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # unguessable, used in the URL
    content_type: Mapped[str] = mapped_column(String(40))
    size: Mapped[int] = mapped_column(Integer)
    data: Mapped[bytes] = mapped_column(LargeBinary)
    uploader_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ProjectField(Base):
    """A custom issue field defined for one project."""

    __tablename__ = "project_fields"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    type: Mapped[str] = mapped_column(String(20))  # text | number | date | select | checkbox
    options: Mapped[str] = mapped_column(Text, default="")  # JSON list, for select fields
    position: Mapped[int] = mapped_column(Integer, default=0)


class TimeEntry(Base):
    __tablename__ = "time_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Time is logged on an issue, or straight on a feature (design, analysis, reviews …): one of the two.
    issue_id: Mapped[int | None] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), nullable=True, index=True)
    feature_id: Mapped[int | None] = mapped_column(ForeignKey("features.id", ondelete="CASCADE"), nullable=True, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    hours: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(String(300), default="")
    rate: Mapped[float | None] = mapped_column(Float, nullable=True)  # the person's hourly rate when logged
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    issue: Mapped[Issue | None] = relationship(back_populates="time_entries")
    feature: Mapped["Feature | None"] = relationship()
    user: Mapped[User | None] = relationship()


class Sprint(Base):
    __tablename__ = "sprints"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    goal: Mapped[str] = mapped_column(Text, default="")
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="planned")  # planned | active | completed
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Snapshot taken when the sprint closes: {"committed": n, "completed": n, "points": ...}
    summary: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    issues: Mapped[list["Issue"]] = relationship(foreign_keys="Issue.sprint_id", viewonly=True)


class IssueTemplate(Base):
    __tablename__ = "issue_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    title: Mapped[str] = mapped_column(String(200), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    type: Mapped[str] = mapped_column(String(20), default="task")
    priority: Mapped[str] = mapped_column(String(20), default="medium")
    labels: Mapped[str] = mapped_column(String(300), default="")
    checklist: Mapped[str] = mapped_column(Text, default="")  # JSON list of sub-task texts


class Watch(Base):
    """A user following an issue or a feature."""

    __tablename__ = "watches"
    __table_args__ = (
        UniqueConstraint("user_id", "issue_id"),
        UniqueConstraint("user_id", "feature_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    issue_id: Mapped[int | None] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), nullable=True, index=True)
    feature_id: Mapped[int | None] = mapped_column(ForeignKey("features.id", ondelete="CASCADE"), nullable=True, index=True)


class Approval(Base):
    __tablename__ = "approvals"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(12))  # feature | release | phase | general | stage
    # kind "stage": signing off one lifecycle stage of a feature or milestone, which moves it on.
    target_type: Mapped[str | None] = mapped_column(String(12), nullable=True)  # feature | milestone
    stage: Mapped[str | None] = mapped_column(String(20), nullable=True)
    to_stage: Mapped[str | None] = mapped_column(String(20), nullable=True)
    reminded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    target_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # feature or release id
    phase: Mapped[str | None] = mapped_column(String(20), nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    note: Mapped[str] = mapped_column(Text, default="")
    requester_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(12), default="pending")  # pending | approved | rejected | cancelled
    decision_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    requester: Mapped[User | None] = relationship(foreign_keys=[requester_id])
    approver: Mapped[User | None] = relationship(foreign_keys=[approver_id])
    project: Mapped[Project] = relationship()


class AutomationRule(Base):
    __tablename__ = "automation_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    trigger: Mapped[str] = mapped_column(String(30))  # issue_created | status_changed | due_soon | feature_done
    config: Mapped[str] = mapped_column(Text, default="{}")  # JSON: trigger options, conditions, action
    runs: Mapped[int] = mapped_column(Integer, default=0)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AutomationRun(Base):
    """Remembers scheduled rules already applied, so a reminder is sent once per issue."""

    __tablename__ = "automation_runs"
    __table_args__ = (UniqueConstraint("rule_id", "issue_id", "marker"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int] = mapped_column(ForeignKey("automation_rules.id", ondelete="CASCADE"), index=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"))
    marker: Mapped[str] = mapped_column(String(40))  # e.g. the due date it reminded about
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ConversationMember(Base):
    """Members of a group chat (direct chats use user_a/user_b on the conversation)."""

    __tablename__ = "conversation_members"

    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    user: Mapped[User] = relationship()


# ───────────── SaaS: workspaces, plans, licenses ─────────────


class Plan(Base):
    """A product tier customers can license. Prices are per user."""

    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(30), unique=True)
    name: Mapped[str] = mapped_column(String(60))
    description: Mapped[str] = mapped_column(String(300), default="")
    price_monthly: Mapped[float] = mapped_column(Float, default=0)  # per user per month
    price_yearly: Mapped[float] = mapped_column(Float, default=0)  # per user per year
    max_users: Mapped[int | None] = mapped_column(Integer, nullable=True)  # None = unlimited
    max_projects: Mapped[int | None] = mapped_column(Integer, nullable=True)
    features: Mapped[str] = mapped_column(Text, default="[]")  # JSON list of feature keys
    is_public: Mapped[bool] = mapped_column(Boolean, default=True)  # offered on the pricing page
    sort: Mapped[int] = mapped_column(Integer, default=0)


def new_public_id() -> str:
    import secrets

    return str(10_000_000 + secrets.randbelow(90_000_000))


def format_public_id(value: str | None) -> str:
    """4821-7390: easier to read out and type than 48217390."""
    return f"{value[:4]}-{value[4:]}" if value and len(value) == 8 else (value or "")


class Organization(Base):
    """A customer workspace. Its license decides what it can use and until when."""

    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(primary_key=True)
    # The 8-digit number people type to sign in. Random, so customers cannot be counted or guessed.
    public_id: Mapped[str | None] = mapped_column(String(8), nullable=True, unique=True, default=lambda: new_public_id())
    name: Mapped[str] = mapped_column(String(120))
    plan_id: Mapped[int | None] = mapped_column(ForeignKey("plans.id", ondelete="SET NULL"), nullable=True)
    seats: Mapped[int | None] = mapped_column(Integer, nullable=True)  # licensed users; None = unlimited
    is_trial: Mapped[bool] = mapped_column(Boolean, default=True)
    valid_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # None = never expires
    suspended: Mapped[bool] = mapped_column(Boolean, default=False)
    license_key: Mapped[str] = mapped_column(String(40), default="")
    billing_email: Mapped[str] = mapped_column(String(255), default="")
    notes: Mapped[str] = mapped_column(Text, default="")  # private to the platform owner
    logo_url: Mapped[str | None] = mapped_column(String(200), nullable=True)
    brand_color: Mapped[str | None] = mapped_column(String(9), nullable=True)
    slug: Mapped[str | None] = mapped_column(String(40), nullable=True, unique=True)  # branded sign-in address
    timezone: Mapped[str] = mapped_column(String(60), default="")
    discount_percent: Mapped[float] = mapped_column(Float, default=0)  # standing discount agreed with this customer
    onboarding_done: Mapped[bool] = mapped_column(Boolean, default=False)
    password_min_length: Mapped[int] = mapped_column(Integer, default=8)
    password_require_symbol: Mapped[bool] = mapped_column(Boolean, default=False)
    password_require_mixed_case: Mapped[bool] = mapped_column(Boolean, default=False)
    ip_allowlist: Mapped[str] = mapped_column(Text, default="")  # one address or CIDR range per line
    require_two_factor: Mapped[bool] = mapped_column(Boolean, default=False)
    # Add-ons this workspace has on top of its plan (keys, comma separated), and which of those were
    # given free of charge (kept when the workspace buys a licence without them).
    addons: Mapped[str] = mapped_column(Text, default="")
    free_addons: Mapped[str] = mapped_column(Text, default="")
    # Optional parts of the app this workspace has switched off (comma separated keys, see saas.MODULES).
    hidden_modules: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    plan: Mapped[Plan | None] = relationship()


class Addon(Base):
    """An extra a workspace can buy on top of its plan. Prices are per user, like plans."""

    __tablename__ = "addons"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(30), unique=True)
    name: Mapped[str] = mapped_column(String(60))
    description: Mapped[str] = mapped_column(String(300), default="")
    price_monthly: Mapped[float] = mapped_column(Float, default=0)  # per user per month
    price_yearly: Mapped[float] = mapped_column(Float, default=0)  # per user per year
    features: Mapped[str] = mapped_column(Text, default="[]")  # JSON list of feature keys it unlocks
    is_public: Mapped[bool] = mapped_column(Boolean, default=True)  # offered on the Billing page
    sort: Mapped[int] = mapped_column(Integer, default=0)


class LicenseRequest(Base):
    """A workspace asking for a plan. The platform owner activates it once payment arrives."""

    __tablename__ = "license_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    plan_id: Mapped[int | None] = mapped_column(ForeignKey("plans.id", ondelete="SET NULL"), nullable=True)
    plan_name: Mapped[str] = mapped_column(String(60))
    addons: Mapped[str] = mapped_column(Text, default="")  # add-on keys, comma separated
    seats: Mapped[int] = mapped_column(Integer)
    period: Mapped[str] = mapped_column(String(10))  # monthly | yearly
    amount: Mapped[float] = mapped_column(Float)
    currency: Mapped[str] = mapped_column(String(3))
    payment_reference: Mapped[str] = mapped_column(String(200), default="")
    list_amount: Mapped[float | None] = mapped_column(Float, nullable=True)  # before discounts
    coupon_code: Mapped[str] = mapped_column(String(40), default="")
    discount_note: Mapped[str] = mapped_column(String(200), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)  # pending | approved | rejected | cancelled
    decision_note: Mapped[str] = mapped_column(Text, default="")
    requested_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    requested_by_name: Mapped[str] = mapped_column(String(120), default="")
    decided_by_name: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    organization: Mapped[Organization] = relationship()
    plan: Mapped[Plan | None] = relationship()


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(30), unique=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    org_name: Mapped[str] = mapped_column(String(120))
    request_id: Mapped[int | None] = mapped_column(ForeignKey("license_requests.id", ondelete="SET NULL"), nullable=True)
    plan_name: Mapped[str] = mapped_column(String(60))
    addon_names: Mapped[str] = mapped_column(Text, default="")  # what was bought with the plan, for the invoice
    seats: Mapped[int] = mapped_column(Integer)
    period: Mapped[str] = mapped_column(String(10))
    amount: Mapped[float] = mapped_column(Float)
    currency: Mapped[str] = mapped_column(String(3))
    period_start: Mapped[datetime] = mapped_column(DateTime)
    period_end: Mapped[datetime] = mapped_column(DateTime)
    payment_reference: Mapped[str] = mapped_column(String(200), default="")
    list_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    discount_note: Mapped[str] = mapped_column(String(200), default="")
    issued_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


# ───────────── Recycle bin ─────────────
# These models are "soft deleted": deleting sets deleted_at, and every ORM query (including
# relationship loads) silently leaves them out unless it asks for include_deleted=True.

from sqlalchemy import event as _event  # noqa: E402
from sqlalchemy.orm import Session as _Session, with_loader_criteria as _with_loader_criteria  # noqa: E402

SOFT_DELETE_MODELS = (Project, Milestone, Issue, Release, Feature, Document, Risk)


@_event.listens_for(_Session, "do_orm_execute")
def _hide_deleted(execute_state):
    if (
        execute_state.is_select
        and not execute_state.is_column_load
        and not execute_state.execution_options.get("include_deleted", False)
    ):
        for model in SOFT_DELETE_MODELS:
            execute_state.statement = execute_state.statement.options(
                _with_loader_criteria(model, lambda cls: cls.deleted_at.is_(None), include_aliases=True)
            )


# ───────────── Workspace isolation ─────────────
# Once a request is authenticated, session.info["org_id"] holds the caller's workspace. From then
# on every ORM query for a project or a user — including relationship loads and Session.get —
# only ever returns rows of that workspace. Anything hanging off a project (issues, features,
# documents …) is reached through the project, so another workspace's data cannot be loaded even
# by guessing ids. Platform-owner endpoints clear the value to work across workspaces.


@_event.listens_for(_Session, "do_orm_execute")
def _isolate_workspace(execute_state):
    org_id = execute_state.session.info.get("org_id")
    if (
        org_id is not None
        and execute_state.is_select
        and not execute_state.is_column_load
        and not execute_state.execution_options.get("all_orgs", False)
    ):
        execute_state.statement = execute_state.statement.options(
            _with_loader_criteria(Project, Project.org_id == org_id, include_aliases=True),
            _with_loader_criteria(User, User.org_id == org_id, include_aliases=True),
        )


class ShareLink(Base):
    """A read-only link to a project's progress, for clients who have no account."""

    __tablename__ = "share_links"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(120), default="")
    sections: Mapped[str] = mapped_column(String(200), default="milestones,features,releases")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_feedback: Mapped[bool] = mapped_column(Boolean, default=True)
    views: Mapped[int] = mapped_column(Integer, default=0)
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    project: Mapped[Project] = relationship()
    created_by: Mapped[User | None] = relationship()


class Coupon(Base):
    __tablename__ = "coupons"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    description: Mapped[str] = mapped_column(String(200), default="")
    percent_off: Mapped[float] = mapped_column(Float, default=0)
    amount_off: Mapped[float] = mapped_column(Float, default=0)
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    used: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Announcement(Base):
    """A notice from the platform owner shown to every workspace."""

    __tablename__ = "announcements"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text, default="")
    level: Mapped[str] = mapped_column(String(10), default="info")  # info | warning
    audience: Mapped[str] = mapped_column(String(10), default="all")  # all | admins
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SupportTicket(Base):
    __tablename__ = "support_tickets"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name: Mapped[str] = mapped_column(String(120), default="")
    subject: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(10), default="open", index=True)  # open | answered | closed
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    organization: Mapped[Organization] = relationship()
    messages: Mapped[list["SupportMessage"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan", order_by="SupportMessage.id"
    )


class SupportMessage(Base):
    __tablename__ = "support_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(ForeignKey("support_tickets.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    author_name: Mapped[str] = mapped_column(String(120), default="")
    from_staff: Mapped[bool] = mapped_column(Boolean, default=False)
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    ticket: Mapped[SupportTicket] = relationship(back_populates="messages")


class SignoffCriterion(Base):
    """Something that must be true before a stage of a feature or milestone can be signed off."""

    __tablename__ = "signoff_criteria"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    target_type: Mapped[str] = mapped_column(String(12))  # feature | milestone
    stage: Mapped[str] = mapped_column(String(20))
    text: Mapped[str] = mapped_column(String(200))
    # manual: someone ticks it. all_issues_done / tests_passed: worked out automatically.
    kind: Mapped[str] = mapped_column(String(20), default="manual")
    position: Mapped[int] = mapped_column(Integer, default=0)


class SignoffCheck(Base):
    """A manual criterion ticked for one feature or milestone."""

    __tablename__ = "signoff_checks"
    __table_args__ = (UniqueConstraint("criterion_id", "target_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    criterion_id: Mapped[int] = mapped_column(ForeignKey("signoff_criteria.id", ondelete="CASCADE"), index=True)
    target_id: Mapped[int] = mapped_column(Integer, index=True)
    checked_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    checked_by_name: Mapped[str] = mapped_column(String(120), default="")
    checked_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class TestCase(Base):
    __tablename__ = "test_cases"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    feature_id: Mapped[int | None] = mapped_column(ForeignKey("features.id", ondelete="SET NULL"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    steps: Mapped[str] = mapped_column(Text, default="")
    expected: Mapped[str] = mapped_column(Text, default="")
    last_status: Mapped[str] = mapped_column(String(10), default="")  # "" (not run) | passed | failed | blocked
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_run_by: Mapped[str] = mapped_column(String(120), default="")
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    project: Mapped[Project] = relationship()
    feature: Mapped["Feature | None"] = relationship()
    results: Mapped[list["TestResult"]] = relationship(
        back_populates="case", cascade="all, delete-orphan", order_by="TestResult.id.desc()"
    )


class TestResult(Base):
    __tablename__ = "test_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    case_id: Mapped[int] = mapped_column(ForeignKey("test_cases.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(10))  # passed | failed | blocked
    note: Mapped[str] = mapped_column(Text, default="")
    tester_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    tester_name: Mapped[str] = mapped_column(String(120), default="")
    issue_id: Mapped[int | None] = mapped_column(ForeignKey("issues.id", ondelete="SET NULL"), nullable=True)  # bug raised
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    case: Mapped[TestCase] = relationship(back_populates="results")


class ShareFeedback(Base):
    """A comment or approval left by a client on a share link."""

    __tablename__ = "share_feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    link_id: Mapped[int] = mapped_column(ForeignKey("share_links.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    author_name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(10), default="comment")  # comment | approval
    target_type: Mapped[str] = mapped_column(String(12), default="project")  # project | milestone | feature
    target_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_name: Mapped[str] = mapped_column(String(200), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    reply: Mapped[str] = mapped_column(Text, default="")
    reply_by: Mapped[str] = mapped_column(String(120), default="")
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    link: Mapped[ShareLink] = relationship()


class UserSession(Base):
    """One signed-in browser or device."""

    __tablename__ = "user_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    ip: Mapped[str] = mapped_column(String(60), default="")
    user_agent: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped[User] = relationship()


class HealthCheck(Base):
    """One self-check of the service, taken every minute."""

    __tablename__ = "health_checks"

    id: Mapped[int] = mapped_column(primary_key=True)
    checked_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
    db_ms: Mapped[float] = mapped_column(Float, default=0)
    detail: Mapped[str] = mapped_column(String(200), default="")


class Incident(Base):
    __tablename__ = "incidents"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    impact: Mapped[str] = mapped_column(String(10), default="minor")  # minor | major | maintenance
    status: Mapped[str] = mapped_column(String(15), default="investigating")  # investigating | identified | monitoring | resolved
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updates: Mapped[str] = mapped_column(Text, default="[]")  # JSON [{at, status, text}]
