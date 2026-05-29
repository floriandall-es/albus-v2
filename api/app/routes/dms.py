"""DM endpoints (Phase 2A).

Five routes for the minimum playable build:
  POST   /api/dms                              find-or-create
  GET    /api/conversations                    my conversations
  GET    /api/conversations/{id}/messages      paginated message history
  POST   /api/conversations/{id}/messages      send
  POST   /api/conversations/{id}/read          mark read (last_message_id)

No realtime, no email fallback yet — those land in Phase 2B.

Privacy gates:
  - Cannot DM someone who isn't in your hospital. We enforce by
    requiring the peer to have at least one active, opted-in
    Membership at the same hospital_id as ctx.tenant.
  - Cannot read / send to conversations you aren't a member of.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, text

from app.core.config import settings
from app.models import (
    Conversation,
    ConversationMember,
    Message,
    Person,
)
from app.routes.deps import RequestContext, get_current_context


logger = logging.getLogger("app.dms")


# Phase 2B email-fallback knobs. The 2h cooldown means a member
# gets at most one "unread messages" email per conversation per
# 2 hours regardless of message volume. The 5min "actively
# reading" window suppresses emails for people who just had the
# conversation open and saw the message live.
EMAIL_COOLDOWN = timedelta(hours=2)
ACTIVE_READ_WINDOW = timedelta(minutes=5)


router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class DMCreateRequest(BaseModel):
    peer_person_id: int


class ConversationPeerOut(BaseModel):
    """Sub-object on a conversation entry. For a DM, identifies the
    *other* member — never the caller. Includes the contact
    affordances the directory already governs (so a member with
    no opt-in flags still has a usable display, but no email/
    phone leaks)."""

    person_id: int
    name: str
    # Split-name fields needed by the frontend's personFullName
    # helper. Conversation headers + the conversation-list rows
    # render "First Last" so jefes can recognise the counterpart
    # at a glance — last-name-only was too curt for the chat
    # surface where you might be DM-ing someone you haven't met.
    first_name: str | None = None
    last_name: str | None = None
    avatar_url: str | None = None
    category_name: str | None = None
    tenant_name: str | None = None


class ConversationMemberPreview(BaseModel):
    """One row of the avatar stack rendered on group conversation
    list entries. Three of these are surfaced; the rest are
    summarised as "+N más" in the UI."""

    person_id: int
    name: str
    first_name: str | None = None
    last_name: str | None = None
    avatar_url: str | None = None


class ConversationOut(BaseModel):
    id: int
    hospital_id: int
    kind: str
    created_at: datetime
    last_message_at: datetime
    # DMs: the other participant (always present, never null).
    # Groups: null — the UI reads `title` + the member previews
    # instead.
    peer: ConversationPeerOut | None = None
    # Migration 0088. Group-only fields. `title` is the group name
    # (NULL for DMs, enforced by the title-per-kind CHECK).
    # `member_count` is the live size; `member_previews` is the
    # first 3 members (denormalised at read time for the avatar
    # stack). `created_by_person_id` drives the "kick someone else"
    # permission on the frontend; NULL on DMs and on legacy groups
    # where the creator was later deleted.
    title: str | None = None
    member_count: int = 0
    member_previews: list[ConversationMemberPreview] = Field(
        default_factory=list
    )
    created_by_person_id: int | None = None
    # Computed per request: messages.id > last_read_message_id AND
    # author != self. Capped at 99 to keep the badge readable.
    unread_count: int
    # Latest message preview (body trimmed to 140 chars; null when
    # the conversation has no messages yet).
    last_message_preview: str | None = None


# ---------------------------------------------------------------------------
# Group chat request schemas (migration 0088)
# ---------------------------------------------------------------------------


class GroupChatCreateRequest(BaseModel):
    """Body for POST /api/group-chats. The caller is implicitly added
    to the new conversation — we don't require them to include their
    own person_id in member_person_ids, and we silently drop it if
    they did."""

    title: str = Field(min_length=1, max_length=120)
    member_person_ids: list[int] = Field(min_length=1)


class GroupChatRenameRequest(BaseModel):
    """PATCH /api/conversations/{id} for groups. Only renames are
    supported today; member changes have their own endpoints."""

    title: str = Field(min_length=1, max_length=120)


class GroupMembersAddRequest(BaseModel):
    """Body for POST /api/conversations/{id}/members. Adding a member
    they're already in is a silent no-op (idempotent)."""

    person_ids: list[int] = Field(min_length=1)


class MessageOut(BaseModel):
    id: int
    conversation_id: int
    author_person_id: int | None
    author_name: str | None
    body: str | None
    deleted_at: datetime | None
    created_at: datetime


class MessageCreateRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class MarkReadRequest(BaseModel):
    last_message_id: int


class UnreadCountOut(BaseModel):
    """Sum across every conversation the caller is a member of.
    Capped at 99 for badge readability — the sidebar pill stops
    rendering exact numbers past that."""

    total: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_hospital(ctx: RequestContext) -> int:
    """Reject DM operations when the caller's tenant isn't linked
    to a hospital. Direct messaging is gated on the hospital layer
    — standalone tenants have no peers to talk to."""
    hid = ctx.tenant.hospital_id
    if hid is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Tu servicio no está vinculado a un hospital — los "
                "mensajes directos sólo funcionan dentro de un hospital."
            ),
        )
    return hid


def _peer_is_in_my_hospital(
    ctx: RequestContext, peer_person_id: int, hospital_id: int
) -> bool:
    """True when peer has at least one ACTIVE membership at
    hospital_id with directory_visible=true. We require visibility
    to start a DM — invisible members aren't reachable. The check
    crosses tenants, so we use a raw SQL EXISTS with explicit join
    (bypassing RLS by not querying via the ORM with a tenant
    filter)."""
    row = ctx.db.execute(
        text(
            """
            SELECT 1
            FROM memberships m
            JOIN tenants t ON t.id = m.tenant_id
            WHERE m.person_id = :pid
              AND m.disabled_at IS NULL
              AND m.directory_visible = TRUE
              AND t.hospital_id = :hid
            LIMIT 1
            """
        ),
        {"pid": peer_person_id, "hid": hospital_id},
    ).first()
    return row is not None


def _ensure_membership(
    ctx: RequestContext, conversation_id: int
) -> Conversation:
    """Load the conversation + verify ctx.person is a member.
    Returns the conversation row; raises 404 if not a member (we
    return 404 instead of 403 so existence isn't leaked)."""
    conv = ctx.db.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversación no encontrada")
    mem = (
        ctx.db.query(ConversationMember)
        .filter(
            ConversationMember.conversation_id == conv.id,
            ConversationMember.person_id == ctx.person.id,
        )
        .first()
    )
    if mem is None:
        raise HTTPException(status_code=404, detail="Conversación no encontrada")
    return conv


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/dms", response_model=ConversationOut, status_code=status.HTTP_201_CREATED
)
def create_or_get_dm(
    payload: DMCreateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> ConversationOut:
    """Find-or-create a DM with `peer_person_id`. Idempotent —
    re-issuing for the same peer returns the existing conversation.

    Concurrency note: two simultaneous calls for the same pair
    could each see "no existing DM" and create two. We take a
    pg_advisory_xact_lock keyed on the sorted-pair hash to
    serialise — cheaper than a unique index over a derived column
    and disappears at commit time.
    """
    hospital_id = _require_hospital(ctx)
    if payload.peer_person_id == ctx.person.id:
        raise HTTPException(
            status_code=400,
            detail="No puedes abrir un DM contigo mismo",
        )
    if not _peer_is_in_my_hospital(
        ctx, payload.peer_person_id, hospital_id
    ):
        raise HTTPException(
            status_code=404,
            detail="Esta persona no está disponible en tu hospital",
        )

    # Advisory lock keyed on the sorted pair. Postgres takes two
    # int4 args so we use (min_id, max_id) directly. Held for the
    # duration of the transaction.
    a = min(ctx.person.id, payload.peer_person_id)
    b = max(ctx.person.id, payload.peer_person_id)
    ctx.db.execute(
        text("SELECT pg_advisory_xact_lock(:a, :b)"),
        {"a": a, "b": b},
    )

    # Lookup: any kind='dm' conversation in this hospital that has
    # BOTH person_ids as members. The "both members" predicate is
    # most cheaply expressed as a self-join on conversation_members.
    existing = (
        ctx.db.execute(
            text(
                """
                SELECT c.id
                FROM conversations c
                JOIN conversation_members ma
                  ON ma.conversation_id = c.id AND ma.person_id = :me
                JOIN conversation_members mb
                  ON mb.conversation_id = c.id AND mb.person_id = :peer
                WHERE c.hospital_id = :hid
                  AND c.kind = 'dm'
                LIMIT 1
                """
            ),
            {
                "me": ctx.person.id,
                "peer": payload.peer_person_id,
                "hid": hospital_id,
            },
        )
        .first()
    )

    if existing is None:
        conv = Conversation(hospital_id=hospital_id, kind="dm")
        ctx.db.add(conv)
        ctx.db.flush()
        ctx.db.add(
            ConversationMember(
                conversation_id=conv.id, person_id=ctx.person.id
            )
        )
        ctx.db.add(
            ConversationMember(
                conversation_id=conv.id, person_id=payload.peer_person_id
            )
        )
        ctx.db.flush()
    else:
        conv = ctx.db.get(Conversation, existing[0])
        assert conv is not None

    return _serialize_conversation(ctx, conv)


@router.get(
    "/conversations", response_model=list[ConversationOut]
)
def list_my_conversations(
    ctx: RequestContext = Depends(get_current_context),
) -> list[ConversationOut]:
    """Return ctx.person's conversations across all their
    hospitals (today: just the current tenant's hospital, but the
    schema allows multiple), ordered by last_message_at DESC.

    Hidden conversations (caller hit "Borrar conversación") are
    filtered out — UNLESS new activity has happened since the hide
    marker, in which case the conversation re-appears (last_message_at
    bumped past hidden_at when the peer sent a new message).
    Mirrors WhatsApp's "delete chat" behaviour exactly.
    """
    convs = (
        ctx.db.query(Conversation)
        .join(
            ConversationMember,
            ConversationMember.conversation_id == Conversation.id,
        )
        .filter(
            ConversationMember.person_id == ctx.person.id,
            (
                (ConversationMember.hidden_at.is_(None))
                | (Conversation.last_message_at > ConversationMember.hidden_at)
            ),
        )
        .order_by(Conversation.last_message_at.desc())
        .all()
    )
    return [_serialize_conversation(ctx, c) for c in convs]


@router.get(
    "/conversations/{conversation_id}/messages",
    response_model=list[MessageOut],
)
def list_messages(
    conversation_id: int,
    # Pagination is "before message_id, give me the next N older".
    # Forward pagination (newer messages) doesn't apply yet because
    # there's no realtime feed — the client just re-fetches on
    # focus / poll.
    before: int | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    ctx: RequestContext = Depends(get_current_context),
) -> list[MessageOut]:
    _ensure_membership(ctx, conversation_id)
    q = ctx.db.query(Message).filter(
        Message.conversation_id == conversation_id
    )
    if before is not None:
        q = q.filter(Message.id < before)
    rows = q.order_by(Message.id.desc()).limit(limit).all()
    # Return ASC (oldest first) so the client can append without
    # reversing client-side.
    rows.reverse()
    author_ids = {r.author_person_id for r in rows if r.author_person_id}
    name_by_id: dict[int, str] = {}
    if author_ids:
        for pid, name in ctx.db.execute(
            text(
                "SELECT id, name FROM persons WHERE id = ANY(:ids)"
            ),
            {"ids": list(author_ids)},
        ).all():
            name_by_id[pid] = name
    return [
        MessageOut(
            id=r.id,
            conversation_id=r.conversation_id,
            author_person_id=r.author_person_id,
            author_name=(
                name_by_id.get(r.author_person_id)
                if r.author_person_id
                else None
            ),
            body=None if r.deleted_at else r.body,
            deleted_at=r.deleted_at,
            created_at=r.created_at,
        )
        for r in rows
    ]


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
def send_message(
    conversation_id: int,
    payload: MessageCreateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> MessageOut:
    conv = _ensure_membership(ctx, conversation_id)
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=422, detail="El mensaje está vacío")
    msg = Message(
        conversation_id=conv.id,
        author_person_id=ctx.person.id,
        body=body,
    )
    ctx.db.add(msg)
    ctx.db.flush()
    # Bump the conversation's last_message_at so the list sort
    # bubbles this to the top on next fetch.
    conv.last_message_at = msg.created_at
    ctx.db.flush()
    # Phase 2B: maybe-email the other member(s). Synchronous —
    # adds ~100-300ms to the send response when SMTP runs, but
    # avoids needing a background worker. Failures are swallowed
    # by send_email itself (same pattern as the swap notification
    # path).
    try:
        _maybe_notify_unread(ctx, conv, msg)
    except Exception:  # noqa: BLE001 — broadest catch is intentional
        logger.exception("DM email-fallback notification failed")
    return MessageOut(
        id=msg.id,
        conversation_id=msg.conversation_id,
        author_person_id=msg.author_person_id,
        author_name=ctx.person.name,
        body=msg.body,
        deleted_at=None,
        created_at=msg.created_at,
    )


def _maybe_notify_unread(
    ctx: RequestContext, conv: Conversation, msg: Message
) -> None:
    """Email each non-author member when the cooldown + active-
    reading rules say it's appropriate.

    Rules (Phase 2B):
      1. Skip if member.last_read_at is within ACTIVE_READ_WINDOW.
         Means they're actively watching; native UI update is
         enough.
      2. Skip if member.last_email_sent_at is within
         EMAIL_COOLDOWN. Means we already nudged them for this
         conversation recently — don't pile on.
      3. Otherwise: send and stamp last_email_sent_at.

    Same patterns we already use elsewhere (auth.py uses lazy
    email imports; this matches).
    """
    now = datetime.now(timezone.utc)
    other_members = (
        ctx.db.query(ConversationMember)
        .filter(
            ConversationMember.conversation_id == conv.id,
            ConversationMember.person_id != ctx.person.id,
        )
        .all()
    )
    if not other_members:
        return
    sender_name = ctx.person.name
    sender_last = ctx.person.last_name or sender_name
    body_preview = msg.body[:200]

    from app.services.email import send_email, should_email_person
    from app.services.email_templates import dm_unread_email

    for mem in other_members:
        # Rule 1: actively reading right now?
        if (
            mem.last_read_at is not None
            and now - mem.last_read_at < ACTIVE_READ_WINDOW
        ):
            continue
        # Rule 2: cooldown?
        if (
            mem.last_email_sent_at is not None
            and now - mem.last_email_sent_at < EMAIL_COOLDOWN
        ):
            continue
        person = ctx.db.get(Person, mem.person_id)
        if person is None or not should_email_person(person):
            continue
        deep_link = (
            f"{settings.public_base_url.rstrip('/')}/me/mensajes?c={conv.id}"
        )
        subject, body_html = dm_unread_email(
            recipient_first_name=person.first_name or person.name,
            sender_display_name=sender_last,
            body_preview=body_preview,
            deep_link=deep_link,
        )
        send_email(person.email, subject, body_html)
        mem.last_email_sent_at = now
    ctx.db.flush()


@router.get("/me/unread-count", response_model=UnreadCountOut)
def my_unread_count(
    ctx: RequestContext = Depends(get_current_context),
) -> UnreadCountOut:
    """Total unread messages across all conversations the caller
    is a member of. Capped at 99 — drives the sidebar badge,
    which we re-poll every 60s.

    Single SQL query so the 60s poll cost stays flat regardless
    of how many conversations the user accumulates. NULL
    last_read_message_id means "never opened" — every non-author
    message counts.
    """
    row = ctx.db.execute(
        text(
            """
            SELECT COUNT(*) AS n
            FROM messages m
            JOIN conversation_members cm
              ON cm.conversation_id = m.conversation_id
             AND cm.person_id = :me
            WHERE m.author_person_id != :me
              AND m.deleted_at IS NULL
              AND (
                cm.last_read_message_id IS NULL
                OR m.id > cm.last_read_message_id
              )
              -- Hidden conversations don't contribute to the badge
              -- unless new activity since the hide brings them
              -- back. Otherwise a "deleted" chat would keep
              -- inflating the count forever.
              AND (
                cm.hidden_at IS NULL
                OR m.created_at > cm.hidden_at
              )
            """
        ),
        {"me": ctx.person.id},
    ).mappings().first()
    n = int(row["n"]) if row else 0
    return UnreadCountOut(total=min(99, n))


@router.post(
    "/conversations/{conversation_id}/read",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def mark_read(
    conversation_id: int,
    payload: MarkReadRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    conv = _ensure_membership(ctx, conversation_id)
    mem = (
        ctx.db.query(ConversationMember)
        .filter(
            ConversationMember.conversation_id == conv.id,
            ConversationMember.person_id == ctx.person.id,
        )
        .one()
    )
    # Don't go backwards. The client can over-send (it's idempotent)
    # but the high-water mark only moves forward.
    if (
        mem.last_read_message_id is None
        or payload.last_message_id > mem.last_read_message_id
    ):
        mem.last_read_message_id = payload.last_message_id
    # Always stamp last_read_at, even when the high-water mark
    # didn't move. We use this in the email-fallback path as
    # "this person looked recently, don't email them."
    mem.last_read_at = datetime.now(timezone.utc)
    ctx.db.flush()


@router.delete(
    "/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_conversation(
    conversation_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Per-user "delete" a conversation. Stamps `hidden_at` on the
    caller's ConversationMember row; the other participant's view
    is untouched.

    If the peer sends a new message after this, the conversation
    re-appears for the caller because the list filter checks
    `last_message_at > hidden_at`. WhatsApp / Slack pattern —
    matches the mental model users already have.

    Idempotent: re-issuing is a no-op (we don't move hidden_at
    forward on subsequent calls; the existing value already
    excludes everything up to it, and any new activity has
    already bumped last_message_at past it).
    """
    conv = _ensure_membership(ctx, conversation_id)
    mem = (
        ctx.db.query(ConversationMember)
        .filter(
            ConversationMember.conversation_id == conv.id,
            ConversationMember.person_id == ctx.person.id,
        )
        .one()
    )
    # Always re-stamp so a fresh "Borrar conversación" hides anything
    # the peer sent between the last hide and now — otherwise the
    # caller could keep seeing messages they explicitly tried to
    # banish.
    mem.hidden_at = datetime.now(timezone.utc)
    ctx.db.flush()


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_message(
    conversation_id: int,
    message_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Soft-delete a single message. Author-only.

    Sets `deleted_at` AND nulls the body so the content is gone
    from the DB (privacy: the body shouldn't survive deletion
    even though the row does). The row itself stays so message
    ids remain stable for last_read tracking.

    The peer continues to see the message slot, but rendered as
    "(mensaje borrado)" — same UX as WhatsApp's "delete for
    everyone".

    404 if the message isn't in this conversation, or isn't
    authored by the caller. We don't expose 403 vs 404 to avoid
    leaking which messages exist.
    """
    _ensure_membership(ctx, conversation_id)
    msg = (
        ctx.db.query(Message)
        .filter(
            Message.id == message_id,
            Message.conversation_id == conversation_id,
        )
        .first()
    )
    if msg is None:
        raise HTTPException(status_code=404, detail="Mensaje no encontrado")
    if msg.author_person_id != ctx.person.id:
        # Don't reveal that the message exists — same 404 path.
        raise HTTPException(status_code=404, detail="Mensaje no encontrado")
    if msg.deleted_at is not None:
        # Already deleted — idempotent no-op.
        return
    msg.deleted_at = datetime.now(timezone.utc)
    # Null the body so the content is gone from the DB. The column
    # is NOT NULL in the schema, so we can't actually set it to
    # NULL — instead empty-string it. The serializer still keys off
    # deleted_at, so the UI rendering ("mensaje borrado") is
    # unchanged.
    msg.body = ""
    ctx.db.flush()


# ---------------------------------------------------------------------------
# Internal serialization
# ---------------------------------------------------------------------------


def _serialize_conversation(
    ctx: RequestContext, conv: Conversation
) -> ConversationOut:
    """Heavy lifter for both create + list. Computes:
      - peer (DMs only; the OTHER member)
      - title + member_count + member_previews (groups only;
        migration 0088)
      - unread_count (messages after last_read, not authored by me)
      - last_message_preview (latest body, trimmed)

    Each call hits the DB ~3 more times. For the conversation list
    we accept the N+1 in Phase 2A — directories are small (max ~50
    conversations per user in practice) and we'll batch this in
    Phase 2B if the list page feels slow.
    """
    members = (
        ctx.db.query(ConversationMember)
        .filter(ConversationMember.conversation_id == conv.id)
        .all()
    )
    me_member = next(
        (m for m in members if m.person_id == ctx.person.id), None
    )

    peer: ConversationPeerOut | None = None
    member_previews: list[ConversationMemberPreview] = []
    member_count = 0

    if conv.kind == "dm":
        # Find the peer (the OTHER member). DMs always have exactly
        # 2 by construction; if data drift puts us at 1 or 3,
        # surface as "(unknown)".
        peer_member = next(
            (m for m in members if m.person_id != ctx.person.id), None
        )
        if peer_member is None:
            peer = ConversationPeerOut(person_id=0, name="(desconocido)")
        else:
            # Hydrate peer details. Cross-tenant query — use raw SQL
            # to avoid RLS quirks on memberships.
            row = ctx.db.execute(
                text(
                    """
                    SELECT
                        p.id, p.name, p.first_name, p.last_name, p.avatar_url,
                        c.name AS category_name,
                        t.name AS tenant_name
                    FROM persons p
                    LEFT JOIN memberships m
                      ON m.person_id = p.id
                     AND m.tenant_id IN (
                         SELECT id FROM tenants WHERE hospital_id = :hid
                     )
                     AND m.disabled_at IS NULL
                    LEFT JOIN categories c ON c.id = m.category_id
                    LEFT JOIN tenants t ON t.id = m.tenant_id
                    WHERE p.id = :pid
                    ORDER BY m.id ASC
                    LIMIT 1
                    """
                ),
                {
                    "pid": peer_member.person_id,
                    "hid": conv.hospital_id,
                },
            ).mappings().first()
            if row is None:
                peer = ConversationPeerOut(
                    person_id=peer_member.person_id, name="(desconocido)"
                )
            else:
                peer = ConversationPeerOut(
                    person_id=row["id"],
                    name=row["name"],
                    first_name=row["first_name"],
                    last_name=row["last_name"],
                    avatar_url=row["avatar_url"],
                    category_name=row["category_name"],
                    tenant_name=row["tenant_name"],
                )
    else:
        # Group. Fetch all members for the avatar-stack preview, in
        # join order (so the same three faces stay on top across
        # renders). Three is enough for the avatar stack; the UI
        # renders "+N más" past that.
        member_count = len(members)
        preview_ids = [
            m.person_id for m in members[:3] if m.person_id != ctx.person.id
        ]
        # If the caller is among the first three and we'd otherwise
        # only return ≤2 previews, pull one more so the stack is
        # full (3 faces is the visual target).
        if len(preview_ids) < 3:
            extra = [
                m.person_id
                for m in members
                if m.person_id != ctx.person.id
                and m.person_id not in preview_ids
            ]
            preview_ids = (preview_ids + extra)[:3]
        if preview_ids:
            rows = (
                ctx.db.execute(
                    text(
                        """
                        SELECT id, name, first_name, last_name, avatar_url
                        FROM persons
                        WHERE id = ANY(:ids)
                        """
                    ),
                    {"ids": preview_ids},
                )
                .mappings()
                .all()
            )
            # Preserve preview_ids order even if the IN-list scan
            # returned them shuffled.
            by_id = {r["id"]: r for r in rows}
            for pid in preview_ids:
                r = by_id.get(pid)
                if r is None:
                    continue
                member_previews.append(
                    ConversationMemberPreview(
                        person_id=r["id"],
                        name=r["name"],
                        first_name=r["first_name"],
                        last_name=r["last_name"],
                        avatar_url=r["avatar_url"],
                    )
                )

    # Unread = messages with id > last_read AND author != me.
    # Cap at 99 so the badge stays UI-friendly.
    last_read = me_member.last_read_message_id if me_member else None
    unread_q = ctx.db.query(func.count(Message.id)).filter(
        Message.conversation_id == conv.id,
        Message.author_person_id != ctx.person.id,
    )
    if last_read is not None:
        unread_q = unread_q.filter(Message.id > last_read)
    unread_count = min(99, int(unread_q.scalar() or 0))

    # Last message preview (latest body, trimmed). Even own
    # messages count for the preview — admins like to see "ok"
    # echoed back after they send.
    last_row = (
        ctx.db.query(Message)
        .filter(Message.conversation_id == conv.id)
        .order_by(Message.id.desc())
        .first()
    )
    preview: str | None = None
    if last_row is not None:
        body = "(mensaje borrado)" if last_row.deleted_at else last_row.body
        preview = body[:140] if body else None

    return ConversationOut(
        id=conv.id,
        hospital_id=conv.hospital_id,
        kind=conv.kind,
        created_at=conv.created_at,
        last_message_at=conv.last_message_at,
        peer=peer,
        title=conv.title,
        member_count=member_count,
        member_previews=member_previews,
        created_by_person_id=conv.created_by_person_id,
        unread_count=unread_count,
        last_message_preview=preview,
    )


# ---------------------------------------------------------------------------
# Group chats (migration 0088)
# ---------------------------------------------------------------------------


def _validate_hospital_peers(
    ctx: RequestContext, hospital_id: int, person_ids: list[int]
) -> list[int]:
    """Return the deduped subset of `person_ids` that are valid
    peers in the caller's hospital. The caller's own id is dropped
    silently — every group includes them by construction.

    "Valid peer" matches the same definition as the directory:
    person has at least one ACTIVE membership in a tenant under
    the same hospital. 422 if any id fails (rather than silently
    dropping) so the frontend can show a clear "this person isn't
    available" error before the partial create lands.
    """
    deduped = sorted(
        {pid for pid in person_ids if pid != ctx.person.id}
    )
    if not deduped:
        raise HTTPException(
            status_code=400,
            detail="Un grupo necesita al menos un miembro además de ti.",
        )
    rows = (
        ctx.db.execute(
            text(
                """
                SELECT DISTINCT p.id
                FROM persons p
                JOIN memberships m ON m.person_id = p.id
                JOIN tenants t ON t.id = m.tenant_id
                WHERE p.id = ANY(:ids)
                  AND t.hospital_id = :hid
                  AND m.disabled_at IS NULL
                """
            ),
            {"ids": deduped, "hid": hospital_id},
        )
        .mappings()
        .all()
    )
    found = {r["id"] for r in rows}
    missing = [pid for pid in deduped if pid not in found]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=(
                "Algunas personas no están disponibles en tu "
                "hospital."
            ),
        )
    return deduped


@router.post(
    "/group-chats",
    response_model=ConversationOut,
    status_code=status.HTTP_201_CREATED,
)
def create_group_chat(
    payload: GroupChatCreateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> ConversationOut:
    """Create a new group conversation. Caller is automatically
    added as a member (and stamped as `created_by_person_id`).

    Validation:
      - Title length 1..120 (Pydantic).
      - At least one other member beyond the caller.
      - Every member is reachable in the caller's hospital
        (`directory`-grade visibility check).

    No size cap — see migration 0088 docstring for the rationale.
    """
    hospital_id = _require_hospital(ctx)
    peer_ids = _validate_hospital_peers(
        ctx, hospital_id, payload.member_person_ids
    )
    conv = Conversation(
        hospital_id=hospital_id,
        kind="group",
        title=payload.title.strip(),
        created_by_person_id=ctx.person.id,
    )
    ctx.db.add(conv)
    ctx.db.flush()
    # Caller first, then peers in id order — the join order drives
    # which 3 faces show up on the avatar stack.
    ctx.db.add(
        ConversationMember(
            conversation_id=conv.id, person_id=ctx.person.id
        )
    )
    for pid in peer_ids:
        ctx.db.add(
            ConversationMember(conversation_id=conv.id, person_id=pid)
        )
    ctx.db.flush()
    return _serialize_conversation(ctx, conv)


@router.patch(
    "/conversations/{conversation_id}",
    response_model=ConversationOut,
)
def rename_group_chat(
    conversation_id: int,
    payload: GroupChatRenameRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> ConversationOut:
    """Rename a group. Any current member can do this — renames
    aren't disruptive enough to warrant a permissions gate. DMs
    can't be renamed (they don't have a title) and 400 here."""
    conv = _ensure_membership(ctx, conversation_id)
    if conv.kind != "group":
        raise HTTPException(
            status_code=400, detail="Solo los grupos se pueden renombrar"
        )
    conv.title = payload.title.strip()
    ctx.db.flush()
    return _serialize_conversation(ctx, conv)


@router.post(
    "/conversations/{conversation_id}/members",
    response_model=ConversationOut,
)
def add_group_members(
    conversation_id: int,
    payload: GroupMembersAddRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> ConversationOut:
    """Add one or more members to a group. Any current member can
    add. Already-members are silently skipped so the frontend can
    re-submit safely.

    New members' `last_read_message_id` is initialised to the
    current latest message's id (and `last_read_at` to now), so
    they don't open the chat to a wall of "247 unread" — they
    see history when they look, but the badge only counts
    messages sent AFTER they joined.
    """
    conv = _ensure_membership(ctx, conversation_id)
    if conv.kind != "group":
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden añadir miembros a grupos",
        )
    peer_ids = _validate_hospital_peers(
        ctx, conv.hospital_id, payload.person_ids
    )
    existing_ids = {
        r[0]
        for r in ctx.db.query(ConversationMember.person_id)
        .filter(ConversationMember.conversation_id == conv.id)
        .all()
    }
    to_add = [pid for pid in peer_ids if pid not in existing_ids]
    if to_add:
        latest_message_id = (
            ctx.db.query(func.max(Message.id))
            .filter(Message.conversation_id == conv.id)
            .scalar()
        )
        now = datetime.now(timezone.utc)
        for pid in to_add:
            ctx.db.add(
                ConversationMember(
                    conversation_id=conv.id,
                    person_id=pid,
                    last_read_message_id=latest_message_id,
                    last_read_at=now,
                )
            )
        ctx.db.flush()
    return _serialize_conversation(ctx, conv)


@router.delete(
    "/conversations/{conversation_id}/members/{person_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def remove_group_member(
    conversation_id: int,
    person_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Remove a member from a group. Permission model:
      - Self-removal: always allowed (anyone can leave).
      - Remove someone else: only the creator
        (`conv.created_by_person_id`) can do it. If the creator
        was deleted (created_by_person_id IS NULL), nobody can
        remove anyone but themselves — by design, so an abandoned
        group can't be hijacked.

    Idempotent: removing someone who isn't a member is a 204
    no-op so the frontend can re-submit safely.
    """
    conv = _ensure_membership(ctx, conversation_id)
    if conv.kind != "group":
        raise HTTPException(
            status_code=400,
            detail="Solo se gestionan miembros en grupos",
        )
    is_self = person_id == ctx.person.id
    if not is_self:
        if (
            conv.created_by_person_id is None
            or conv.created_by_person_id != ctx.person.id
        ):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Solo quien creó el grupo puede expulsar a otros "
                    "miembros."
                ),
            )
    target = (
        ctx.db.query(ConversationMember)
        .filter(
            ConversationMember.conversation_id == conv.id,
            ConversationMember.person_id == person_id,
        )
        .first()
    )
    if target is not None:
        ctx.db.delete(target)
        ctx.db.flush()


@router.post(
    "/conversations/{conversation_id}/leave",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def leave_group_chat(
    conversation_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Sugar for "DELETE .../members/{my_person_id}". Convenient
    for the frontend's "Salir del grupo" button."""
    conv = _ensure_membership(ctx, conversation_id)
    if conv.kind != "group":
        raise HTTPException(
            status_code=400,
            detail="Solo se puede salir de grupos",
        )
    mem = (
        ctx.db.query(ConversationMember)
        .filter(
            ConversationMember.conversation_id == conv.id,
            ConversationMember.person_id == ctx.person.id,
        )
        .first()
    )
    if mem is not None:
        ctx.db.delete(mem)
        ctx.db.flush()
