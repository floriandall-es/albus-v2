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
    last_name: str | None = None
    avatar_url: str | None = None
    category_name: str | None = None
    tenant_name: str | None = None


class ConversationOut(BaseModel):
    id: int
    hospital_id: int
    kind: str
    created_at: datetime
    last_message_at: datetime
    # For DMs the peer is the other participant. For (future)
    # channels this would be a list of members instead.
    peer: ConversationPeerOut
    # Computed per request: messages.id > last_read_message_id AND
    # author != self. Capped at 99 to keep the badge readable.
    unread_count: int
    # Latest message preview (body trimmed to 140 chars; null when
    # the conversation has no messages yet).
    last_message_preview: str | None = None


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
    """
    convs = (
        ctx.db.query(Conversation)
        .join(
            ConversationMember,
            ConversationMember.conversation_id == Conversation.id,
        )
        .filter(ConversationMember.person_id == ctx.person.id)
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


# ---------------------------------------------------------------------------
# Internal serialization
# ---------------------------------------------------------------------------


def _serialize_conversation(
    ctx: RequestContext, conv: Conversation
) -> ConversationOut:
    """Heavy lifter for both create + list. Computes:
      - peer (the OTHER member of the DM)
      - unread_count (messages after last_read, not authored by me)
      - last_message_preview (latest body, trimmed)

    Each call hits the DB ~3 more times. For the conversation list
    we accept the N+1 in Phase 2A — directories are small (max ~50
    DMs per user in practice) and we'll batch this in Phase 2B if
    the list page feels slow.
    """
    # Find the peer (the other member). DMs always have exactly 2;
    # if data drift ever puts us at 1 or 3, surface as "(unknown)".
    members = (
        ctx.db.query(ConversationMember)
        .filter(ConversationMember.conversation_id == conv.id)
        .all()
    )
    me_member = next(
        (m for m in members if m.person_id == ctx.person.id), None
    )
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
                    p.id, p.name, p.last_name, p.avatar_url,
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
            {"pid": peer_member.person_id, "hid": conv.hospital_id},
        ).mappings().first()
        if row is None:
            peer = ConversationPeerOut(
                person_id=peer_member.person_id, name="(desconocido)"
            )
        else:
            peer = ConversationPeerOut(
                person_id=row["id"],
                name=row["name"],
                last_name=row["last_name"],
                avatar_url=row["avatar_url"],
                category_name=row["category_name"],
                tenant_name=row["tenant_name"],
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
        unread_count=unread_count,
        last_message_preview=preview,
    )
