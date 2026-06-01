"""In-process realtime event broker for chat (SSE).

The chat UI used to poll (`/conversations` every 30s, the open
conversation every 5s). This broker lets the server *push* instead:
when a message is sent / read / deleted, we publish a small event to
every connected member's SSE stream, and the client updates its
React Query cache immediately.

## Why in-process (and the multi-worker caveat)

The prod API runs a **single uvicorn worker** (see api/Dockerfile —
no `--workers`), so every SSE connection is held by the same process
and a plain in-memory fan-out reaches all of them. That keeps this
dependency-free: no Redis, no Postgres LISTEN/NOTIFY.

⚠️ If we ever scale to multiple workers or containers, this breaks:
a publish on worker A won't reach a subscriber on worker B. The fix
at that point is to back `publish()` with Postgres LISTEN/NOTIFY
(we already have Postgres) or Redis pub/sub, keeping the same
subscribe()/publish() surface. This module is deliberately small so
that swap stays contained. The RUNBOOK calls this out.

## Sync → async bridge

Event producers (send_message, mark_read, …) are *sync* FastAPI
handlers and run in Starlette's threadpool, NOT the event loop
thread. asyncio.Queue is not thread-safe, so `publish()` hops back
onto the loop via `loop.call_soon_threadsafe`. The loop reference is
captured once at startup via `bind_loop()` (called from main's
startup hook).
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Iterable

logger = logging.getLogger("trivu.realtime")

# Per-subscriber queue bound. A healthy client drains within
# milliseconds; if one backs up past this (tab throttled, network
# stalled) we drop events for it rather than grow memory unbounded —
# the client's fallback poll reconciles whatever it missed.
_QUEUE_MAXSIZE = 200


class _Broker:
    def __init__(self) -> None:
        # person_id → set of live queues (one per open SSE connection;
        # a person can have several — multiple tabs / devices).
        self._subs: dict[int, set[asyncio.Queue]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Record the running event loop so sync producers can publish
        onto it thread-safely. Called once from the app startup hook."""
        self._loop = loop

    async def subscribe(self, person_id: int) -> asyncio.Queue:
        """Register a new SSE connection for `person_id`. Returns the
        queue the stream generator should drain. Call from the async
        endpoint (we're on the loop thread here)."""
        q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        self._subs[person_id].add(q)
        return q

    def unsubscribe(self, person_id: int, q: asyncio.Queue) -> None:
        """Drop a connection's queue when the stream ends."""
        subs = self._subs.get(person_id)
        if not subs:
            return
        subs.discard(q)
        if not subs:
            self._subs.pop(person_id, None)

    def connection_count(self) -> int:
        """Total live SSE connections (debug / health)."""
        return sum(len(s) for s in self._subs.values())

    def publish(self, person_ids: Iterable[int], event: dict) -> None:
        """Fan an event out to every live connection of each person in
        `person_ids`. Safe to call from sync (threadpool) handlers —
        we marshal each delivery back onto the event loop.

        No-op before the loop is bound (e.g. during a unit test that
        never started the app) or when nobody is connected — producers
        can call this unconditionally.
        """
        loop = self._loop
        if loop is None:
            return
        # Snapshot each subscriber set into a list before iterating.
        # subscribe()/unsubscribe() run on the loop thread while this
        # runs on a threadpool thread; copying avoids a "set changed
        # size during iteration" race.
        targets: list[asyncio.Queue] = []
        seen: set[int] = set()
        for pid in person_ids:
            if pid in seen:
                continue
            seen.add(pid)
            targets.extend(list(self._subs.get(pid, ())))
        if not targets:
            return
        for q in targets:
            loop.call_soon_threadsafe(self._safe_put, q, event)

    @staticmethod
    def _safe_put(q: asyncio.Queue, event: dict) -> None:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            # Slow consumer — drop. The client's fallback poll will
            # reconcile. Logged at debug so it's visible if it ever
            # becomes common (a sign the poll fallback is doing real
            # work and the stream is unhealthy).
            logger.debug("realtime queue full; dropping event")


# Module-level singleton. Import and use directly:
#   from app.services.realtime import broker
#   broker.publish([pid1, pid2], {"type": "message", ...})
broker = _Broker()
