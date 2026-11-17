"""Emergency recovery: issue a new temporary password for an administrator.

Usage (from the backend folder, with the virtualenv active):
    python reset_admin.py [username]
"""
import sys

from sqlalchemy import select

from app.database import Base, SessionLocal, engine
from app.models import User
from app.security import generate_password, hash_password


def main() -> None:
    username = (sys.argv[1] if len(sys.argv) > 1 else "admin").lower()
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == username))
        if not user or user.role != "admin":
            sys.exit(f"No administrator named '{username}' was found.")
        password = generate_password()
        user.password_hash = hash_password(password)
        user.must_change_password = True
        user.is_active = True
        user.token_version += 1
        db.commit()
    print(f"Temporary password for '{username}': {password}")
    print("You will be asked to change it after signing in.")


if __name__ == "__main__":
    main()
