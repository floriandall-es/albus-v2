import io
import os
import secrets
from datetime import date, timedelta

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from PIL import Image, UnidentifiedImageError
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.security import (
    create_email_change_token,
    decode_email_change_token,
    hash_password,
    verify_password,
)
from app.models import (
    Assignment,
    Category,
    Department,
    Membership,
    Person,
    RoleType,
    Schedule,
    Slot,
    SlotTeamRole,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.auth import (
    EmailChangeRequest,
    EmailChangeRequested,
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
    from app.services.person_name import compose_name

    name, first_name, last_name = compose_name(
        name=payload.name,
        first_name=payload.first_name,
        last_name=payload.last_name,
    )
    if not name:
        raise HTTPException(
            status_code=422,
            detail="Indica al menos el nombre",
        )
    ctx.person.name = name
    ctx.person.first_name = first_name
    ctx.person.last_name = last_name
    ctx.db.flush()
    return ctx.person


# ---------------------------------------------------------------------------
# Calendar export — one-shot .ics download of the member's own published
# shifts in a date range, optionally narrowed to a subset of slot ids.
# Members can import the file into Apple / Google / Outlook Calendar.
# ---------------------------------------------------------------------------

# Cap the export window. Two years is comfortably more than any realistic
# member ever asks for and keeps the response a handful of KB. Mostly
# this is a guardrail against a typo'd range pulling the world.
MAX_ICS_RANGE_DAYS = 366 * 2


@router.get("/me/shifts.ics")
def get_my_shifts_ics(
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    slot_ids: str | None = Query(
        default=None,
        description=(
            "Optional comma-separated list of slot ids to include. "
            "Omit to export every slot type the member is assigned to."
        ),
    ),
    ctx: RequestContext = Depends(get_current_context),
) -> Response:
    from app.services.ics import IcsEvent, build_member_calendar

    if date_to < date_from:
        raise HTTPException(
            status_code=400,
            detail="El rango está invertido: 'hasta' es anterior a 'desde'.",
        )
    if (date_to - date_from) > timedelta(days=MAX_ICS_RANGE_DAYS):
        raise HTTPException(
            status_code=400,
            detail="El rango es demasiado amplio (máximo 2 años).",
        )

    slot_id_filter: set[int] | None = None
    if slot_ids:
        try:
            slot_id_filter = {
                int(piece) for piece in slot_ids.split(",") if piece.strip()
            }
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="slot_ids debe ser una lista de enteros separados por comas.",
            ) from None
        # An empty parsed set means the caller filtered everything out
        # explicitly. Honour that by returning an empty calendar — saves
        # a round-trip + matches the user's mental model ("uncheck all
        # → empty file").
        if not slot_id_filter:
            slot_id_filter = set()

    # Only PUBLISHED schedules — drafts are admin-only. Joining via
    # Assignment.schedule_id keeps RLS happy (same tenant) and lets us
    # filter on status in one query.
    q = (
        ctx.db.query(Assignment, Slot, SlotTeamRole)
        .join(Schedule, Schedule.id == Assignment.schedule_id)
        .join(Slot, Slot.id == Assignment.slot_id)
        .outerjoin(SlotTeamRole, SlotTeamRole.id == Assignment.team_role_id)
        .filter(
            Assignment.tenant_id == ctx.tenant.id,
            Assignment.person_id == ctx.person.id,
            Assignment.date >= date_from,
            Assignment.date <= date_to,
            Schedule.status == "published",
        )
        .order_by(Assignment.date, Slot.position, Assignment.id)
    )
    rows = q.all()
    if slot_id_filter is not None:
        rows = [r for r in rows if r[0].slot_id in slot_id_filter]

    events = [
        IcsEvent(
            assignment_id=a.id,
            shift_date=a.date,
            slot_name=s.name,
            role_label=r.role_label if r is not None else None,
            start_time=s.start_time,
            end_time=s.end_time,
        )
        for (a, s, r) in rows
    ]

    # Person name preference: legacy `name` is always populated, but
    # first_name reads better in the calendar title when available.
    person_display = (
        ctx.person.first_name or ctx.person.name or ctx.person.email
    )
    # PRODID host + UID host. The UID's @host suffix only matters for
    # collision avoidance across distinct calendars; the public hostname
    # is the right anchor. Parse from public_base_url (e.g.
    # "https://trivu.net" → "trivu.net"). Falls back to "trivu.net" if
    # the env var is unset / malformed.
    from urllib.parse import urlparse
    host = urlparse(settings.public_base_url).hostname or "trivu.net"

    ics_text = build_member_calendar(
        events=events,
        tenant_name=ctx.tenant.name,
        person_name=person_display,
        host=host,
    )
    filename = _ics_filename(person_display, date_from, date_to)
    return Response(
        content=ics_text,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Calendars sometimes aggressively cache; nudge them to
            # re-fetch on the next manual re-download. (Subscription
            # URLs would set this differently; this is the one-shot
            # download path.)
            "Cache-Control": "no-store",
        },
    )


def _ics_filename(person: str, frm: date, to: date) -> str:
    # ASCII-safe slug — Content-Disposition with quoted filename plays
    # nicely with most clients only when ASCII. The export still
    # contains the full UTF-8 name inside the .ics body.
    slug_chars = []
    for ch in person.lower():
        if ch.isascii() and (ch.isalnum() or ch in "-_"):
            slug_chars.append(ch)
        elif ch == " ":
            slug_chars.append("-")
    slug = "".join(slug_chars).strip("-_") or "turnos"
    return f"turnos-{slug}-{frm.isoformat()}-{to.isoformat()}.ics"


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


@router.post("/me/email", response_model=EmailChangeRequested)
def change_email(
    payload: EmailChangeRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> EmailChangeRequested:
    """Start an email-change flow. The email is NOT swapped here —
    a JWT-bound confirmation link is sent to the new address. The
    user must open that link (= prove they control the new
    address) before the change is applied. Defends against
    post-compromise account hijack: an attacker who steals a
    session can't quietly rewrite the recovery email to their own.
    """
    if not verify_password(
        payload.current_password, ctx.person.hashed_password
    ):
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
    # Conflict pre-check. There's still a TOCTOU window between
    # this and the eventual confirm — the confirm endpoint re-checks
    # before applying — but rejecting here gives clearer immediate
    # feedback in the UI.
    other = (
        ctx.db.query(Person)
        .filter(func.lower(Person.email) == new_email, Person.id != ctx.person.id)
        .first()
    )
    if other is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe una cuenta con ese email",
        )

    token = create_email_change_token(
        person_id=ctx.person.id, new_email=new_email
    )
    confirm_url = (
        f"{settings.public_base_url.rstrip('/')}/confirm-email?token={token}"
    )

    # Lazy import keeps the email service / templates out of the
    # module load path, same pattern as the schedule reopen flow.
    from app.services.email import send_email
    from app.services.email_templates import email_change_confirm_email

    subject, body = email_change_confirm_email(
        recipient_name=ctx.person.name,
        new_email=new_email,
        current_email=ctx.person.email,
        confirm_url=confirm_url,
        ttl_hours=settings.email_change_ttl_hours,
    )
    send_email(to=new_email, subject=subject, body_text=body)

    return EmailChangeRequested(new_email=new_email, sent_to=new_email)


@router.post("/me/email/confirm", response_model=PersonOut)
def confirm_email_change(
    token: str,
    ctx: RequestContext = Depends(get_current_context),
) -> Person:
    """Apply the email change after the user clicks the confirmation
    link in the new address's inbox.

    The endpoint REQUIRES a logged-in session (Bearer) plus the
    token, and validates that the token's person_id matches the
    session's. Two reasons:
    - Belt + braces — the token alone proves address ownership;
      adding the session ensures only the original account holder
      can complete the change. A forwarded link, on its own, gets
      nothing.
    - The /me path naturally requires the session, so this is
      consistent with the rest of the user surface.
    """
    import jwt as _jwt

    try:
        payload = decode_email_change_token(token)
    except _jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=400, detail="El enlace de confirmación ha caducado"
        )
    except _jwt.InvalidTokenError:
        raise HTTPException(
            status_code=400, detail="Enlace de confirmación inválido"
        )
    if payload.get("person_id") != ctx.person.id:
        raise HTTPException(
            status_code=403,
            detail=(
                "Inicia sesión con la cuenta a la que pertenece el cambio "
                "y vuelve a abrir el enlace"
            ),
        )
    new_email = str(payload["new_email"]).strip().lower()
    if new_email == ctx.person.email:
        # Idempotent — the user opened the link twice, no-op.
        return ctx.person
    # Re-check uniqueness in case someone else claimed the email
    # between the request and the confirmation.
    other = (
        ctx.db.query(Person)
        .filter(func.lower(Person.email) == new_email, Person.id != ctx.person.id)
        .first()
    )
    if other is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe una cuenta con ese email",
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
