"""Realtime (SSE) endpoints for chat.

Two routes:
  POST /api/realtime/ticket   mint a short-lived stream ticket (auth'd)
  GET  /api/realtime/stream    Server-Sent Events feed (ticket in query)

The client mints a ticket with its normal Bearer token, then opens an
EventSource to /stream?ticket=... (EventSource can't send headers, so
the ticket rides in the URL — it's single-purpose and expires in ~60s;
see create_stream_ticket). The stream pushes chat events
(message / read / message_deleted) for every conversation the caller
belongs to. Producers live in routes/dms.py and call
`broker.publish(...)`.

SSE, not WebSockets: the client only consumes events (it still sends
messages over the existing REST endpoints), so a one-way stream is the
simpler, proxy-friendlier fit. Caddy streams `text/event-stream`
without buffering; see the Caddyfile note.
"""

from __future__ import annotations

import asyncio
import json
import logging

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.config import settings
from app.core.security import create_stream_ticket, decode_stream_ticket
from app.routes.deps import RequestContext, get_current_context
from app.services.realtime import broker

logger = logging.getLogger("trivu.realtime")

router = APIRouter()

# How often we emit a heartbeat comment when no events are flowing.
# Kept under typical proxy/browser idle timeouts (~60s) so the
# connection stays warm, and gives us a cheap liveness probe: a
# failed write on a dead client raises and unwinds to cleanup.
_HEARTBEAT_SECONDS = 25


class StreamTicketOut(BaseModel):
    ticket: str
    # Seconds until the ticket expires — lets the client schedule a
    # refresh before reconnecting.
    expires_in: int


@router.post("/realtime/ticket", response_model=StreamTicketOut)
def mint_stream_ticket(
    ctx: RequestContext = Depends(get_current_context),
) -> StreamTicketOut:
    """Mint a single-purpose, ~60s ticket the client passes to the SSE
    stream. Authenticated with the normal Bearer token."""
    ticket = create_stream_ticket(
        person_id=ctx.person.id, tenant_id=ctx.tenant.id
    )
    return StreamTicketOut(
        ticket=ticket, expires_in=settings.stream_ticket_ttl_seconds
    )


@router.get("/realtime/stream")
async def realtime_stream(
    request: Request,
    ticket: str = Query(...),
) -> StreamingResponse:
    """Server-Sent Events feed for the authenticated person.

    Auth is the ticket (query param), validated here — EventSource
    can't set headers. We subscribe the person to the in-process
    broker and forward every event onto the wire as it arrives,
    interleaving heartbeat comments during idle gaps.
    """
    try:
        payload = decode_stream_ticket(ticket)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Stream ticket expired",
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid stream ticket",
        )
    person_id = int(payload["person_id"])

    async def event_source():
        q = await broker.subscribe(person_id)
        try:
            # Prompt first byte so the client's onopen fires and any
            # proxy commits to streaming rather than buffering.
            yield ": connected\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(
                        q.get(), timeout=_HEARTBEAT_SECONDS
                    )
                except asyncio.TimeoutError:
                    # Idle gap. Bail if the client has gone away;
                    # otherwise send a heartbeat to keep the pipe open.
                    if await request.is_disconnected():
                        break
                    yield ": ping\n\n"
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            broker.unsubscribe(person_id, q)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Belt-and-suspenders for nginx-style proxies; Caddy
            # streams text/event-stream unbuffered already.
            "X-Accel-Buffering": "no",
        },
    )
