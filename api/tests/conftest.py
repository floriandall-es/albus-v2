import os
import re
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

from app.core.config import settings


def _rewrite_to_test_db(url: str) -> str:
    """Append `_test` to the database name in a SQLAlchemy URL."""
    parsed = make_url(url)
    db = parsed.database or ""
    if not db.endswith("_test"):
        db = f"{db}_test"
    return parsed.set(database=db).render_as_string(hide_password=False)


def _admin_url(url: str) -> str:
    """Switch to the `postgres` admin database on the same server."""
    parsed = make_url(url)
    return parsed.set(database="postgres").render_as_string(hide_password=False)


def _ensure_test_db(migrations_url: str) -> None:
    """Create albus_test if missing and run migrations against it.

    Uses the migrations role (POSTGRES_USER) which can CREATE DATABASE on the
    bootstrap dev cluster. Runs `alembic upgrade head` against the test DB so
    its schema (and the albus_app grants in 0001_initial) match production.
    """
    parsed = make_url(migrations_url)
    target_db = parsed.database
    assert target_db and target_db.endswith("_test")

    admin_engine = create_engine(_admin_url(migrations_url), isolation_level="AUTOCOMMIT", future=True)
    with admin_engine.connect() as conn:
        exists = conn.execute(
            text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": target_db}
        ).scalar()
        if not exists:
            # Identifier interpolation — target_db is constructed from settings,
            # not user input, so safe. Quote defensively anyway.
            conn.execute(text(f'CREATE DATABASE "{target_db}"'))
    admin_engine.dispose()

    # Run alembic against the test DB. Our env.py reads settings.database_url
    # at import time, so we need settings already swapped before invoking it.
    # The session fixture sets settings BEFORE calling _ensure_test_db.
    from alembic import command
    from alembic.config import Config

    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", migrations_url)
    command.upgrade(cfg, "head")


@pytest.fixture(scope="session", autouse=True)
def _test_database():
    """Redirect every engine in the app to a separate `_test` database.

    This runs ONCE per pytest session, before any other fixture resolves.
    It ensures the test DB exists, runs migrations, and rewrites
    settings.database_url / settings.app_database_url so that
    app.db.session.engine and any other create_engine call uses it.
    """
    test_migrations_url = _rewrite_to_test_db(settings.database_url)
    test_app_url = _rewrite_to_test_db(settings.runtime_db_url)

    # Settings must be swapped BEFORE alembic runs because env.py reads
    # settings.database_url at import time when emitting migrations.
    settings.database_url = test_migrations_url
    settings.app_database_url = test_app_url

    # Auth rate limiting (P3) off by default for the suite — the
    # fixtures hammer /signup, /login, etc. and would otherwise trip
    # 429. The dedicated test_rate_limit.py flips it on per-test.
    settings.rate_limit_enabled = False

    _ensure_test_db(test_migrations_url)

    # The app's session module already imported settings and created an engine
    # against the dev DB at import time. Replace it.
    from app.db import session as session_mod
    from sqlalchemy.orm import sessionmaker

    session_mod.engine.dispose()
    session_mod.engine = create_engine(test_app_url, pool_pre_ping=True, future=True)
    session_mod.SessionLocal = sessionmaker(
        bind=session_mod.engine, autoflush=False, autocommit=False, future=True
    )

    yield


@pytest.fixture(scope="session")
def db_url() -> str:
    return settings.database_url


@pytest.fixture(autouse=True)
def _clean_db(db_url: str):
    """Truncate all tenant data between tests.

    Operates against `albus_test` (set up by _test_database session fixture),
    NEVER the dev DB. Uses migrations role so RLS doesn't block truncate.
    """
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


@pytest.fixture(scope="session")
def cnh_hospital(_test_database) -> int:
    """Seed one CNH-coded hospital and return its id.

    Phase D.2 signup refuses a hospital whose `public_code` is NULL
    (free-text hospital creation was retired — the wizard's CNH
    typeahead is the only way to get a valid `hospital_id`). The
    signup-based fixtures therefore need a real catalog row to point
    at. Hospitals aren't tenant-scoped and aren't touched by
    `_clean_db` (which truncates only tenants/persons), so seeding
    once per session is safe and survives the per-test cleanup.
    """
    eng = create_engine(settings.database_url, future=True)
    with eng.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO hospitals (slug, name, public_code) "
                "VALUES ('test-cnh', 'Test CNH Hospital', 'TESTCNH') "
                "ON CONFLICT (slug) DO NOTHING"
            )
        )
        hid = conn.execute(
            text("SELECT id FROM hospitals WHERE slug = 'test-cnh'")
        ).scalar_one()
    eng.dispose()
    return int(hid)


def _signup_payload(*, first_name: str, email: str, suffix: str, hospital_id: int) -> dict:
    """Current (Phase D.2) signup contract. Each call creates a fresh
    servicio (unique name → auto-approved as its first equipo), so two
    fixtures in the same hospital stay isolated tenants without
    needing sibling-approval plumbing."""
    return {
        "first_name": first_name,
        "email": email,
        "password": "supersecret1",
        "accept_terms": True,
        "hospital_id": hospital_id,
        "servicio_name": f"Servicio {suffix}",
        "equipo_name": f"Equipo {suffix}",
    }


@pytest.fixture
def auth_client(client, unique_email, cnh_hospital):
    """Sign up a fresh equipo + admin and return (client, headers, info).

    The equipo lives under the shared test hospital in its own
    auto-approved servicio. The equipo (tenant) slug is server-generated
    from equipo_name + servicio slug.
    """
    suffix = uuid.uuid4().hex[:8]
    r = client.post(
        "/api/signup",
        json=_signup_payload(
            first_name="Admin",
            email=unique_email,
            suffix=suffix,
            hospital_id=cnh_hospital,
        ),
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
        "hospital_id": cnh_hospital,
    }
    return client, headers, info


@pytest.fixture
def second_tenant(client, cnh_hospital):
    """Create a second equipo + admin (Bob); returns (headers, info).

    Same hospital as auth_client but a different servicio/tenant, so
    the two remain RLS-isolated tenants while sharing a hospital (the
    common shape for directory / DM / cross-servicio tests).
    """
    suffix = uuid.uuid4().hex[:8]
    r = client.post(
        "/api/signup",
        json=_signup_payload(
            first_name="Bob",
            email=f"bob-{suffix}@example.com",
            suffix=suffix,
            hospital_id=cnh_hospital,
        ),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    info = {
        "tenant_id": body["tenant"]["id"],
        "tenant_slug": body["tenant"]["slug"],
        "person_id": body["person"]["id"],
        "hospital_id": cnh_hospital,
    }
    return headers, info
