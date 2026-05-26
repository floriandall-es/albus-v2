"""Cross-tenant hospital directory.

Sprint 28 / slice 0 of the hospital roll-up features.

Lists every active, opted-in clinician in any tenant of the
caller's hospital. The caller must be authenticated and their
current tenant must have a non-null hospital_id (i.e. it's
linked to a Hospital via the migration-0051 layer); otherwise
the endpoint returns an empty list.

The query crosses tenant boundaries — `memberships` is FORCE
ROW LEVEL SECURITY scoped per-tenant, so a plain SQLAlchemy
SELECT would only return the caller's own tenant's rows. We
go through the `list_hospital_directory` SECURITY DEFINER
function (migration 0052) which sees every row regardless of
the session's app.tenant_id.

No emails or phone numbers are exposed. The data is read-only;
the only mutation is the per-membership opt-out toggled on the
settings page via PATCH /api/me/directory-visibility.
"""

from __future__ import annotations

from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from sqlalchemy.exc import IntegrityError

from app.models import DirectoryFavorite, Membership
from app.routes.deps import RequestContext, get_current_context


router = APIRouter()


class HospitalDirectoryEntry(BaseModel):
    person_id: int
    person_name: str
    person_first_name: str | None = None
    person_last_name: str | None = None
    person_avatar_url: str | None = None
    membership_id: int
    tenant_id: int
    tenant_name: str
    tenant_slug: str
    category_id: int | None = None
    category_name: str | None = None
    # Migration 0060 → 0061: list of free-text job titles. The
    # frontend renders each as its own pill on the directory card;
    # category_name only surfaces when this list is empty (legacy
    # fallback for users who haven't picked any cargo).
    cargos: list[str] = []
    roles: list[str] = []
    # Contact channels. Each field is populated only when the
    # corresponding share_* flag on the membership is true AND the
    # underlying datum exists. Migration 0057 split phones into
    # work + personal; WhatsApp is always linked to the personal
    # phone (never the work one).
    email: str | None = None
    work_phone: str | None = None
    personal_phone: str | None = None
    whatsapp_phone: str | None = None
    # Set when the caller has starred this person via the
    # directory favorites table (migration 0058). Drives the
    # "Favoritos" section + filled-star icon on the directory card.
    is_favorite: bool = False
    # Set when this person is on a guardia-named slot today in any
    # published schedule of the hospital. Carries the slot name
    # verbatim so the card pill matches what they're actually
    # doing ("Guardia presencial", "Guardia localizada"…). Null
    # when not on guardia today or when the source schedule is
    # still a draft.
    on_guardia_today: str | None = None


@router.get(
    "/hospital/directory", response_model=list[HospitalDirectoryEntry]
)
def list_hospital_directory(
    q: str | None = Query(default=None, max_length=255),
    category_id: int | None = None,
    tenant_id: int | None = None,
    ctx: RequestContext = Depends(get_current_context),
) -> list[HospitalDirectoryEntry]:
    """Return clinicians visible in the caller's hospital directory.

    Optional filters:
      - `q`: case-insensitive substring match against name + last name.
      - `category_id`: restrict to one categoría.
      - `tenant_id`: restrict to one department of the hospital.
    """
    hospital_id = ctx.tenant.hospital_id
    if hospital_id is None:
        # Standalone tenant — no hospital, so no cross-tenant directory.
        # Returning [] (vs 404) keeps the UI simple: the page can render
        # an empty state asking the admin to set a hospital in
        # onboarding instead of forking on status codes.
        return []

    rows = ctx.db.execute(
        text(
            "SELECT person_id, person_name, person_first_name, "
            "person_last_name, person_avatar_url, person_email, "
            "person_work_phone, person_personal_phone, person_cargos, "
            "membership_id, tenant_id, tenant_name, tenant_slug, "
            "category_id, category_name, roles, "
            "share_work_phone, share_personal_phone, share_email, "
            "share_whatsapp "
            "FROM list_hospital_directory(:hid)"
        ),
        {"hid": hospital_id},
    ).mappings().all()

    # Load the caller's favorites set in one shot — we look it up
    # per directory row but only want a single round-trip. The
    # query isn't tenant-scoped (DirectoryFavorite has no RLS, and
    # we WANT cross-tenant data here: the caller may have starred
    # someone in another department of the same hospital).
    favorite_ids: set[int] = {
        row.favorite_person_id
        for row in ctx.db.query(DirectoryFavorite.favorite_person_id)
        .filter(DirectoryFavorite.person_id == ctx.person.id)
        .all()
    }

    # "Who's on guardia today?" — one cross-tenant SECURITY DEFINER
    # call (migration 0062). The function respects the same
    # publication-state visibility as the schedule serializer so
    # draft data never leaks here. We use server-local date for
    # `today` — Spain-only customer, so timezone fuzz isn't a real
    # concern yet.
    guardia_rows = ctx.db.execute(
        text(
            "SELECT person_id, slot_name "
            "FROM list_hospital_guardias_today(:hid, :today)"
        ),
        {"hid": hospital_id, "today": date_type.today()},
    ).mappings().all()
    guardia_by_person: dict[int, str] = {
        r["person_id"]: r["slot_name"] for r in guardia_rows
    }

    # Server-side filters. Keeping them in Python (not SQL) is fine
    # for the slice-0 directory — hospitals have O(100) members at
    # most. If this grows, push the filters into the SECURITY DEFINER
    # function with additional parameters.
    out: list[HospitalDirectoryEntry] = []
    needle = (q or "").strip().lower()
    for r in rows:
        if category_id is not None and r["category_id"] != category_id:
            continue
        if tenant_id is not None and r["tenant_id"] != tenant_id:
            continue
        if needle:
            haystack = " ".join(
                str(v).lower()
                for v in (
                    r["person_name"],
                    r["person_first_name"],
                    r["person_last_name"],
                )
                if v
            )
            if needle not in haystack:
                continue
        # Build the entry, gating contact fields by the share_*
        # flags. Hide the email/phone columns when the person
        # didn't opt in — the directory must not leak data the
        # consent toggle is meant to govern. WhatsApp is ALWAYS
        # tied to the personal phone; the work phone never gets
        # surfaced as a WhatsApp deep link.
        out.append(
            HospitalDirectoryEntry(
                person_id=r["person_id"],
                person_name=r["person_name"],
                person_first_name=r["person_first_name"],
                person_last_name=r["person_last_name"],
                person_avatar_url=r["person_avatar_url"],
                membership_id=r["membership_id"],
                tenant_id=r["tenant_id"],
                tenant_name=r["tenant_name"],
                tenant_slug=r["tenant_slug"],
                category_id=r["category_id"],
                category_name=r["category_name"],
                cargos=list(r["person_cargos"] or []),
                roles=list(r["roles"] or []),
                email=r["person_email"] if r["share_email"] else None,
                work_phone=(
                    r["person_work_phone"] if r["share_work_phone"] else None
                ),
                personal_phone=(
                    r["person_personal_phone"]
                    if r["share_personal_phone"]
                    else None
                ),
                whatsapp_phone=(
                    r["person_personal_phone"] if r["share_whatsapp"] else None
                ),
                is_favorite=r["person_id"] in favorite_ids,
                on_guardia_today=guardia_by_person.get(r["person_id"]),
            )
        )
    return out


class DirectoryVisibilityPatch(BaseModel):
    directory_visible: bool


@router.patch(
    "/me/directory-visibility",
    response_model=DirectoryVisibilityPatch,
)
def set_my_directory_visibility(
    payload: DirectoryVisibilityPatch,
    ctx: RequestContext = Depends(get_current_context),
) -> DirectoryVisibilityPatch:
    """Toggle the caller's own membership opt-out for the hospital
    directory. Scoped to the *current* tenant's membership — if the
    caller has multiple memberships, they need to switch tenants to
    set this per employment.
    """
    membership = ctx.db.get(Membership, ctx.membership.id)
    if membership is None:
        raise HTTPException(status_code=404, detail="Membership not found")
    membership.directory_visible = payload.directory_visible
    ctx.db.flush()
    return DirectoryVisibilityPatch(
        directory_visible=membership.directory_visible
    )


class ContactPreferencesPatch(BaseModel):
    """Per-channel directory opt-ins. Each field is optional so the
    UI can patch one at a time without touching the others. All
    phone-related flags default FALSE in the DB; the route only
    writes fields the client explicitly sent (exclude_unset).
    Migration 0057 split share_phone into share_work_phone +
    share_personal_phone; share_whatsapp targets the personal
    phone only."""

    share_work_phone: bool | None = None
    share_personal_phone: bool | None = None
    share_email: bool | None = None
    share_whatsapp: bool | None = None


class ContactPreferencesOut(BaseModel):
    share_work_phone: bool
    share_personal_phone: bool
    share_email: bool
    share_whatsapp: bool


@router.patch(
    "/me/contact-preferences",
    response_model=ContactPreferencesOut,
)
def set_my_contact_preferences(
    payload: ContactPreferencesPatch,
    ctx: RequestContext = Depends(get_current_context),
) -> ContactPreferencesOut:
    """Set the per-channel directory opt-ins on the caller's
    current-tenant membership. The two phone share flags govern
    work_phone and personal_phone independently; share_whatsapp
    surfaces personal_phone as a wa.me deep link in the directory.
    """
    membership = ctx.db.get(Membership, ctx.membership.id)
    if membership is None:
        raise HTTPException(status_code=404, detail="Membership not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(membership, k, v)
    ctx.db.flush()
    return ContactPreferencesOut(
        share_work_phone=membership.share_work_phone,
        share_personal_phone=membership.share_personal_phone,
        share_email=membership.share_email,
        share_whatsapp=membership.share_whatsapp,
    )


# ---------------------------------------------------------------------------
# Directory favorites — migration 0058. Personal preference per caller;
# /api/hospital/directory annotates each entry with `is_favorite` from
# the same table so the listing UI doesn't need a second fetch.
# ---------------------------------------------------------------------------


class DirectoryFavoriteRequest(BaseModel):
    peer_person_id: int


class DirectoryFavoriteAck(BaseModel):
    """Tiny ack the POST/DELETE return so the client can confirm
    state without a follow-up GET. The full list re-fetches via the
    refresh of /api/hospital/directory after a successful mutation."""

    peer_person_id: int
    is_favorite: bool


@router.post(
    "/me/directory-favorites",
    response_model=DirectoryFavoriteAck,
)
def add_directory_favorite(
    payload: DirectoryFavoriteRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> DirectoryFavoriteAck:
    """Star a directory peer. Idempotent — re-issuing for the same
    pair is a no-op (UNIQUE constraint catches it; we swallow the
    IntegrityError and return the existing state).

    Can't favorite yourself (DB CHECK + explicit 422 here so the
    error message is friendly instead of a Postgres trace)."""
    if payload.peer_person_id == ctx.person.id:
        raise HTTPException(
            status_code=422, detail="No puedes marcarte como favorito a ti mismo."
        )
    fav = DirectoryFavorite(
        person_id=ctx.person.id,
        favorite_person_id=payload.peer_person_id,
    )
    ctx.db.add(fav)
    try:
        ctx.db.flush()
    except IntegrityError:
        # Already favorited — fine, just report the current state.
        ctx.db.rollback()
    return DirectoryFavoriteAck(
        peer_person_id=payload.peer_person_id, is_favorite=True
    )


@router.delete(
    "/me/directory-favorites/{peer_person_id}",
    response_model=DirectoryFavoriteAck,
)
def remove_directory_favorite(
    peer_person_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> DirectoryFavoriteAck:
    """Unstar a directory peer. Idempotent — deleting a non-existent
    row is fine, returns is_favorite=False either way."""
    ctx.db.query(DirectoryFavorite).filter(
        DirectoryFavorite.person_id == ctx.person.id,
        DirectoryFavorite.favorite_person_id == peer_person_id,
    ).delete(synchronize_session=False)
    ctx.db.flush()
    return DirectoryFavoriteAck(
        peer_person_id=peer_person_id, is_favorite=False
    )
