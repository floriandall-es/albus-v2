"""Sprint 28 / migration 0055: 1:1 hospital-scoped DMs.

Three tables — see the migration docstring for the design
notes. Models stay minimal: no SQLAlchemy relationships on the
hot path, since the route layer always joins explicitly to
control N+1 behaviour for the conversation-list query.
"""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        CheckConstraint("kind IN ('dm')", name="ck_conversations_kind"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Scope boundary: conversation belongs to one hospital. Both
    # members must have at least one active membership at this
    # hospital — enforced at route level.
    hospital_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("hospitals.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Today only 'dm'. Channels would add 'channel' here and a
    # new set of routes that pivot on this discriminator. Phase 2A
    # ships only DMs.
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Denormalized "last activity" so the conversation list sort
    # is O(N) instead of needing a per-row subquery. Updated by
    # the send-message route.
    last_message_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ConversationMember(Base):
    __tablename__ = "conversation_members"
    __table_args__ = (
        UniqueConstraint(
            "conversation_id",
            "person_id",
            name="uq_conversation_members_pair",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
    )
    person_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # High-water mark for unread counts. NULL = never opened.
    # The unread count is (messages.id > last_read_message_id
    # AND author_person_id != person_id).
    last_read_message_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Author can become NULL if the Person row is later deleted —
    # the message row survives so last_read tracking stays stable.
    # UI renders "(eliminado)" for null authors.
    author_person_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # Soft-delete only. Row stays for stable id sequence; UI
    # renders "mensaje borrado" instead of the body.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
