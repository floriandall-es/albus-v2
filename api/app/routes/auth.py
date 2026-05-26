import logging
import re
import secrets
import unicodedata
from datetime import datetime, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    create_access_token,
    create_email_verify_token,
    create_password_reset_token,
    create_pre_auth_token,
    decode_email_verify_token,
    decode_password_reset_token,
    decode_pre_auth_token,
    hash_password,
    password_fingerprint,
    verify_password,
)
from app.db.session import get_db, set_tenant
from app.models import Hospital, Membership, Person, Servicio, Tenant
from app.routes.deps import RequestContext, get_current_context
from app.schemas.auth import (
    AuthResponse,
    ForgotPasswordRequest,
    LoginRequest,
    PasswordResetRequest,
    PersonOut,
    SelectTenantRequest,
    SignupRequest,
    TenantPickerOption,
    TenantSelectionResponse,
)

router = APIRouter()


def _send_welcome_and_verify_email(person: Person, tenant_name: str) -> None:
    """Fire off the signup welcome-and-verify email to `person.email`.

    Single combined email: welcomes the new admin, lists the
    onboarding-wizard next steps, and asks them to click the
    verify link. Resend from the banner reuses this same template
    so a user who lost the original still gets the helpful "what
    to do next" pointers.

    Failure is swallowed inside send_email (we log + continue) — a
    transient SMTP outage shouldn't break the signup flow.
    """
    token = create_email_verify_token(person_id=person.id)
    confirm_url = (
        f"{settings.public_base_url.rstrip('/')}/confirm-email"
        f"?token={token}&kind=verify"
    )
    # Lazy imports — same pattern as the email-change flow, keeps
    # the templates / smtplib import out of module-load time.
    from app.services.email import send_email
    from app.services.email_templates import welcome_and_verify_email

    subject, body = welcome_and_verify_email(
        recipient_name=person.name,
        recipient_first_name=person.first_name,
        tenant_name=tenant_name,
        confirm_url=confirm_url,
        app_base_url=settings.public_base_url,
        ttl_hours=settings.email_verify_ttl_hours,
    )
    send_email(to=person.email, subject=subject, body_text=body)


def _notify_sibling_admins_of_pending(
    db: Session,
    pending_tenant: Tenant,
    servicio: Servicio,
    new_admin: Person,
) -> None:
    """Email every admin of an approved sibling tenant in the
    Servicio when a new equipo signs up as pending. The deep
    link drops them on /admin/equipos-pendientes where they can
    approve or decline.

    Cross-tenant lookup — we read sibling tenants + their admin
    memberships without going through RLS. AdminSessionLocal is
    overkill since tenants has no RLS, but memberships DOES, so
    we use it here to keep the query simple.
    """
    from app.db.session import AdminSessionLocal
    from app.services.email import send_email
    from app.services.email_templates import pending_equipo_approval_email

    admin_db = AdminSessionLocal()
    try:
        rows = admin_db.execute(
            text(
                """
                SELECT DISTINCT p.id, p.email, p.first_name, p.name
                FROM tenants t
                JOIN memberships m ON m.tenant_id = t.id
                JOIN persons p ON p.id = m.person_id
                WHERE t.servicio_id = :sid
                  AND t.approval_state = 'approved'
                  AND t.id <> :pid
                  AND 'admin' = ANY(m.roles)
                  AND m.disabled_at IS NULL
                  AND p.hashed_password IS NOT NULL
                """
            ),
            {"sid": servicio.id, "pid": pending_tenant.id},
        ).mappings().all()
    finally:
        admin_db.close()

    if not rows:
        return

    deep_link = (
        f"{settings.public_base_url.rstrip('/')}/admin/equipos-pendientes"
    )
    new_admin_full = new_admin.name
    new_admin_email = new_admin.email
    for r in rows:
        recipient_first = r.get("first_name") or r.get("name") or ""
        recipient_email = r.get("email")
        if not recipient_email:
            continue
        subject, body = pending_equipo_approval_email(
            recipient_first_name=recipient_first,
            new_equipo_name=pending_tenant.name,
            new_admin_name=new_admin_full,
            new_admin_email=new_admin_email,
            servicio_name=servicio.name,
            deep_link=deep_link,
        )
        try:
            send_email(recipient_email, subject, body)
        except Exception:  # noqa: BLE001
            # Per-recipient swallow so one bad address doesn't
            # block emails to the others.
            pass


# Maximum candidate-suffix attempts before falling back to a random hex tail.
# 50 is comfortably more than any realistic name collision count and keeps
# pathological cases (someone scripting "Hospital" 1000 times) from
# degenerating into thousands of SELECTs.
_SLUG_COLLISION_ATTEMPTS = 50
_SLUG_MAX_LEN = 64


def _slugify_tenant_name(name: str) -> str:
    """Normalize a tenant name into a URL-safe slug.

    Lowercase, strip diacritics, collapse non-alphanumerics into single dashes,
    trim edge dashes, cap at 64 chars. Returns empty string when the name has
    no alphanumerics at all (caller is responsible for falling back).
    """
    nfkd = unicodedata.normalize("NFD", name)
    no_accents = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    lowered = no_accents.lower()
    dashed = re.sub(r"[^a-z0-9]+", "-", lowered)
    trimmed = dashed.strip("-")
    return trimmed[:_SLUG_MAX_LEN]


def _generate_unique_slug(db: Session, tenant_name: str) -> str:
    """Produce a slug that's unique in the tenants table.

    Strategy: derive a candidate from tenant_name. If empty, fall back to
    `tenant-<hex>`. Otherwise try the candidate, then suffix `-2`, `-3`, …
    up to _SLUG_COLLISION_ATTEMPTS. If still colliding, append random hex.
    Slugs are stored lowercase, so case-insensitive uniqueness == lowercase
    uniqueness.
    """
    base = _slugify_tenant_name(tenant_name)
    if not base:
        return f"tenant-{secrets.token_hex(3)}"

    candidate = base
    if not _slug_exists(db, candidate):
        return candidate

    for n in range(2, _SLUG_COLLISION_ATTEMPTS + 1):
        suffix = f"-{n}"
        # Trim base so candidate stays within the 64-char cap, which the slug
        # column's pattern check enforces.
        truncated = base[: _SLUG_MAX_LEN - len(suffix)]
        candidate = f"{truncated}{suffix}"
        if not _slug_exists(db, candidate):
            return candidate

    # Pathological collision storm — fall back to a random tail. Still based
    # on the name so it's recognizable, just with entropy on the end.
    suffix = f"-{secrets.token_hex(3)}"
    truncated = base[: _SLUG_MAX_LEN - len(suffix)]
    return f"{truncated}{suffix}"


def _slug_exists(db: Session, slug: str) -> bool:
    return db.query(Tenant).filter(Tenant.slug == slug).first() is not None


@router.post("/signup", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def signup(payload: SignupRequest, db: Session = Depends(get_db)) -> AuthResponse:
    """Phase D.2 signup. Hospital → Servicio → Equipo, all anchored
    on the CNH catalog. Hospital MUST be a CNH-coded row;
    servicio is either chosen from the hospital's existing
    servicios (equipo starts pending → awaits sibling approval)
    or named fresh (equipo is auto-approved as the first one).
    """

    # Affirmative ToS / Privacy acceptance is mandatory. Reject before
    # any DB work.
    if not payload.accept_terms:
        raise HTTPException(
            status_code=422,
            detail=(
                "Debes aceptar los términos y la política de "
                "privacidad para crear la cuenta."
            ),
        )

    # Exactly one of (servicio_id, servicio_name) — the wizard
    # always sends one, but a hand-rolled request might try both
    # or neither.
    has_id = payload.servicio_id is not None
    has_name = bool((payload.servicio_name or "").strip())
    if has_id and has_name:
        raise HTTPException(
            status_code=422,
            detail="Indica un servicio existente O un nombre nuevo, no ambos.",
        )
    if not has_id and not has_name:
        raise HTTPException(
            status_code=422,
            detail="Indica un servicio existente o un nombre para crear uno nuevo.",
        )

    # Email uniqueness — checked before any tenant work so we don't
    # leave an orphan tenant if the email collides.
    existing_person = (
        db.query(Person).filter(Person.email == payload.email.lower()).first()
    )
    if existing_person:
        raise HTTPException(status_code=409, detail="Email already registered")

    # Hospital must be CNH-coded.
    hospital = db.get(Hospital, payload.hospital_id)
    if hospital is None or hospital.public_code is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "El hospital indicado no es válido. Elige uno de la "
                "lista oficial."
            ),
        )

    # ----------------------------------------------------------------
    # Servicio: find-or-create.
    # ----------------------------------------------------------------
    if has_id:
        servicio = db.get(Servicio, payload.servicio_id)
        if servicio is None or servicio.hospital_id != hospital.id:
            raise HTTPException(
                status_code=422,
                detail="Ese servicio no existe en este hospital.",
            )
        # Joining an existing servicio. Auto-approve only if there
        # are no approved equipos yet (otherwise the servicio is in
        # a stuck state and a new admin has no one to approve them).
        approved_siblings = (
            db.query(Tenant)
            .filter(
                Tenant.servicio_id == servicio.id,
                Tenant.approval_state == "approved",
            )
            .count()
        )
        approval_state = "approved" if approved_siblings == 0 else "pending"
    else:
        # Fresh servicio. The new equipo is the first → auto-approved.
        servicio_name = (payload.servicio_name or "").strip()
        servicio_slug = _slugify_tenant_name(servicio_name) or f"servicio-{secrets.token_hex(3)}"
        # Slug uniqueness is scoped per hospital. If already taken
        # within this hospital, append random suffix — we don't bother
        # with the gradient because servicio names within a hospital
        # are normally distinct.
        if (
            db.query(Servicio)
            .filter(
                Servicio.hospital_id == hospital.id,
                Servicio.slug == servicio_slug,
            )
            .first()
        ):
            servicio_slug = f"{servicio_slug[:55]}-{secrets.token_hex(3)}"
        servicio = Servicio(
            hospital_id=hospital.id,
            name=servicio_name,
            slug=servicio_slug,
        )
        db.add(servicio)
        db.flush()
        approval_state = "approved"

    # ----------------------------------------------------------------
    # Equipo (tenant). Slug is globally unique; derive from the
    # equipo name + servicio slug to keep collisions rare.
    # ----------------------------------------------------------------
    tenant_slug = _generate_unique_slug(
        db, f"{payload.equipo_name} {servicio.slug}"
    )
    tenant = Tenant(
        slug=tenant_slug,
        name=payload.equipo_name.strip(),
        country_code="ES",
        hospital_id=hospital.id,
        servicio_id=servicio.id,
        approval_state=approval_state,
        share_policy="none",
        transplants_enabled=payload.transplants_enabled,
    )
    db.add(tenant)
    db.flush()

    # RLS context for membership insert (tenants/persons are not
    # under RLS so the order before flush is fine).
    set_tenant(db, tenant.id)

    # Compose the Person. Single first_name+last_name (no legacy
    # single-field `name` in the new schema).
    first_name = payload.first_name.strip()
    last_name = (payload.last_name or "").strip() or None
    composed_name = f"{first_name} {last_name}".strip() if last_name else first_name
    if not composed_name:
        raise HTTPException(status_code=422, detail="Indica al menos el nombre")
    person = Person(
        email=payload.email.lower(),
        hashed_password=hash_password(payload.password),
        name=composed_name,
        first_name=first_name,
        last_name=last_name,
        terms_accepted_at=datetime.now(timezone.utc),
        terms_accepted_version=settings.terms_current_version,
    )
    db.add(person)
    db.flush()

    membership = Membership(
        tenant_id=tenant.id, person_id=person.id, roles=["admin"]
    )
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

    # Fire-and-forget welcome + verification email (combined).
    # Soft flow: the user can use the app immediately, but the
    # frontend shows a "verifica tu correo" banner until they
    # click the link in the email (which sets
    # person.email_verified_at).
    _send_welcome_and_verify_email(person, tenant.name)

    # Phase D.3: if the new equipo is pending approval, email every
    # admin of an approved sibling tenant so they know there's a
    # request waiting on /admin/equipos-pendientes. Fire-and-forget;
    # failures don't block the signup response.
    if tenant.approval_state == "pending":
        try:
            _notify_sibling_admins_of_pending(db, tenant, servicio, person)
        except Exception:  # noqa: BLE001
            logging.getLogger("app.auth").exception(
                "Failed to notify sibling admins for pending equipo %s",
                tenant.id,
            )

    return AuthResponse(
        access_token=token,
        tenant=tenant,  # type: ignore[arg-type]
        person=person,  # type: ignore[arg-type]
        memberships=[membership],  # type: ignore[list-item]
    )


def _list_person_memberships(db: Session, person_id: int) -> list[dict]:
    """Return every membership the person has, across all tenants.

    Bypasses the RLS policy on `memberships` via the SECURITY DEFINER function
    `list_person_memberships` (see migration 0016). This is the ONLY query
    where we cross tenant boundaries — the rest of the request lifecycle
    still goes through RLS once a tenant is chosen.
    """
    rows = db.execute(
        text(
            "SELECT membership_id, tenant_id, tenant_slug, tenant_name, roles "
            "FROM list_person_memberships(:pid)"
        ),
        {"pid": person_id},
    ).mappings().all()
    return [dict(r) for r in rows]


@router.post("/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    person = db.query(Person).filter(Person.email == payload.email.lower()).first()
    # Pendiente accounts (invited but never activated) have a NULL
    # hashed_password. Surface a distinct message so the invitee
    # knows to use the invitation link, not the login form.
    if person and person.hashed_password is None:
        raise HTTPException(
            status_code=401,
            detail=(
                "Tu cuenta aún no está activada. Abre el enlace de "
                "invitación que te enviamos por email para crear "
                "una contraseña."
            ),
        )
    if not person or not verify_password(payload.password, person.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    rows = _list_person_memberships(db, person.id)

    if not rows:
        raise HTTPException(status_code=401, detail="No tienes acceso a ningún servicio.")

    if len(rows) == 1:
        only = rows[0]
        tenant_id = only["tenant_id"]
        # Set RLS context so we can hydrate the membership/tenant ORM objects.
        set_tenant(db, tenant_id)
        tenant = db.get(Tenant, tenant_id)
        membership = db.get(Membership, only["membership_id"])
        if not tenant or not membership:
            # Should be impossible — function guarantees the rows exist.
            raise HTTPException(status_code=500, detail="Membership lookup inconsistency")
        token = create_access_token(
            person_id=person.id, tenant_id=tenant.id, roles=membership.roles
        )
        return AuthResponse(
            access_token=token,
            tenant=tenant,  # type: ignore[arg-type]
            person=person,  # type: ignore[arg-type]
            memberships=[membership],  # type: ignore[list-item]
        )

    # 2+ memberships → tenant picker flow. Issue a short-lived pre-auth token
    # that can ONLY be exchanged for a real access token via /select-tenant.
    pre_auth = create_pre_auth_token(person_id=person.id)
    options = [
        TenantPickerOption(id=r["tenant_id"], slug=r["tenant_slug"], name=r["tenant_name"])
        for r in rows
    ]
    return TenantSelectionResponse(
        requires_tenant_selection=True,
        pre_auth_token=pre_auth,
        person=person,  # type: ignore[arg-type]
        available_tenants=options,
    )


@router.post("/login/select-tenant", response_model=AuthResponse)
def select_tenant(payload: SelectTenantRequest, db: Session = Depends(get_db)) -> AuthResponse:
    try:
        claims = decode_pre_auth_token(payload.pre_auth_token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401, detail="Sesión de selección expirada, vuelve a iniciar sesión"
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=401, detail="Sesión de selección expirada, vuelve a iniciar sesión"
        )

    person_id = claims["person_id"]
    person = db.get(Person, person_id)
    if not person:
        raise HTTPException(status_code=401, detail="Sesión de selección inválida")

    # CRITICAL: Verify the chosen tenant is actually one this person belongs to.
    # We re-list memberships (instead of trusting the request) so a tampered
    # tenant_id can't grant access to a tenant the person isn't in.
    rows = _list_person_memberships(db, person_id)
    match = next((r for r in rows if r["tenant_id"] == payload.tenant_id), None)
    if not match:
        raise HTTPException(status_code=403, detail="No eres miembro de ese servicio")

    set_tenant(db, payload.tenant_id)
    tenant = db.get(Tenant, payload.tenant_id)
    membership = db.get(Membership, match["membership_id"])
    if not tenant or not membership:
        raise HTTPException(status_code=500, detail="Membership lookup inconsistency")

    token = create_access_token(
        person_id=person.id, tenant_id=tenant.id, roles=membership.roles
    )
    return AuthResponse(
        access_token=token,
        tenant=tenant,  # type: ignore[arg-type]
        person=person,  # type: ignore[arg-type]
        memberships=[membership],  # type: ignore[list-item]
    )


@router.post("/auth/verify-email", response_model=PersonOut)
def verify_email(token: str, db: Session = Depends(get_db)) -> Person:
    """Mark a person as email-verified.

    No bearer required — the token in the URL is the only proof of
    address ownership. The token's `kind` claim is checked by
    decode_email_verify_token, so an intercepted access token or
    email-change token can't be used here.

    Idempotent: clicking the link twice just returns the already-
    verified person row.
    """
    try:
        payload = decode_email_verify_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=400, detail="El enlace de verificación ha caducado"
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=400, detail="Enlace de verificación inválido"
        )
    person = db.get(Person, payload["person_id"])
    if not person:
        raise HTTPException(status_code=404, detail="Cuenta no encontrada")
    if person.email_verified_at is None:
        person.email_verified_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(person)
    return person


@router.post(
    "/auth/resend-verification", status_code=status.HTTP_204_NO_CONTENT
)
def resend_verification(
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Re-send the verification email to the caller's address.

    Auth-required (we use the bearer to know which mailbox to
    write to) and a no-op when already verified — silent success
    keeps the banner's "reenviar" button UX simple. Tenant name
    comes from the caller's current tenant context, matching
    what was used at signup.
    """
    if ctx.person.email_verified_at is not None:
        return  # already verified — silent no-op
    _send_welcome_and_verify_email(ctx.person, ctx.tenant.name)


@router.post(
    "/auth/forgot-password", status_code=status.HTTP_204_NO_CONTENT
)
def forgot_password(
    payload: ForgotPasswordRequest, db: Session = Depends(get_db)
) -> None:
    """Email a password-reset link to the address — IF it belongs to
    a Trivu account.

    Always returns 204 regardless of whether the address exists.
    Distinguishing the two cases would let an attacker enumerate
    registered accounts; staying silent costs us nothing (the user
    knows their own email, and if it's not registered they just
    don't get a link).

    SMTP failures are logged and swallowed by send_email — the
    public endpoint is intentionally lossy on the rare relay
    outage rather than leaking via a different status code.
    """
    email = payload.email.lower()
    person = db.query(Person).filter(Person.email == email).first()
    if not person:
        return  # silent — no enumeration
    # Pendiente (NULL password) — there's nothing to reset yet. Stay
    # silent rather than reveal that the address has been invited but
    # not activated. They need to use the invitation link, not the
    # reset flow.
    if person.hashed_password is None:
        return

    token = create_password_reset_token(
        person_id=person.id,
        password_fp=password_fingerprint(person.hashed_password),
    )
    reset_url = (
        f"{settings.public_base_url.rstrip('/')}/reset-password"
        f"?token={token}"
    )

    from app.services.email import send_email
    from app.services.email_templates import password_reset_email

    subject, body = password_reset_email(
        recipient_name=person.name,
        reset_url=reset_url,
        ttl_minutes=settings.password_reset_ttl_minutes,
    )
    send_email(to=person.email, subject=subject, body_text=body)


@router.post("/auth/reset-password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(
    payload: PasswordResetRequest, db: Session = Depends(get_db)
) -> None:
    """Set a new password using the token from the reset email.

    Token is invalidated implicitly: it carries a fingerprint of
    the CURRENT hash, and once we rotate the hash the fingerprint
    won't match the next request. No token table needed.

    Side effect: also marks the person email-verified. Clicking
    a link delivered to the mailbox is stronger proof than the
    original signup-time verification, so it's a free win to
    promote here if they hadn't already.
    """
    try:
        claims = decode_password_reset_token(payload.token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=400, detail="El enlace ha caducado"
        )
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=400, detail="Enlace inválido")

    person = db.get(Person, claims["person_id"])
    if not person:
        raise HTTPException(status_code=400, detail="Enlace inválido")
    # Pendiente — there's no current password to fingerprint against.
    # Should never happen (forgot-password also short-circuits these)
    # but guard defensively in case an old token survived.
    if person.hashed_password is None:
        raise HTTPException(status_code=400, detail="Enlace inválido")
    if password_fingerprint(person.hashed_password) != claims["fp"]:
        # Hash already rotated since the link was issued. Either the
        # link was used (single-use semantics) or the user changed
        # their password by some other route. Same opaque 400 either
        # way.
        raise HTTPException(
            status_code=400,
            detail="El enlace ya se ha usado. Solicita uno nuevo.",
        )
    person.hashed_password = hash_password(payload.new_password)
    if person.email_verified_at is None:
        person.email_verified_at = datetime.now(timezone.utc)
    db.commit()
