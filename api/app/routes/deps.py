from dataclasses import dataclass
from typing import Generator

import jwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.db.session import SessionLocal, set_person, set_tenant
from app.models import Membership, Person, Tenant


@dataclass
class RequestContext:
    db: Session
    person: Person
    tenant: Tenant
    membership: Membership


def get_db_raw() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_context(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db_raw),
) -> Generator[RequestContext, None, None]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
        )
    token = authorization.split(" ", 1)[1].strip()
    # Distinguish "you've been signed out, log in again" (expired) from
    # "this token is forged or wrong type" (everything else) so the
    # frontend can render a helpful message instead of a vague
    # "Invalid token". Both are 401 — only the detail string differs.
    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Tu sesión ha caducado. Vuelve a iniciar sesión.",
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido. Vuelve a iniciar sesión.",
        )

    person_id = payload.get("person_id")
    tenant_id = payload.get("tenant_id")
    if not person_id or not tenant_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed token")

    # Verify membership exists (without RLS — query unscoped tables/PKs).
    person = db.get(Person, person_id)
    tenant = db.get(Tenant, tenant_id)
    if not person or not tenant:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown identity")

    # Set RLS context for this request's transaction.
    set_tenant(db, tenant_id)
    # app.person_id is the secondary identity GUC introduced for the
    # equipos redesign (migration 0070). Cross-tenant RLS policies on
    # meetings + meeting_audience_persons read it to decide if the
    # caller is in an audience entry that lives in a sibling tenant.
    # Set early so EVERY query in the request — including any
    # diagnostic helpers — sees a consistent identity.
    set_person(db, person_id)

    membership = (
        db.query(Membership)
        .filter(Membership.tenant_id == tenant_id, Membership.person_id == person_id)
        .first()
    )
    if not membership:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No membership for tenant")

    try:
        yield RequestContext(db=db, person=person, tenant=tenant, membership=membership)
        db.commit()
    except Exception:
        db.rollback()
        raise


# Statuses that confer write access. `past_due` is included — the
# admin gets a 7-day grace window on a missed payment before the
# webhook flips them to `unpaid` and write access actually breaks.
_ACTIVE_SUBSCRIPTION_STATUSES: frozenset[str] = frozenset(
    {"trialing", "active", "past_due"}
)


def require_active_subscription(
    ctx: RequestContext = Depends(get_current_context),
) -> RequestContext:
    """FastAPI dependency that gates **write** endpoints behind a
    live tenant subscription. Read endpoints (viewing already-
    published planning, profile, /admin/billing) stay reachable so
    the admin can reactivate.

    Returns 402 (Payment Required) with a Spanish detail string
    the frontend renders as the read-only banner / paywall. 402
    instead of 403 so the frontend's API interceptor can
    distinguish "you're not allowed" (403) from "you need to pay"
    (402) and route the latter to /admin/billing.

    Use on routes that produce value:
      - planning generate / publish / edit / archive
      - invitations create / resend
      - approvals (swaps, vacations, coverage)
      - tenant settings that affect future planning
    Don't use on:
      - read endpoints (GET anything)
      - /admin/billing itself (otherwise lapsed admins can't pay)
      - /me/billing
      - logout

    Tenant with `subscription_status IS NULL` (rows that predate
    migration 0080 and haven't been grandfathered yet) is treated
    as authorized — defensive default so the deploy doesn't break
    every existing tenant. The grandfather data migration flips
    those to `'active'` cleanly.
    """
    s = ctx.tenant.subscription_status
    if s is None:
        return ctx  # pre-migration tenant; allow until grandfather lands
    if s in _ACTIVE_SUBSCRIPTION_STATUSES:
        return ctx
    # s in ('unpaid', 'canceled')
    raise HTTPException(
        status_code=402,
        detail=(
            "Tu suscripción no está activa. Reactívala desde "
            "/admin/billing para seguir usando esta función."
        ),
    )
