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
        for table in ("role_types", "departments", "memberships", "persons", "tenants"):
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
