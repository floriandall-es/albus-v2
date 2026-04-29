from dataclasses import dataclass
from typing import Generator

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.db.session import SessionLocal, set_tenant
from app.models import Membership, Person, Tenant


@dataclass
class RequestContext:
    db: Session
    person: Person
    tenant: Tenant
    membership: Membership


def get_db_raw() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_context(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db_raw),
) -> Generator[RequestContext, None, None]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_access_token(token)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    person_id = payload.get("person_id")
    tenant_id = payload.get("tenant_id")
    if not person_id or not tenant_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed token")

    # Verify membership exists (without RLS — query unscoped tables/PKs).
    person = db.get(Person, person_id)
    tenant = db.get(Tenant, tenant_id)
    if not person or not tenant:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown identity")

    # Set RLS context for this request's transaction.
    set_tenant(db, tenant_id)

    membership = (
        db.query(Membership)
        .filter(Membership.tenant_id == tenant_id, Membership.person_id == person_id)
        .first()
    )
    if not membership:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No membership for tenant")

    try:
        yield RequestContext(db=db, person=person, tenant=tenant, membership=membership)
        db.commit()
    except Exception:
        db.rollback()
        raise
