from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import create_access_token, hash_password, verify_password
from app.db.session import get_db, set_tenant
from app.models import Membership, Person, Tenant
from app.schemas.auth import AuthResponse, LoginRequest, SignupRequest

router = APIRouter()


@router.post("/signup", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def signup(payload: SignupRequest, db: Session = Depends(get_db)) -> AuthResponse:
    # Tenant slug uniqueness
    existing_tenant = db.query(Tenant).filter(Tenant.slug == payload.tenant_slug).first()
    if existing_tenant:
        raise HTTPException(status_code=409, detail="Tenant slug already taken")

    # Email uniqueness
    existing_person = db.query(Person).filter(Person.email == payload.email.lower()).first()
    if existing_person:
        raise HTTPException(status_code=409, detail="Email already registered")

    tenant = Tenant(slug=payload.tenant_slug, name=payload.tenant_name)
    db.add(tenant)
    db.flush()

    # Set RLS context now so we can INSERT into the tenant-scoped memberships
    # table. tenants/persons are not under RLS so the order before flush is fine.
    set_tenant(db, tenant.id)

    person = Person(
        email=payload.email.lower(),
        hashed_password=hash_password(payload.password),
        name=payload.person_name,
    )
    db.add(person)
    db.flush()

    membership = Membership(tenant_id=tenant.id, person_id=person.id, roles=["admin"])
    db.add(membership)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Conflict creating tenant/person")

    # Re-set tenant context for any post-commit refresh of RLS-scoped rows.
    set_tenant(db, tenant.id)
    db.refresh(tenant)
    db.refresh(person)
    db.refresh(membership)

    token = create_access_token(person_id=person.id, tenant_id=tenant.id, roles=membership.roles)
    return AuthResponse(
        access_token=token,
        tenant=tenant,  # type: ignore[arg-type]
        person=person,  # type: ignore[arg-type]
        memberships=[membership],  # type: ignore[list-item]
    )


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> AuthResponse:
    person = db.query(Person).filter(Person.email == payload.email.lower()).first()
    if not person or not verify_password(payload.password, person.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    tenant = db.query(Tenant).filter(Tenant.slug == payload.tenant_slug).first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Now that we know the target tenant, set RLS context so the membership
    # query below is allowed.
    set_tenant(db, tenant.id)

    membership = (
        db.query(Membership)
        .filter(Membership.tenant_id == tenant.id, Membership.person_id == person.id)
        .first()
    )
    if not membership:
        raise HTTPException(status_code=403, detail="Person is not a member of this tenant")

    # Memberships across all tenants for the person require leaving RLS scope.
    # We use a raw query that bypasses the policy via a SECURITY-DEFINER-style
    # path: temporarily reset and re-set. RLS only filters by tenant_id, so
    # to enumerate ALL of a person's memberships we'd need a function. For
    # Sprint 1 we return only the current tenant's membership; the
    # tenant-switcher UI will be wired up in a later sprint with a proper
    # SECURITY DEFINER function.
    all_memberships = [membership]

    token = create_access_token(person_id=person.id, tenant_id=tenant.id, roles=membership.roles)
    return AuthResponse(
        access_token=token,
        tenant=tenant,  # type: ignore[arg-type]
        person=person,  # type: ignore[arg-type]
        memberships=all_memberships,  # type: ignore[arg-type]
    )
