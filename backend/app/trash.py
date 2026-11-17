"""Soft delete, restore and permanent purge for the recycle bin."""
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Document, Feature, Issue, Milestone, Project, Release, Risk, User, utcnow

RETENTION_DAYS = 30

KINDS = {
    "project": Project,
    "milestone": Milestone,
    "issue": Issue,
    "release": Release,
    "feature": Feature,
    "document": Document,
    "risk": Risk,
}
KIND_OF = {model: kind for kind, model in KINDS.items()}


def soft_delete(obj, user: User) -> None:
    obj.deleted_at = utcnow()
    obj.deleted_by_id = user.id


def get_deleted(db: Session, kind: str, item_id: int):
    model = KINDS.get(kind)
    if not model:
        return None
    return db.scalar(
        select(model)
        .where(model.id == item_id, model.deleted_at.is_not(None))
        .execution_options(include_deleted=True)
    )


def deleted_rows(db: Session, model, condition=None):
    stmt = select(model).where(model.deleted_at.is_not(None))
    if condition is not None:
        stmt = stmt.where(condition)
    return db.scalars(stmt.order_by(model.deleted_at.desc()).execution_options(include_deleted=True)).all()


def purge_expired(db: Session) -> int:
    """Permanently remove items that have been in the recycle bin longer than the retention period."""
    cutoff = utcnow() - timedelta(days=RETENTION_DAYS)
    removed = 0
    # Children before parents so cascades never meet a half-deleted parent.
    for model in (Issue, Feature, Release, Milestone, Document, Risk, Project):
        for obj in deleted_rows(db, model, model.deleted_at < cutoff):
            db.delete(obj)
            removed += 1
    if removed:
        db.commit()
    return removed
