"""Meeting group chats — the conversation tied to a reunión.

Each meeting can have one group conversation (the partial-unique
index on conversations.context_id WHERE context_kind='meeting'
enforces it). Membership mirrors the meeting's audience: the union
of include_main_team (every active member of the meeting's tenant)
and the individually-named invitees — plus whoever opens it, so an
admin who isn't formally in the audience can still take part.

Why AdminSessionLocal and not the request session: a meeting can
have cross-tenant invitees (sibling equipos in the same servicio),
and resolving the host tenant's main team from a sibling-tenant
caller's RLS-scoped session would return nothing. The hospital-wide
conversation tables carry no RLS, so this mirrors how routes/dms.py
fans out across the hospital.

Membership reconciles on each "open" (get_or_create) call — new
invitees are pulled in whenever someone opens the chat. We don't
hook meeting edits (that would mean reading an uncommitted audience
mid-request); the next open reconciles, which is enough for a chat
that's only useful once opened.
"""

from __future__ import annotations

from sqlalchemy.exc import IntegrityError

from app.db.session import AdminSessionLocal
from app.models import (
    Conversation,
    ConversationMember,
    MeetingAudiencePerson,
    Membership,
)


def _audience_person_ids(
    adb, *, meeting_id: int, tenant_id: int, include_main_team: bool
) -> set[int]:
    ids: set[int] = set()
    if include_main_team:
        ids.update(
            r[0]
            for r in adb.query(Membership.person_id)
            .filter(
                Membership.tenant_id == tenant_id,
                Membership.disabled_at.is_(None),
            )
            .all()
        )
    ids.update(
        r[0]
        for r in adb.query(MeetingAudiencePerson.person_id)
        .filter(MeetingAudiencePerson.meeting_id == meeting_id)
        .all()
    )
    return ids


def get_or_create_meeting_chat(
    *,
    meeting_id: int,
    tenant_id: int,
    hospital_id: int,
    title: str,
    include_main_team: bool,
    opener_person_id: int,
) -> int:
    """Find-or-create the meeting's group conversation, reconcile its
    membership against the current audience, and return its id."""
    chat_title = (title or "Reunión").strip()[:120] or "Reunión"
    with AdminSessionLocal() as adb:
        conv = (
            adb.query(Conversation)
            .filter(
                Conversation.context_kind == "meeting",
                Conversation.context_id == meeting_id,
            )
            .first()
        )
        audience = _audience_person_ids(
            adb,
            meeting_id=meeting_id,
            tenant_id=tenant_id,
            include_main_team=include_main_team,
        )
        # The opener always participates, even if not formally in the
        # audience (e.g. a tenant admin who didn't invite themselves).
        audience.add(opener_person_id)

        if conv is None:
            conv = Conversation(
                hospital_id=hospital_id,
                kind="group",
                title=chat_title,
                context_kind="meeting",
                context_id=meeting_id,
            )
            adb.add(conv)
            try:
                adb.flush()
            except IntegrityError:
                # Race: another request created the meeting's chat
                # between our SELECT and INSERT (partial-unique index
                # uq_conversations_meeting). Roll back and fall through
                # to the "exists" path against the winner's row.
                adb.rollback()
                conv = (
                    adb.query(Conversation)
                    .filter(
                        Conversation.context_kind == "meeting",
                        Conversation.context_id == meeting_id,
                    )
                    .one()
                )
            else:
                for pid in sorted(audience):
                    adb.add(
                        ConversationMember(
                            conversation_id=conv.id, person_id=pid
                        )
                    )
                adb.commit()
                return conv.id
        # Either it already existed, or we lost the create race — in
        # both cases reconcile membership against the current audience.
        if conv.title != chat_title:
            conv.title = chat_title
        existing = {
            r[0]
            for r in adb.query(ConversationMember.person_id)
            .filter(ConversationMember.conversation_id == conv.id)
            .all()
        }
        for pid in sorted(audience - existing):
            adb.add(
                ConversationMember(conversation_id=conv.id, person_id=pid)
            )
        cid = conv.id
        adb.commit()
        return cid
