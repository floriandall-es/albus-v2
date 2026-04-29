import os
import uuid

import pytest
from sqlalchemy import create_engine, text

from app.core.config import settings


@pytest.fixture(scope="session")
def db_url() -> str:
    return settings.database_url


@pytest.fixture(autouse=True)
def _clean_db(db_url: str):
    """Truncate all tenant data between tests so suites don't leak.
    Migrations run once during container startup; we reset rows here."""
    engine = create_engine(db_url, future=True)
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL session_replication_role = 'replica'"))
        # CASCADE handles all child tables (memberships, slots, …) since every
        # tenant-scoped table FKs back to tenants ON DELETE CASCADE.
        for table in ("tenants", "persons"):
            conn.execute(text(f"TRUNCATE TABLE {table} RESTART IDENTITY CASCADE"))
    engine.dispose()
    yield


@pytest.fixture
def unique_slug() -> str:
    return f"t-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def unique_email() -> str:
    return f"u-{uuid.uuid4().hex[:8]}@example.com"


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_client(client, unique_slug, unique_email):
    """Sign up a fresh tenant + admin and return (client, headers, info)."""
    r = client.post(
        "/api/signup",
        json={
            "tenant_name": "Test Hospital",
            "tenant_slug": unique_slug,
            "person_name": "Admin",
            "email": unique_email,
            "password": "supersecret1",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    info = {
        "tenant_id": body["tenant"]["id"],
        "tenant_slug": body["tenant"]["slug"],
        "person_id": body["person"]["id"],
        "email": body["person"]["email"],
        "membership_id": body["memberships"][0]["id"],
    }
    return client, headers, info


@pytest.fixture
def second_tenant(client):
    """Create a second tenant + admin (Bob); returns (headers, info)."""
    suffix = uuid.uuid4().hex[:8]
    r = client.post(
        "/api/signup",
        json={
            "tenant_name": "Other Hospital",
            "tenant_slug": f"t2-{suffix}",
            "person_name": "Bob",
            "email": f"bob-{suffix}@example.com",
            "password": "supersecret1",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    info = {
        "tenant_id": body["tenant"]["id"],
        "tenant_slug": body["tenant"]["slug"],
        "person_id": body["person"]["id"],
    }
    return headers, info
