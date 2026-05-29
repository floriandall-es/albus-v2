"""Web Push subscription management (migration 0089).

Three endpoints:
  GET    /api/push/vapid-public-key      Public key for the SW's subscribe()
  POST   /api/push/subscriptions         Upsert one device subscription
  DELETE /api/push/subscriptions/{id}    Caller revokes one of their devices

We deliberately don't expose a GET to LIST subscriptions in this
commit — the "manage devices" UI lands in a later frontend pass and
will add the listing endpoint then.

Authorisation: every route is gated by the caller's session and
filters every row by `person_id = ctx.person.id`. No tenant scope
on this table (see migration 0089 docstring).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.core.config import settings
from app.db.session import AdminSessionLocal
from app.routes.deps import RequestContext, get_current_context


logger = logging.getLogger("app.push.routes")
router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class VapidPublicKeyOut(BaseModel):
    public_key: str


class SubscriptionCreateRequest(BaseModel):
    """Body posted by the service worker right after it calls
    pushManager.subscribe(). Field names match the JSON shape
    PushSubscription.toJSON() emits in the browser so the frontend
    can forward it almost verbatim."""

    # Push service URL the browser was issued. Up to a few hundred
    # chars in practice.
    endpoint: str = Field(min_length=10, max_length=2000)
    # Subscription public key (base64url, ~88 chars).
    p256dh: str = Field(min_length=10, max_length=200)
    # Auth secret (base64url, ~24 chars).
    auth: str = Field(min_length=10, max_length=200)
    # Browser/device descriptor for the manage-devices panel. We let
    # the client supply it explicitly rather than reading request
    # headers — proxies sometimes strip or rewrite User-Agent, and
    # the client knows what string a human would recognise.
    user_agent: str | None = Field(default=None, max_length=500)


class SubscriptionCreateResponse(BaseModel):
    id: int


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/push/vapid-public-key", response_model=VapidPublicKeyOut)
def get_vapid_public_key(
    ctx: RequestContext = Depends(get_current_context),
) -> VapidPublicKeyOut:
    """Return the VAPID public key so the SW can subscribe.

    Gated on auth — there's no reason for unauthenticated traffic
    to need this, and gating it makes the endpoint less interesting
    to scanners. 503 when the key isn't configured so the frontend
    shows a clear "push isn't set up yet" state instead of a silent
    no-op.
    """
    if not settings.vapid_public_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "Las notificaciones aún no están configuradas en "
                "este entorno."
            ),
        )
    # ctx unused beyond the auth gate, but keeping the dep so the
    # endpoint is uniformly authenticated.
    _ = ctx
    return VapidPublicKeyOut(public_key=settings.vapid_public_key)


@router.post(
    "/push/subscriptions",
    response_model=SubscriptionCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_subscription(
    payload: SubscriptionCreateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> SubscriptionCreateResponse:
    """Upsert one subscription row. Endpoint is UNIQUE so the same
    browser re-subscribing (refresh, granted permission again) just
    moves the row to the current caller's account — important when
    a device is shared between Trivu accounts (rare but possible
    when a clinician swaps phones with a colleague during a shift).

    Returns 201 with the row id either way (created or updated) so
    the frontend can store it for the future "revoke this device"
    button.
    """
    # Direct SQL upsert on (endpoint) — keeps it atomic and avoids
    # the SELECT-then-INSERT race. ON CONFLICT touches person_id
    # because re-subscribing on a device that previously belonged
    # to a different account should re-point it.
    with AdminSessionLocal() as adb:
        row = adb.execute(
            text(
                """
                INSERT INTO push_subscriptions (
                    person_id, endpoint, p256dh, auth, user_agent
                ) VALUES (
                    :pid, :endpoint, :p256dh, :auth, :ua
                )
                ON CONFLICT (endpoint) DO UPDATE
                SET person_id = EXCLUDED.person_id,
                    p256dh = EXCLUDED.p256dh,
                    auth = EXCLUDED.auth,
                    user_agent = EXCLUDED.user_agent
                RETURNING id
                """
            ),
            {
                "pid": ctx.person.id,
                "endpoint": payload.endpoint,
                "p256dh": payload.p256dh,
                "auth": payload.auth,
                "ua": payload.user_agent,
            },
        ).first()
        adb.commit()
    if row is None:
        # Defensive — RETURNING on an UPSERT against a non-empty
        # table always yields a row, but a future schema change
        # could surprise us. 500 is correct here, not 422.
        raise HTTPException(
            status_code=500,
            detail="No se pudo guardar la suscripción.",
        )
    logger.info(
        "push subscription saved id=%s person_id=%s ua=%r",
        row[0],
        ctx.person.id,
        payload.user_agent,
    )
    return SubscriptionCreateResponse(id=row[0])


@router.delete(
    "/push/subscriptions/{subscription_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_subscription(
    subscription_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Response:
    """Caller revokes one of their own subscriptions. 204 even if
    the row doesn't exist or belongs to someone else — we don't want
    the endpoint to leak whether a given id is "yours but stale" vs
    "someone else's". Idempotent.
    """
    with AdminSessionLocal() as adb:
        adb.execute(
            text(
                """
                DELETE FROM push_subscriptions
                WHERE id = :id AND person_id = :pid
                """
            ),
            {"id": subscription_id, "pid": ctx.person.id},
        )
        adb.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
