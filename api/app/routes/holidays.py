"""Holidays admin endpoints.

CRUD over `holidays`, plus a `import` action that loads from the static
catalog in `app.data.holidays_es`. All admin-only and tenant-scoped via the
usual RequestContext + RLS path.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.data.holidays_es import lookup as lookup_holidays
from app.models import Holiday
from app.routes.deps import RequestContext, get_current_context
from app.schemas.holiday import (
    HolidayCreate,
    HolidayImport,
    HolidayImportResult,
    HolidayOut,
    SetupAreaUpdate,
    TenantUpdate,
)
from app.schemas.auth import TenantOut


# Map the `area` string in the API to the Tenant column name. Kept
# here (rather than in the schema) so the schema stays serialisation-
# only and the route owns the column-name binding.
_SETUP_AREA_COLUMNS: dict[str, str] = {
    "activities": "setup_activities_completed_at",
    "rules": "setup_rules_completed_at",
    "team": "setup_team_completed_at",
    "subteams": "setup_subteams_completed_at",
}

router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


@router.get("/holidays", response_model=list[HolidayOut])
def list_holidays(
    year: int | None = None,
    ctx: RequestContext = Depends(get_current_context),
) -> list[Holiday]:
    q = ctx.db.query(Holiday)
    if year is not None:
        q = q.filter(
            Holiday.date >= date(year, 1, 1),
            Holiday.date <= date(year, 12, 31),
        )
    return q.order_by(Holiday.date, Holiday.name).all()


@router.post(
    "/holidays",
    response_model=HolidayOut,
    status_code=status.HTTP_201_CREATED,
)
def create_holiday(
    payload: HolidayCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> Holiday:
    _require_admin(ctx)
    h = Holiday(
        tenant_id=ctx.tenant.id,
        date=payload.date,
        name=payload.name,
        source=payload.source,
        region_code=payload.region_code,
    )
    ctx.db.add(h)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Ya existe un festivo con esa fecha y nombre.")
    return h


@router.delete(
    "/holidays/{holiday_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_holiday(
    holiday_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    h = ctx.db.get(Holiday, holiday_id)
    if not h or h.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Holiday not found")
    ctx.db.delete(h)
    ctx.db.flush()


@router.post("/holidays/import", response_model=HolidayImportResult)
def import_holidays(
    payload: HolidayImport,
    ctx: RequestContext = Depends(get_current_context),
) -> HolidayImportResult:
    _require_admin(ctx)
    entries = lookup_holidays(payload.country_code, payload.region_code, payload.year)
    if not entries:
        return HolidayImportResult(inserted=0, skipped=0)

    inserted = skipped = 0
    for e in entries:
        # Per-row insert with savepoint so a single duplicate doesn't poison
        # the outer transaction.
        sp = ctx.db.begin_nested()
        h = Holiday(
            tenant_id=ctx.tenant.id,
            date=date.fromisoformat(e["date"]),
            name=e["name"],
            source=e["source"],
            region_code=e["region_code"],
        )
        ctx.db.add(h)
        try:
            ctx.db.flush()
            sp.commit()
            inserted += 1
        except IntegrityError:
            sp.rollback()
            skipped += 1
    return HolidayImportResult(inserted=inserted, skipped=skipped)


@router.patch("/tenants/me", response_model=TenantOut)
def update_tenant_defaults(
    payload: TenantUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> TenantOut:
    _require_admin(ctx)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(ctx.tenant, k, v)
    ctx.db.flush()
    return TenantOut.model_validate(ctx.tenant)


@router.post("/tenants/me/setup", response_model=TenantOut)
def update_setup_flag(
    payload: SetupAreaUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> TenantOut:
    """Toggle one of the per-area setup-completion flags.

    Idempotent: re-setting an already-true flag is a no-op (the
    timestamp doesn't move). Un-marking writes NULL. Used by the
    "Marcar como completado" / "Marcar como pendiente" buttons on
    /admin/slots, /admin/rules, /admin/team, /admin/groups.
    """
    _require_admin(ctx)
    column = _SETUP_AREA_COLUMNS[payload.area]
    if payload.completed:
        # Idempotent — don't move the timestamp on repeat calls so the
        # admin can see "when did I finish this" later if we surface it.
        if getattr(ctx.tenant, column) is None:
            setattr(ctx.tenant, column, datetime.now(timezone.utc))
    else:
        setattr(ctx.tenant, column, None)
    ctx.db.flush()
    return TenantOut.model_validate(ctx.tenant)
