"""Emergency recovery: issue a new temporary password for an administrator (and switch off their
two-factor sign-in, in case the phone with the authenticator app is lost as well).

Usage (from the backend folder, with the virtualenv active):
    python reset_admin.py [username]
"""
import sys

from sqlalchemy import select

from app.database import Base, SessionLocal, engine, migrate
from app.models import User
from app.security import generate_password, hash_password


def main() -> None:
    username = (sys.argv[1] if len(sys.argv) > 1 else "admin").lower()
    Base.metadata.create_all(engine)
    migrate()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == username))
        if not user or user.role != "admin":
            sys.exit(f"No administrator named '{username}' was found.")
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
    print(f"Temporary password for '{username}': {password}")
    print("You will be asked to change it after signing in.")
    if had_two_factor:
        print("Two-factor sign-in was switched off for this account. Turn it on again in your profile.")


if __name__ == "__main__":
    main()
