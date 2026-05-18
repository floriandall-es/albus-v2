from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status

from app.models import Category
from app.routes.deps import RequestContext, get_current_context
from app.schemas.auth import SetPresetRequest, TenantOut
from app.services.onboarding_presets import get_preset

router = APIRouter()


@router.post("/onboarding/preset", response_model=TenantOut)
def set_preset(
    payload: SetPresetRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> TenantOut:
    """Set the tenant's onboarding preset and (on first selection)
    seed the default categories for that preset. Re-calling with a
    different kind only updates the stored preset_kind — categories
    that the admin already created are NOT touched, and missing
    defaults for the new preset are NOT re-seeded.

    Rationale for the "seed once" rule: an admin who clicks back to
    the preset step after editing categories should not have their
    work overwritten. The first selection is where defaults help;
    after that the wizard treats categories as user-owned data.
    """
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )

    preset = get_preset(payload.kind)
    is_first_selection = ctx.tenant.preset_kind is None

    ctx.tenant.preset_kind = preset.kind

    if is_first_selection and preset.default_categories:
        # Skip names that already exist (defensive — shouldn't happen
        # on first selection, but guards against a manual DB poke or
        # a half-finished prior run).
        existing_names = {
            row.name
            for row in ctx.db.query(Category)
            .filter(Category.tenant_id == ctx.tenant.id)
            .all()
        }
        for idx, name in enumerate(preset.default_categories):
            if name in existing_names:
                continue
            ctx.db.add(
                Category(
                    tenant_id=ctx.tenant.id,
                    name=name,
                    # `level` lets the admin sort by seniority later.
                    # Higher = more senior. We use 100, 90, 80… so
                    # there's room to insert sub-grades between them
                    # without renumbering.
                    level=100 - idx * 10,
                )
            )

    ctx.db.flush()
    return TenantOut.model_validate(ctx.tenant)


@router.post("/onboarding/complete", response_model=TenantOut)
def complete_onboarding(
    ctx: RequestContext = Depends(get_current_context),
) -> TenantOut:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )
    # Idempotent: only set the timestamp on the first completion. Re-calling
    # leaves the original value untouched so we have a stable record of when
    # the admin first finished the wizard.
    if ctx.tenant.onboarding_completed_at is None:
        ctx.tenant.onboarding_completed_at = datetime.now(timezone.utc)
        ctx.db.flush()
    return TenantOut.model_validate(ctx.tenant)
