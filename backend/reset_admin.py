"""Emergency recovery: issue a new temporary password for an administrator (and switch off their
two-factor sign-in, in case the phone with the authenticator app is lost as well).

Usage (from the backend folder, with the virtualenv active):
    python reset_admin.py [username] [workspace ID]

The workspace ID is only needed when more than one workspace has an administrator with that username.
"""
import re
import sys

from sqlalchemy import select

from app.database import Base, SessionLocal, engine, migrate
from app.models import Organization, User, format_public_id
from app.security import generate_password, hash_password


def main() -> None:
    username = (sys.argv[1] if len(sys.argv) > 1 else "admin").lower()
    Base.metadata.create_all(engine)
    migrate()
    with SessionLocal() as db:
        query = select(User).where(User.username == username, User.role == "admin")
        if len(sys.argv) > 2:
            public_id = re.sub(r"[\s-]", "", sys.argv[2])
            query = query.join(Organization, Organization.id == User.org_id).where(Organization.public_id == public_id)
        matches = db.scalars(query).all()
        if not matches:
            sys.exit(f"No administrator named '{username}' was found.")
        if len(matches) > 1:
            lines = [f"  {format_public_id(db.get(Organization, u.org_id).public_id)}  {db.get(Organization, u.org_id).name}" for u in matches]
            sys.exit(f"'{username}' is an administrator in several workspaces. Add the workspace ID:\n" + "\n".join(lines))
        user = matches[0]
        org = db.get(Organization, user.org_id)
        password = generate_password()
        user.password_hash = hash_password(password)
        user.must_change_password = True
        user.is_active = True
        user.token_version += 1
        # This is the way back in when the authenticator phone is lost too, so two-factor is switched
        # off for this account; the person turns it on again from their profile.
        had_two_factor = user.totp_enabled_at is not None
        user.totp_secret = None
        user.totp_pending_secret = None
        user.totp_enabled_at = None
        user.totp_last_step = None
        user.recovery_codes = ""
        db.commit()
    print(f"Workspace ID: {format_public_id(org.public_id)} ({org.name})")
    print(f"Temporary password for '{username}': {password}")
    print("You will be asked to change it after signing in.")
    if had_two_factor:
        print("Two-factor sign-in was switched off for this account. Turn it on again in your profile.")


if __name__ == "__main__":
    main()
