"""Server-side slug generation tests.

The signup form no longer asks for a tenant slug — the server derives one
from tenant_name. These tests pin the rules so the auto-derived slug stays
recognizable, unique, and conformant to the column's regex.
"""
import re
import uuid

SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def _signup(client, name: str, email: str | None = None) -> dict:
    email = email or f"u-{uuid.uuid4().hex[:8]}@example.com"
    r = client.post(
        "/api/signup",
        json={
            "tenant_name": name,
            "person_name": "Admin",
            "email": email,
            "password": "supersecret1",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_basic_name_to_slug(client):
    body = _signup(client, "Hospital La Paz")
    slug = body["tenant"]["slug"]
    assert slug.startswith("hospital-la-paz")
    assert SLUG_PATTERN.match(slug)


def test_collision_appends_numeric_suffix(client):
    name = f"Hospital Colision {uuid.uuid4().hex[:6]}"
    first = _signup(client, name)
    second = _signup(client, name)
    base = first["tenant"]["slug"]
    other = second["tenant"]["slug"]
    assert base != other
    # second one should be base + "-2" (or higher if another collision occurred)
    assert other.startswith(base + "-") or re.match(rf"^{re.escape(base)}-\d+$", other)


def test_accents_and_symbols_normalized(client):
    body = _signup(client, "Hospital Niño Jesús")
    slug = body["tenant"]["slug"]
    # Diacritics dropped, ñ → n, no leftover symbols.
    assert slug.startswith("hospital-nino-jesus")
    assert SLUG_PATTERN.match(slug)


def test_only_symbols_falls_back_to_random(client):
    body = _signup(client, "***")
    slug = body["tenant"]["slug"]
    assert slug.startswith("tenant-")
    # 6 hex chars after "tenant-"
    assert re.match(r"^tenant-[0-9a-f]{6}$", slug)
    assert SLUG_PATTERN.match(slug)


def test_slug_pattern_always_valid(client):
    for name in [
        "ñoño & co.",
        "  Hospital   con   espacios  ",
        "ABC123",
        "École de Médecine",
    ]:
        body = _signup(client, name)
        slug = body["tenant"]["slug"]
        assert SLUG_PATTERN.match(slug), f"Bad slug {slug!r} for name {name!r}"
        # Length cap.
        assert len(slug) <= 64
