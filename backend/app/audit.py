from fastapi import Request
from sqlalchemy.orm import Session

from .models import AuditLog, User


def audit(
    db: Session,
    actor: User | None,
    action: str,
    detail: str = "",
    request: Request | None = None,
    actor_name: str = "",
) -> None:
    """Record a security-relevant event. The caller commits."""
    ip = request.client.host if request and request.client else ""
    db.add(
        AuditLog(
            org_id=actor.org_id if actor else None,
            actor_id=actor.id if actor else None,
            actor_name=(actor.username if actor else actor_name)[:120],
            action=action,
            detail=detail[:500],
            ip=ip,
        )
    )
