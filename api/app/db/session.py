from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

engine = create_engine(settings.runtime_db_url, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

# Separate engine + session factory bound to the owner/superuser
# role (the same one Alembic uses). Used by background workers
# that need cross-tenant reads — RLS would otherwise hide rows
# from other tenants on the runtime role. Don't use this from
# request-scoped code; it bypasses tenant isolation.
_admin_engine = create_engine(
    settings.database_url, pool_pre_ping=True, future=True
)
AdminSessionLocal = sessionmaker(
    bind=_admin_engine, autoflush=False, autocommit=False, future=True
)


def get_db():
    """FastAPI dependency: yields a Session. Tenant context is set per-request
    by the auth dependency (see app.routes.deps.get_current_context)."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def set_tenant(db: Session, tenant_id: int) -> None:
    """Set the Postgres session variable that RLS policies read."""
    # SET LOCAL is transaction-scoped; ensure we're inside a transaction.
    if not db.in_transaction():
        db.begin()
    db.execute(text("SET LOCAL app.tenant_id = :tid"), {"tid": str(tenant_id)})


def set_person(db: Session, person_id: int) -> None:
    """Set the Postgres session variable for the caller's person id.

    Used by cross-tenant RLS predicates introduced in the equipos
    redesign (migration 0070). The `meetings` and
    `meeting_audience_persons` policies allow a caller to see rows
    in OTHER tenants when their person_id is in the audience — those
    policies read `app.person_id` to find the caller.

    Same SET LOCAL semantics as set_tenant: transaction-scoped.
    """
    if not db.in_transaction():
        db.begin()
    db.execute(text("SET LOCAL app.person_id = :pid"), {"pid": str(person_id)})


def clear_tenant(db: Session) -> None:
    db.execute(text("RESET app.tenant_id"))
