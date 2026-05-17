import io
import os
import secrets

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    UploadFile,
    status,
)
from PIL import Image, UnidentifiedImageError
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.security import hash_password, verify_password
from app.models import (
    Category,
    Department,
    Membership,
    Person,
    Pool,
    RoleType,
    Skill,
    Slot,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.auth import (
    EmailChangeRequest,
    MeResponse,
    PasswordChangeRequest,
    PersonOut,
    ProfileUpdateRequest,
    TenantSummaryCounts,
)

router = APIRouter()


@router.get("/me", response_model=MeResponse)
def me(ctx: RequestContext = Depends(get_current_context)) -> MeResponse:
    db = ctx.db
    tid = ctx.tenant.id
    # Defense in depth: both RLS (via set_tenant in get_current_context)
    # AND an explicit tenant_id filter on every query below. RLS is the
    # actual security gate; the explicit filter is a backstop that
    # would catch any accidental RLS misconfiguration before it leaks.
    # The two layers MUST agree — disagreement points at a config bug.
    memberships = (
        db.query(Membership)
        .filter(
            Membership.person_id == ctx.person.id,
            Membership.tenant_id == tid,
        )
        .all()
    )
    role_types = db.query(RoleType).filter(RoleType.tenant_id == tid).all()
    departments = (
        db.query(Department).filter(Department.tenant_id == tid).all()
    )

    counts = TenantSummaryCounts(
        categories=int(
            db.query(func.count(Category.id))
            .filter(Category.tenant_id == tid)
            .scalar()
            or 0
        ),
        pools=int(
            db.query(func.count(Pool.id))
            .filter(Pool.tenant_id == tid)
            .scalar()
            or 0
        ),
        skills=int(
            db.query(func.count(Skill.id))
            .filter(Skill.tenant_id == tid)
            .scalar()
            or 0
        ),
        slots=int(
            db.query(func.count(Slot.id))
            .filter(Slot.tenant_id == tid)
            .scalar()
            or 0
        ),
    )

    return MeResponse(
        person=ctx.person,  # type: ignore[arg-type]
        current_tenant=ctx.tenant,  # type: ignore[arg-type]
        memberships=memberships,  # type: ignore[arg-type]
        role_types=role_types,  # type: ignore[arg-type]
        departments=departments,  # type: ignore[arg-type]
        counts=counts,
    )


# ---------------------------------------------------------------------------
# Profile self-management. All three endpoints act on ctx.person — the
# logged-in user — and don't require any specific role.
# ---------------------------------------------------------------------------


@router.put("/me/profile", response_model=PersonOut)
def update_profile(
    payload: ProfileUpdateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> Person:
    ctx.person.name = payload.name.strip()
    ctx.db.flush()
    return ctx.person


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChangeRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    if not verify_password(payload.current_password, ctx.person.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Contraseña actual incorrecta",
        )
    if payload.new_password == payload.current_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La contraseña nueva debe ser distinta",
        )
    ctx.person.hashed_password = hash_password(payload.new_password)
    ctx.db.flush()


@router.post("/me/email", response_model=PersonOut)
def change_email(
    payload: EmailChangeRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> Person:
    if not verify_password(payload.current_password, ctx.person.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Contraseña actual incorrecta",
        )
    new_email = payload.new_email.strip().lower()
    if new_email == ctx.person.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El email nuevo es igual al actual",
        )
    ctx.person.email = new_email
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe una cuenta con ese email",
        )
    return ctx.person


# ---------------------------------------------------------------------------
# Avatar upload + delete
# ---------------------------------------------------------------------------

# Resize to 128x128 — small enough to be served quickly, big enough for
# anywhere we render avatars (the schedule grid uses 20px, /me/settings
# shows a 64px preview).
AVATAR_TARGET_SIZE = 128
AVATAR_MAX_BYTES = 5 * 1024 * 1024  # 5 MB hard cap on the uploaded file
AVATAR_ALLOWED_MIMES = {"image/jpeg", "image/png", "image/webp"}


def _path_for_filename(name: str) -> str:
    return os.path.join(settings.avatars_dir, name)


def _url_for_filename(name: str) -> str:
    # Browser-facing path. Caddy / api proxy resolves this back to the
    # StaticFiles mount on the api container.
    return f"/api/avatars/{name}"


def _filename_from_url(url: str) -> str | None:
    """Extract the bare filename so we can unlink the local file. Returns
    None if the URL doesn't look like one of ours (defensive — never
    blow up if someone hand-edited the DB)."""
    prefix = "/api/avatars/"
    if not url.startswith(prefix):
        return None
    name = url[len(prefix):]
    if "/" in name or ".." in name:
        return None
    return name


@router.post("/me/avatar", response_model=PersonOut)
async def upload_avatar(
    file: UploadFile = File(...),
    ctx: RequestContext = Depends(get_current_context),
) -> Person:
    if file.content_type not in AVATAR_ALLOWED_MIMES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Formato no soportado. Usa JPEG, PNG o WebP.",
        )
    raw = await file.read()
    if len(raw) == 0:
        raise HTTPException(status_code=400, detail="Archivo vacío")
    if len(raw) > AVATAR_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="La imagen supera el tamaño máximo (5 MB)",
        )

    # Decode + center-crop to a square + resize to 128x128. Convert any
    # incoming mode (P, RGBA, etc.) to RGB so JPEG encoding is clean.
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except UnidentifiedImageError:
        raise HTTPException(
            status_code=400, detail="No se pudo leer la imagen"
        )
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    elif img.mode == "RGBA":
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        img = bg

    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    img = img.resize(
        (AVATAR_TARGET_SIZE, AVATAR_TARGET_SIZE), Image.Resampling.LANCZOS
    )

    os.makedirs(settings.avatars_dir, exist_ok=True)

    # Remove the previous file (if any) before swapping in the new one.
    if ctx.person.avatar_url:
        prev = _filename_from_url(ctx.person.avatar_url)
        if prev:
            try:
                os.remove(_path_for_filename(prev))
            except FileNotFoundError:
                pass

    new_name = f"{ctx.person.id}-{secrets.token_hex(8)}.jpg"
    out_path = _path_for_filename(new_name)
    img.save(out_path, "JPEG", quality=85, optimize=True)

    ctx.person.avatar_url = _url_for_filename(new_name)
    ctx.db.flush()
    return ctx.person


@router.delete("/me/avatar", status_code=status.HTTP_204_NO_CONTENT)
def delete_avatar(
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    if ctx.person.avatar_url is None:
        return
    prev = _filename_from_url(ctx.person.avatar_url)
    ctx.person.avatar_url = None
    ctx.db.flush()
    if prev:
        try:
            os.remove(_path_for_filename(prev))
        except FileNotFoundError:
            pass
