"""Chat: one-to-one and group conversations with replies, reactions, images and read receipts."""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import ChatMessage, ChatReaction, Conversation, ConversationMember, ConversationRead, User, utcnow
from ..realtime import hub
from ..security import get_current_user
from ..serializers import dt, user_brief

router = APIRouter(prefix="/api/chat", tags=["chat"])

REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "✅"]


class DirectIn(BaseModel):
    user_id: int


class MessageIn(BaseModel):
    body: str = Field(default="", max_length=4000)
    image_url: str | None = Field(default=None, max_length=200)
    reply_to_id: int | None = None


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    member_ids: list[int] = Field(min_length=1, max_length=100)


class GroupRename(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class MembersIn(BaseModel):
    user_ids: list[int] = Field(min_length=1, max_length=100)


class ReactionIn(BaseModel):
    emoji: str = Field(max_length=16)


def _snippet(message: ChatMessage | None) -> dict | None:
    if not message:
        return None
    return {
        "id": message.id,
        "sender_name": message.sender.full_name if message.sender else "Deleted user",
        "body": message.body[:140] or ("Photo" if message.image_url else ""),
    }


def message_out(m: ChatMessage, viewer_id: int) -> dict:
    grouped: dict[str, list[int]] = {}
    for reaction in m.reactions:
        grouped.setdefault(reaction.emoji, []).append(reaction.user_id)
    return {
        "id": m.id,
        "conversation_id": m.conversation_id,
        "sender": user_brief(m.sender),
        "body": m.body,
        "image_url": m.image_url,
        "reply_to": _snippet(m.reply_to) if m.reply_to_id else None,
        "reactions": [
            {"emoji": emoji, "count": len(users), "mine": viewer_id in users}
            for emoji, users in sorted(
                grouped.items(),
                key=lambda item: REACTIONS.index(item[0]) if item[0] in REACTIONS else 99,
            )
        ],
        "created_at": dt(m.created_at),
    }


def _group_member_ids(db: Session, conversation_id: int) -> list[int]:
    return list(db.scalars(select(ConversationMember.user_id).where(ConversationMember.conversation_id == conversation_id)))


def _participants(conv: Conversation, db: Session | None = None) -> list[int]:
    if conv.kind == "group":
        from sqlalchemy.orm import object_session

        return _group_member_ids(db or object_session(conv), conv.id)
    return [u for u in (conv.user_a_id, conv.user_b_id) if u is not None]


def _other_id(conv: Conversation, user: User) -> int | None:
    return conv.user_b_id if conv.user_a_id == user.id else conv.user_a_id


def _others(conv: Conversation, user: User, db: Session) -> list[int]:
    return [u for u in _participants(conv, db) if u != user.id]


def _get_conversation(db: Session, conversation_id: int, user: User) -> Conversation:
    conv = db.get(Conversation, conversation_id)
    # Chat is personal: only the people in a conversation can reach it.
    if conv and conv.kind == "direct" and user.id in (conv.user_a_id, conv.user_b_id):
        return conv
    if conv and conv.kind == "group" and db.get(ConversationMember, (conv.id, user.id)):
        return conv
    raise HTTPException(404, "Conversation not found")


def _my_conversations(db: Session, user: User) -> list[Conversation]:
    groups = select(ConversationMember.conversation_id).where(ConversationMember.user_id == user.id)
    return list(
        db.scalars(
            select(Conversation).where(
                or_(
                    (Conversation.kind == "direct")
                    & or_(Conversation.user_a_id == user.id, Conversation.user_b_id == user.id),
                    (Conversation.kind == "group") & Conversation.id.in_(groups),
                )
            )
        ).all()
    )


def _read_marker(db: Session, conversation_id: int, user_id: int) -> ConversationRead:
    marker = db.get(ConversationRead, (conversation_id, user_id))
    if not marker:
        try:
            with db.begin_nested():
                marker = ConversationRead(conversation_id=conversation_id, user_id=user_id, last_read_id=0)
                db.add(marker)
        except IntegrityError:  # created by a simultaneous request
            marker = db.get(ConversationRead, (conversation_id, user_id))
    return marker


def _last_read(db: Session, conversation_id: int, user_id: int | None) -> int:
    if user_id is None:
        return 0
    marker = db.get(ConversationRead, (conversation_id, user_id))
    return marker.last_read_id if marker else 0


def _unread(db: Session, user: User, conversation_id: int) -> int:
    return db.scalar(
        select(func.count())
        .select_from(ChatMessage)
        .where(
            ChatMessage.conversation_id == conversation_id,
            ChatMessage.id > _last_read(db, conversation_id, user.id),
            or_(ChatMessage.sender_id != user.id, ChatMessage.sender_id.is_(None)),
        )
    )


def conversation_out(db: Session, conv: Conversation, user: User) -> dict:
    last = db.scalar(
        select(ChatMessage)
        .where(ChatMessage.conversation_id == conv.id)
        .order_by(ChatMessage.id.desc())
        .limit(1)
    )
    if conv.kind == "group":
        members = db.scalars(
            select(User).join(ConversationMember, ConversationMember.user_id == User.id)
            .where(ConversationMember.conversation_id == conv.id).order_by(User.full_name)
        ).all()
        identity = {
            "kind": "group",
            "title": conv.name or "Group",
            "members": [user_brief(m) for m in members],
            "created_by_id": conv.created_by_id,
            "active": True,
            "user": None,
            "other_last_read_id": 0,
        }
    else:
        other = conv.user_b if conv.user_a_id == user.id else conv.user_a
        identity = {
            "kind": "direct",
            "title": other.full_name if other else "Deleted user",
            "user": user_brief(other),
            "active": bool(other and other.is_active),
            "other_last_read_id": _last_read(db, conv.id, other.id if other else None),
        }
    return {
        "id": conv.id,
        **identity,
        "unread": _unread(db, user, conv.id),
        "last_message": (
            {
                "body": last.body[:120] or ("📷 Photo" if last.image_url else ""),
                "sender_name": "You"
                if last.sender_id == user.id
                else (last.sender.full_name.split(" ")[0] if last.sender else "Someone"),
                "created_at": dt(last.created_at),
            }
            if last
            else None
        ),
        "sort_at": dt(conv.last_message_at or conv.created_at),
    }


@router.get("/conversations")
def list_conversations(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = [conversation_out(db, c, user) for c in _my_conversations(db, user)]
    with_messages = sorted([r for r in rows if r["last_message"]], key=lambda r: r["sort_at"], reverse=True)
    empty = sorted([r for r in rows if not r["last_message"]], key=lambda r: r["title"].lower())
    return with_messages + empty


@router.get("/unread")
def unread_total(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"count": sum(_unread(db, user, c.id) for c in _my_conversations(db, user))}


@router.get("/online")
def online_users(user: User = Depends(get_current_user)):
    return {"online": hub.online(user.org_id)}


@router.post("/direct")
def open_direct(data: DirectIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Find or start the direct conversation with another user."""
    other = db.get(User, data.user_id)
    if not other or not other.is_active:
        raise HTTPException(404, "User not found")
    if other.id == user.id:
        raise HTTPException(400, "You cannot start a conversation with yourself")
    a, b = sorted((user.id, other.id))
    conv = db.scalar(
        select(Conversation).where(Conversation.user_a_id == a, Conversation.user_b_id == b)
    )
    if not conv:
        try:
            conv = Conversation(kind="direct", user_a_id=a, user_b_id=b)
            db.add(conv)
            db.commit()
        except IntegrityError:  # the other person opened it at the same moment
            db.rollback()
            conv = db.scalar(
                select(Conversation).where(Conversation.user_a_id == a, Conversation.user_b_id == b)
            )
    return conversation_out(db, conv, user)


@router.get("/conversations/{conversation_id}/messages")
def list_messages(
    conversation_id: int,
    after: int | None = Query(default=None, ge=0),
    before: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Newest page by default; `after` returns only newer messages, `before` older ones."""
    conv = _get_conversation(db, conversation_id, user)
    stmt = select(ChatMessage).where(ChatMessage.conversation_id == conv.id)
    if after is not None:
        rows = db.scalars(stmt.where(ChatMessage.id > after).order_by(ChatMessage.id).limit(limit)).all()
        has_more = False
    else:
        if before is not None:
            stmt = stmt.where(ChatMessage.id < before)
        rows = db.scalars(stmt.order_by(ChatMessage.id.desc()).limit(limit + 1)).all()
        has_more = len(rows) > limit
        rows = list(reversed(rows[:limit]))
    if rows and before is None:
        marker = _read_marker(db, conv.id, user.id)
        if rows[-1].id > marker.last_read_id:
            marker.last_read_id = rows[-1].id
            db.commit()
            # Read receipt for everyone else in the conversation.
            hub.push(
                _others(conv, user, db),
                {"type": "chat.read", "conversation_id": conv.id, "last_read_id": marker.last_read_id, "user_id": user.id},
            )
    return {
        "messages": [message_out(m, user.id) for m in rows],
        "has_more": has_more,
        "other_last_read_id": _last_read(db, conv.id, _other_id(conv, user)) if conv.kind == "direct" else 0,
        # Group chats: how far each other member has read, for "Seen by" receipts.
        "reads": {
            str(uid): _last_read(db, conv.id, uid) for uid in _others(conv, user, db)
        } if conv.kind == "group" else {},
    }


@router.post("/conversations/{conversation_id}/messages", status_code=201)
def send_message(
    conversation_id: int,
    data: MessageIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv = _get_conversation(db, conversation_id, user)
    body = data.body.strip()
    if data.image_url is not None and not data.image_url.startswith("/api/files/"):
        raise HTTPException(422, "Upload the image first")
    if not body and not data.image_url:
        raise HTTPException(422, "Message is empty")
    if conv.kind == "direct":
        other = conv.user_b if conv.user_a_id == user.id else conv.user_a
        if not other or not other.is_active:
            raise HTTPException(400, "This person can no longer receive messages")
    reply_to_id = None
    if data.reply_to_id is not None:
        target = db.get(ChatMessage, data.reply_to_id)
        if not target or target.conversation_id != conv.id:
            raise HTTPException(422, "You can only reply to a message in this conversation")
        reply_to_id = target.id
    message = ChatMessage(
        conversation_id=conv.id,
        sender_id=user.id,
        body=body,
        image_url=data.image_url,
        reply_to_id=reply_to_id,
    )
    db.add(message)
    conv.last_message_at = utcnow()
    db.flush()
    _read_marker(db, conv.id, user.id).last_read_id = message.id
    db.commit()
    db.refresh(message)
    # Deliver instantly to everyone's open tabs (the sender may have several).
    for participant in _participants(conv, db):
        hub.push([participant], {"type": "chat.message", "message": message_out(message, participant)})
    return message_out(message, user.id)


def _get_message(db: Session, message_id: int, user: User) -> tuple[ChatMessage, Conversation]:
    message = db.get(ChatMessage, message_id)
    if not message:
        raise HTTPException(404, "Message not found")
    return message, _get_conversation(db, message.conversation_id, user)


@router.post("/messages/{message_id}/reactions")
def toggle_reaction(
    message_id: int,
    data: ReactionIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add the reaction, or remove it if this user already gave it."""
    if data.emoji not in REACTIONS:
        raise HTTPException(422, "That reaction is not available")
    message, conv = _get_message(db, message_id, user)
    existing = db.get(ChatReaction, (message.id, user.id, data.emoji))
    if existing:
        db.delete(existing)
    else:
        db.add(ChatReaction(message_id=message.id, user_id=user.id, emoji=data.emoji))
    db.commit()
    db.refresh(message)
    for participant in _participants(conv, db):
        hub.push([participant], {"type": "chat.updated", "message": message_out(message, participant)})
    return message_out(message, user.id)


@router.delete("/messages/{message_id}", status_code=204)
def delete_message(
    message_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    message, conv = _get_message(db, message_id, user)
    if message.sender_id != user.id:
        raise HTTPException(404, "Message not found")
    payload = {"type": "chat.deleted", "conversation_id": conv.id, "message_id": message.id}
    db.delete(message)
    db.commit()
    hub.push(_participants(conv, db), payload)



# ───────────── Group chats ─────────────


def _active_users(db: Session, ids: list[int]) -> list[User]:
    users = db.scalars(select(User).where(User.id.in_(ids or [0]), User.is_active)).all()
    if len(users) != len(set(ids)):
        raise HTTPException(422, "Every member must be an active user")
    return list(users)


def _system_message(db: Session, conv: Conversation, user: User, text: str) -> None:
    message = ChatMessage(conversation_id=conv.id, sender_id=None, body=f"{user.full_name} {text}")
    db.add(message)
    conv.last_message_at = utcnow()
    db.flush()
    # The person who did it has, by definition, seen it.
    _read_marker(db, conv.id, user.id).last_read_id = message.id


def _get_group(db: Session, conversation_id: int, user: User) -> Conversation:
    conv = _get_conversation(db, conversation_id, user)
    if conv.kind != "group":
        raise HTTPException(400, "This is not a group conversation")
    return conv


def _broadcast_group(db: Session, conv: Conversation, extra_users=()):
    for uid in set(_participants(conv, db)) | set(extra_users):
        hub.push([uid], {"type": "chat.group", "conversation_id": conv.id})


@router.post("/groups", status_code=201)
def create_group(data: GroupIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from ..saas import require_feature

    require_feature(db, user, "group_chat")
    members = _active_users(db, [i for i in data.member_ids if i != user.id])
    if not members:
        raise HTTPException(422, "Add at least one other person")
    conv = Conversation(kind="group", name=data.name.strip(), created_by_id=user.id)
    db.add(conv)
    db.flush()
    for uid in {user.id, *(m.id for m in members)}:
        db.add(ConversationMember(conversation_id=conv.id, user_id=uid))
    _system_message(db, conv, user, f"created the group “{conv.name}”")
    db.commit()
    _broadcast_group(db, conv)
    return conversation_out(db, conv, user)


@router.patch("/groups/{conversation_id}")
def rename_group(conversation_id: int, data: GroupRename, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conv = _get_group(db, conversation_id, user)
    conv.name = data.name.strip()
    _system_message(db, conv, user, f"renamed the group to “{conv.name}”")
    db.commit()
    _broadcast_group(db, conv)
    return conversation_out(db, conv, user)


@router.post("/groups/{conversation_id}/members")
def add_group_members(conversation_id: int, data: MembersIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conv = _get_group(db, conversation_id, user)
    current = set(_group_member_ids(db, conv.id))
    added = [u for u in _active_users(db, data.user_ids) if u.id not in current]
    for member in added:
        db.add(ConversationMember(conversation_id=conv.id, user_id=member.id))
    if added:
        _system_message(db, conv, user, "added " + ", ".join(m.full_name for m in added))
    db.commit()
    _broadcast_group(db, conv)
    return conversation_out(db, conv, user)


@router.delete("/groups/{conversation_id}/members/{user_id}")
def remove_group_member(conversation_id: int, user_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Leave the group (your own id), or — for the group's creator — remove someone."""
    conv = _get_group(db, conversation_id, user)
    if user_id != user.id and conv.created_by_id != user.id and user.role != "admin":
        raise HTTPException(403, "Only the person who created the group can remove members")
    membership = db.get(ConversationMember, (conv.id, user_id))
    if not membership:
        raise HTTPException(404, "That person is not in this group")
    removed = db.get(User, user_id)
    db.delete(membership)
    _system_message(db, conv, user, "left the group" if user_id == user.id else f"removed {removed.full_name if removed else 'a member'}")
    db.commit()
    _broadcast_group(db, conv, extra_users=[user_id])
    if user_id == user.id:
        return {"left": True}
    return conversation_out(db, conv, user)
