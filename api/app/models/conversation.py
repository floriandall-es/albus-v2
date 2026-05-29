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
        # Migration 0088 widened to include 'group'.
        CheckConstraint(
            "kind IN ('dm', 'group')",
            name="ck_conversations_kind",
        ),
        # Groups must carry a title; DMs must not. Matches the SQL
        # constraint installed by migration 0088.
        CheckConstraint(
            "(kind = 'dm' AND title IS NULL) "
            "OR (kind = 'group' AND title IS NOT NULL AND length(title) > 0)",
            name="ck_conversations_title_per_kind",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Scope boundary: conversation belongs to one hospital. Every
    # member must have at least one active membership at this
    # hospital — enforced at the route layer.
    hospital_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("hospitals.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 'dm' = 1:1; 'group' = N members with a title. The route
    # serializer branches on this for display (peer vs title +
    # member previews).
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # Group title. NULL for DMs (enforced by ck_conversations_title_per_kind).
    # Migration 0088.
    title: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Person who created the group. Used by the route layer to gate
    # "only the creator can remove someone else" — every other
    # operation is flat. NULL on DMs (no creator concept) and on
    # legacy groups whose creator was later deleted (ON DELETE SET
    # NULL). When NULL, "kick someone else" is permanently disabled
    # for that group; members can still self-leave or add others.
    # Migration 0088.
    created_by_person_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
    )
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
    # Sprint 28 / Phase 2B / migration 0056: stamped by the
    # mark-read endpoint. Used to detect "actively watching this
    # conversation right now" — if last_read_at is within ~5min,
    # we skip the email since they just looked.
    last_read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Sprint 28 / Phase 2B / migration 0056: last time we
    # emailed THIS member about THIS conversation. Drives the
    # 2-day cooldown so we don't spam someone who already got an
    # "unread messages" nudge.
    last_email_sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Sprint 28 / Phase 2C / migration 0067: per-user "delete
    # conversation". When the caller hits DELETE on a conversation
    # we stamp this for *their* membership only — the other
    # person's view is untouched. The list query filters out
    # conversations where last_message_at <= hidden_at, so a new
    # incoming message (which bumps last_message_at) brings the
    # conversation back. Matches WhatsApp / Slack semantics.
    hidden_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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
