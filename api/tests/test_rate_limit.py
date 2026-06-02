"""Auth endpoint rate limiting (ops P3).

The suite runs with rate limiting OFF (conftest), so these tests flip it
on explicitly and clear the in-process buckets around themselves.
"""
from app.core import ratelimit
from app.core.config import settings

_BAD_LOGIN = {"email": "nobody@example.com", "password": "whatever"}


def test_login_blocked_after_limit(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_enabled", True)
    ratelimit._buckets.clear()
    limit = ratelimit.login_rate_limit.limit

    # Up to the limit: allowed through to the handler (401 bad creds —
    # the point is they are NOT 429).
    for _ in range(limit):
        r = client.post("/api/login", json=_BAD_LOGIN)
        assert r.status_code != 429, r.text

    # One past the limit: throttled.
    r = client.post("/api/login", json=_BAD_LOGIN)
    assert r.status_code == 429, r.text
    assert r.headers.get("Retry-After")
    ratelimit._buckets.clear()


def test_disabled_by_default_no_throttle(client):
    # Suite default (disabled) → never 429 even well past the limit.
    for _ in range(ratelimit.login_rate_limit.limit + 5):
        r = client.post("/api/login", json=_BAD_LOGIN)
        assert r.status_code != 429, r.text
