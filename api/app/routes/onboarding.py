from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status

from app.routes.deps import RequestContext, get_current_context
from app.schemas.auth import TenantOut

router = APIRouter()


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
