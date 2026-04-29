from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app.models import Person, Pool, PoolMembership
from app.routes.deps import RequestContext, get_current_context
from app.schemas.pool import (
    PoolCreate,
    PoolDetailOut,
    PoolMemberAddRequest,
    PoolMemberOut,
    PoolOut,
    PoolUpdate,
)

router = APIRouter()


def _get_or_404(ctx: RequestContext, pool_id: int) -> Pool:
    obj = ctx.db.get(Pool, pool_id)
    if not obj or obj.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Pool not found")
    return obj


def _serialize(ctx: RequestContext, p: Pool, *, member_count: int) -> PoolOut:
    return PoolOut(
        id=p.id,
        tenant_id=p.tenant_id,
        department_id=p.department_id,
        name=p.name,
        membership_mode=p.membership_mode,  # type: ignore[arg-type]
        equity_independent=p.equity_independent,
        member_count=member_count,
        created_at=p.created_at,
    )


@router.get("/pools", response_model=list[PoolOut])
def list_pools(ctx: RequestContext = Depends(get_current_context)) -> list[PoolOut]:
    rows = (
        ctx.db.query(Pool, func.count(PoolMembership.id))
        .outerjoin(PoolMembership, PoolMembership.pool_id == Pool.id)
        .group_by(Pool.id)
        .order_by(Pool.name)
        .all()
    )
    return [_serialize(ctx, p, member_count=int(c)) for p, c in rows]


@router.post("/pools", response_model=PoolOut, status_code=status.HTTP_201_CREATED)
def create_pool(
    payload: PoolCreate, ctx: RequestContext = Depends(get_current_context)
) -> PoolOut:
    obj = Pool(
        tenant_id=ctx.tenant.id,
        name=payload.name,
        department_id=payload.department_id,
        membership_mode=payload.membership_mode,
        equity_independent=payload.equity_independent,
    )
    ctx.db.add(obj)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Pool name already exists")
    ctx.db.refresh(obj)
    return _serialize(ctx, obj, member_count=0)


@router.get("/pools/{pool_id}", response_model=PoolDetailOut)
def get_pool(pool_id: int, ctx: RequestContext = Depends(get_current_context)) -> PoolDetailOut:
    obj = _get_or_404(ctx, pool_id)
    member_rows = (
        ctx.db.query(PoolMembership, Person)
        .join(Person, Person.id == PoolMembership.person_id)
        .filter(PoolMembership.pool_id == obj.id)
        .order_by(Person.name)
        .all()
    )
    members = [
        PoolMemberOut(
            id=pm.id,
            person_id=p.id,
            person_name=p.name,
            person_email=p.email,
            created_at=pm.created_at,
        )
        for pm, p in member_rows
    ]
    base = _serialize(ctx, obj, member_count=len(members))
    return PoolDetailOut(**base.model_dump(), members=members)


@router.put("/pools/{pool_id}", response_model=PoolOut)
def update_pool(
    pool_id: int, payload: PoolUpdate, ctx: RequestContext = Depends(get_current_context)
) -> PoolOut:
    obj = _get_or_404(ctx, pool_id)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(obj, k, v)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Pool name already exists")
    ctx.db.refresh(obj)
    count = (
        ctx.db.query(func.count(PoolMembership.id))
        .filter(PoolMembership.pool_id == obj.id)
        .scalar()
    )
    return _serialize(ctx, obj, member_count=int(count or 0))


@router.delete("/pools/{pool_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_pool(pool_id: int, ctx: RequestContext = Depends(get_current_context)) -> None:
    obj = _get_or_404(ctx, pool_id)
    ctx.db.delete(obj)
    ctx.db.flush()


@router.post(
    "/pools/{pool_id}/members",
    response_model=PoolMemberOut,
    status_code=status.HTTP_201_CREATED,
)
def add_pool_member(
    pool_id: int,
    payload: PoolMemberAddRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> PoolMemberOut:
    pool = _get_or_404(ctx, pool_id)
    person = ctx.db.get(Person, payload.person_id)
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    pm = PoolMembership(tenant_id=ctx.tenant.id, pool_id=pool.id, person_id=person.id)
    ctx.db.add(pm)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Person already in pool")
    ctx.db.refresh(pm)
    return PoolMemberOut(
        id=pm.id,
        person_id=person.id,
        person_name=person.name,
        person_email=person.email,
        created_at=pm.created_at,
    )


@router.delete(
    "/pools/{pool_id}/members/{person_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_pool_member(
    pool_id: int, person_id: int, ctx: RequestContext = Depends(get_current_context)
) -> None:
    pool = _get_or_404(ctx, pool_id)
    pm = (
        ctx.db.query(PoolMembership)
        .filter(PoolMembership.pool_id == pool.id, PoolMembership.person_id == person_id)
        .first()
    )
    if not pm:
        raise HTTPException(status_code=404, detail="Pool membership not found")
    ctx.db.delete(pm)
    ctx.db.flush()
