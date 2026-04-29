from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.models import Category
from app.routes.deps import RequestContext, get_current_context
from app.schemas.category import CategoryCreate, CategoryOut, CategoryUpdate

router = APIRouter()


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(ctx: RequestContext = Depends(get_current_context)) -> list[CategoryOut]:
    rows = ctx.db.query(Category).order_by(Category.level.asc().nulls_last(), Category.name).all()
    return [CategoryOut.model_validate(r) for r in rows]


@router.post("/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: CategoryCreate, ctx: RequestContext = Depends(get_current_context)
) -> CategoryOut:
    obj = Category(
        tenant_id=ctx.tenant.id,
        name=payload.name,
        level=payload.level,
        description=payload.description,
    )
    ctx.db.add(obj)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Category name already exists")
    ctx.db.refresh(obj)
    return CategoryOut.model_validate(obj)


def _get_or_404(ctx: RequestContext, category_id: int) -> Category:
    obj = ctx.db.get(Category, category_id)
    if not obj or obj.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Category not found")
    return obj


@router.get("/categories/{category_id}", response_model=CategoryOut)
def get_category(
    category_id: int, ctx: RequestContext = Depends(get_current_context)
) -> CategoryOut:
    return CategoryOut.model_validate(_get_or_404(ctx, category_id))


@router.put("/categories/{category_id}", response_model=CategoryOut)
def update_category(
    category_id: int,
    payload: CategoryUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> CategoryOut:
    obj = _get_or_404(ctx, category_id)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(obj, k, v)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Category name already exists")
    ctx.db.refresh(obj)
    return CategoryOut.model_validate(obj)


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    category_id: int, ctx: RequestContext = Depends(get_current_context)
) -> None:
    obj = _get_or_404(ctx, category_id)
    ctx.db.delete(obj)
    ctx.db.flush()
