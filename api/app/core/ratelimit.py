"""In-process rate limiting for auth endpoints (ops P3).

A sliding-window counter keyed by (endpoint, client IP). Throttles
brute-force / enumeration on /login, /signup, /forgot-password,
/reset-password — no new dependency, no external store. Correct for our
deployment: a single uvicorn worker (the SSE broker requires one), so
there's exactly one process to count against.

Disabled via settings.rate_limit_enabled (the test suite turns it off in
conftest so fixture-heavy tests don't trip it).

Limits are deliberately GENEROUS on /login: hospitals frequently sit
behind one NAT egress IP, so a tight per-IP login cap would lock out the
whole service at shift change. The signup / password-reset flows are
low-volume from legitimate users, so those stay tight. Bump the numbers
if a real customer ever hits a wall — they're plain ints below.
"""
import time
from collections import deque
from threading import Lock

from fastapi import HTTPException, Request, status

from app.core.config import settings

# NOTE: no `from __future__ import annotations` here — FastAPI
# introspects RateLimiter.__call__'s signature to inject `request`, and
# stringised annotations would make it fail to resolve `Request`.

# key -> monotonic timestamps of recent hits, within the window.
_buckets: dict[str, deque] = {}
_lock = Lock()


def _client_ip(request: Request) -> str:
    """The real client IP. All prod traffic is behind Caddy, which
    APPENDS the actual peer to X-Forwarded-For — so the RIGHTMOST entry
    is the address Caddy saw. A client can prepend fake hops but cannot
    remove Caddy's append, so the last element is spoof-resistant."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"


class RateLimiter:
    """FastAPI dependency. Raises 429 when an IP exceeds `limit` hits to
    this endpoint within `window` seconds (sliding window)."""

    def __init__(self, name: str, *, limit: int, window: int) -> None:
        self.name = name
        self.limit = limit
        self.window = window

    def __call__(self, request: Request) -> None:
        if not settings.rate_limit_enabled:
            return
        key = f"{self.name}:{_client_ip(request)}"
        now = time.monotonic()
        cutoff = now - self.window
        with _lock:
            dq = _buckets.get(key)
            if dq is None:
                dq = deque()
                _buckets[key] = dq
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= self.limit:
                retry = int(dq[0] + self.window - now) + 1
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=(
                        "Demasiados intentos. Espera unos minutos e "
                        "inténtalo de nuevo."
                    ),
                    headers={"Retry-After": str(max(1, retry))},
                )
            dq.append(now)
            # Opportunistic cleanup so abandoned IP keys don't grow
            # unbounded over long uptimes (a restart clears them anyway).
            if len(_buckets) > 5000:
                for k in [k for k, d in _buckets.items() if not d]:
                    del _buckets[k]


# Endpoint limiters. Login generous (shared hospital IPs); the rest
# tight (low legitimate volume → brute-force/enumeration protection).
login_rate_limit = RateLimiter("login", limit=30, window=300)  # 30 / 5 min
signup_rate_limit = RateLimiter("signup", limit=10, window=3600)  # 10 / h
forgot_password_rate_limit = RateLimiter(
    "forgot_password", limit=10, window=3600
)  # 10 / h
reset_password_rate_limit = RateLimiter(
    "reset_password", limit=20, window=3600
)  # 20 / h
