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
            "person_last_name, person_avatar_url, membership_id, "
            "tenant_id, tenant_name, tenant_slug, category_id, "
            "category_name, group_id, group_name, roles "
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
        out.append(HospitalDirectoryEntry(**r))
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
