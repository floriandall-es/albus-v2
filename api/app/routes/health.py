"""Health probe.

`GET /api/health` is the liveness + readiness check a load balancer or
container healthcheck hits. It must reflect whether the service can
actually serve requests — not just "the process is up". So it checks:

  1. **DB connectivity** on the runtime (albus_app) engine — the path
     real requests use.
  2. **Migrations at head** — the applied alembic revision matches the
     head this deployed code expects. Catches the "new code, migration
     didn't run" half-deploy that otherwise 500s silently per-endpoint.

Returns **503** (not 200) when unhealthy so the probe can act on it.
Inability to *introspect* (can't read the alembic scripts) is treated
as "unknown", not a failure — we don't want our own bug to take the
service down.
"""

import logging
import os

from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.db.session import AdminSessionLocal, engine

router = APIRouter()
logger = logging.getLogger("app.health")

# api/ project root (where alembic.ini + alembic/ live): this file is
# api/app/routes/health.py, so two parents up.
_API_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

_SENTINEL = object()
_expected_head_cache: object = _SENTINEL


def _expected_head() -> str | None:
    """The migration revision this deployed code expects the DB to be
    at. Computed once from the bundled alembic scripts and cached — the
    files don't change at runtime. None if the scripts can't be read."""
    global _expected_head_cache
    if _expected_head_cache is _SENTINEL:
        try:
            cfg = Config()
            cfg.set_main_option(
                "script_location", os.path.join(_API_ROOT, "alembic")
            )
            _expected_head_cache = ScriptDirectory.from_config(
                cfg
            ).get_current_head()
        except Exception:
            logger.exception("health: could not read alembic head")
            _expected_head_cache = None
    return _expected_head_cache  # type: ignore[return-value]


@router.get("/health")
def health() -> JSONResponse:
    db_ok = True
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
        logger.exception("health: DB connectivity check failed")

    current_rev: str | None = None
    if db_ok:
        try:
            # alembic_version is owned by the migrations role; read it
            # via the admin engine since albus_app has no grant on it.
            with AdminSessionLocal() as adb:
                current_rev = adb.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar()
        except Exception:
            logger.exception("health: could not read alembic_version")

    expected = _expected_head()
    if not db_ok:
        migrations = "unknown"
        migrations_ok = False  # already unhealthy via db
    elif expected is None or current_rev is None:
        migrations = "unknown"
        migrations_ok = True  # don't fail health on inability to check
    elif current_rev == expected:
        migrations = "ok"
        migrations_ok = True
    else:
        migrations = "behind"
        migrations_ok = False

    healthy = db_ok and migrations_ok
    body = {
        "status": "ok" if healthy else "error",
        "db": "ok" if db_ok else "error",
        "migrations": migrations,
        "revision": current_rev,
        "expected_revision": expected,
    }
    return JSONResponse(content=body, status_code=200 if healthy else 503)
