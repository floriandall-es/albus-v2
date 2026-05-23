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

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from app.models import Membership
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
    group_id: int | None = None
    group_name: str | None = None
    roles: list[str] = []
    # Sprint 28 / migration 0053: contact channels. Only populated
    # when the corresponding share_* flag is true on the
    # membership — null otherwise. The frontend renders a
    # phone / email / WhatsApp button per non-null value.
    email: str | None = None
    phone_e164: str | None = None
    whatsapp_e164: str | None = None


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
            "person_phone_e164, membership_id, tenant_id, "
            "tenant_name, tenant_slug, category_id, category_name, "
            "group_id, group_name, roles, share_phone, share_email, "
            "share_whatsapp "
            "FROM list_hospital_directory(:hid)"
        ),
        {"hid": hospital_id},
    ).mappings().all()

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
        # consent toggle is meant to govern.
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
                group_id=r["group_id"],
                group_name=r["group_name"],
                roles=list(r["roles"] or []),
                email=r["person_email"] if r["share_email"] else None,
                phone_e164=(
                    r["person_phone_e164"] if r["share_phone"] else None
                ),
                whatsapp_e164=(
                    r["person_phone_e164"] if r["share_whatsapp"] else None
                ),
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
    """Sprint 28 / migration 0053. Each field is optional so the
    UI can patch one at a time without touching the others. All
    default FALSE in the DB; the route only writes fields the
    client explicitly sent (exclude_unset)."""

    share_phone: bool | None = None
    share_email: bool | None = None
    share_whatsapp: bool | None = None


class ContactPreferencesOut(BaseModel):
    share_phone: bool
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
    current-tenant membership. Phone + WhatsApp both source the
    same `persons.phone_e164` field — the flags govern which
    channel surfaces it.
    """
    membership = ctx.db.get(Membership, ctx.membership.id)
    if membership is None:
        raise HTTPException(status_code=404, detail="Membership not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(membership, k, v)
    ctx.db.flush()
    return ContactPreferencesOut(
        share_phone=membership.share_phone,
        share_email=membership.share_email,
        share_whatsapp=membership.share_whatsapp,
    )
