"""Plain-Python email templates.

Kept dead-simple on purpose. If we ever need richer templating we can swap
to jinja2; for v1 a couple of f-strings and Spanish month names are plenty.
"""

from __future__ import annotations

from datetime import datetime

SPANISH_MONTHS = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
]


def format_spanish_date(dt: datetime) -> str:
    return f"{dt.day} de {SPANISH_MONTHS[dt.month - 1]} de {dt.year}"


def invitation_email(
    *,
    person_name: str,
    tenant_name: str,
    accept_url: str,
    expires_at: datetime,
) -> tuple[str, str]:
    """Returns (subject, body_text)."""
    subject = f"Te han invitado a unirte a {tenant_name} en Trivu"
    expires_str = format_spanish_date(expires_at)
    body = (
        f"Hola {person_name},\n\n"
        f"{tenant_name} te ha invitado a unirte a su equipo en Trivu.\n\n"
        f"Acepta la invitación abriendo el siguiente enlace y eligiendo una contraseña:\n"
        f"{accept_url}\n\n"
        f"Este enlace caduca el {expires_str}.\n\n"
        f"Si no esperabas esta invitación, puedes ignorar este mensaje.\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


# ---------------------------------------------------------------------------
# Shift swap notifications
# ---------------------------------------------------------------------------


def swap_offer_created_email(
    *,
    recipient_name: str,
    requester_name: str,
    slot_name: str,
    shift_date: str,
    notes: str | None,
    app_url: str,
) -> tuple[str, str]:
    subject = f"{requester_name} pide cobertura para {slot_name} ({shift_date})"
    note_block = f"\nNota: {notes}\n" if notes else ""
    body = (
        f"Hola {recipient_name},\n\n"
        f"{requester_name} ha pedido cobertura para su turno:\n"
        f"  · {slot_name} — {shift_date}\n"
        f"{note_block}\n"
        f"Puedes ofrecerte para cubrirlo o proponer un cambio aquí:\n"
        f"{app_url}/me/swaps\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def swap_response_email(
    *,
    requester_name: str,
    responder_name: str,
    kind: str,
    slot_name: str,
    shift_date: str,
    swap_slot_name: str | None,
    swap_date: str | None,
    notes: str | None,
    app_url: str,
) -> tuple[str, str]:
    action = "se ofrece a cubrir" if kind == "cover" else "propone un cambio"
    subject = f"{responder_name} {action} tu turno de {shift_date}"
    swap_block = (
        f"\nTe ofrece a cambio: {swap_slot_name} — {swap_date}\n"
        if kind == "swap" and swap_slot_name and swap_date
        else ""
    )
    note_block = f"\nNota: {notes}\n" if notes else ""
    body = (
        f"Hola {requester_name},\n\n"
        f"{responder_name} {action} tu turno:\n"
        f"  · {slot_name} — {shift_date}\n"
        f"{swap_block}{note_block}\n"
        f"Revisa la propuesta y acéptala o recházala aquí:\n"
        f"{app_url}/me/swaps\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def swap_accepted_email(
    *,
    responder_name: str,
    requester_name: str,
    kind: str,
    slot_name: str,
    shift_date: str,
    app_url: str,
) -> tuple[str, str]:
    subject = (
        f"{requester_name} ha aceptado tu propuesta para {shift_date}"
    )
    explanation = (
        "Has aceptado cubrir su turno."
        if kind == "cover"
        else "El cambio se ha aplicado."
    )
    body = (
        f"Hola {responder_name},\n\n"
        f"{requester_name} ha aceptado tu propuesta para:\n"
        f"  · {slot_name} — {shift_date}\n\n"
        f"{explanation}\n"
        f"Consulta tu planificación actualizada:\n"
        f"{app_url}/me/turnos\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def swap_admin_notification_email(
    *,
    admin_name: str,
    requester_name: str,
    responder_name: str,
    kind: str,
    slot_name: str,
    shift_date: str,
    app_url: str,
) -> tuple[str, str]:
    action = "cubierto por" if kind == "cover" else "cambiado con"
    subject = f"Cambio de turno: {requester_name} → {responder_name} ({shift_date})"
    body = (
        f"Hola {admin_name},\n\n"
        f"Un cambio de turno se ha aplicado en tu equipo:\n"
        f"  · {slot_name} — {shift_date}\n"
        f"  · {requester_name} {action} {responder_name}\n\n"
        f"Histórico:\n{app_url}/admin/swaps\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


# ---------------------------------------------------------------------------
# Schedule reopen
# ---------------------------------------------------------------------------


def swap_cancelled_due_to_reopen_email(
    *,
    recipient_name: str,
    slot_name: str,
    shift_date: str,
    period_label: str,
    app_url: str,
) -> tuple[str, str]:
    """Sent to a member whose open swap offer got auto-cancelled
    because an admin reopened the schedule for edits."""
    subject = f"Tu cambio para {slot_name} ({shift_date}) ha sido cancelado"
    body = (
        f"Hola {recipient_name},\n\n"
        f"La planificación de {period_label} ha sido reabierta por un "
        f"administrador para hacer ajustes. Tu solicitud de cambio para:\n"
        f"  · {slot_name} — {shift_date}\n\n"
        f"se ha cancelado automáticamente. Cuando la planificación vuelva "
        f"a publicarse podrás solicitar el cambio de nuevo si todavía lo "
        f"necesitas.\n\n"
        f"{app_url}/me/swaps\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def schedule_reopened_member_email(
    *,
    recipient_name: str,
    period_label: str,
    app_url: str,
) -> tuple[str, str]:
    """Sent to every team member whose shifts disappeared from
    /me/turnos when an admin reopened the schedule. Reassures them
    the disappearance is temporary."""
    subject = f"Planificación de {period_label} reabierta para ajustes"
    body = (
        f"Hola {recipient_name},\n\n"
        f"Un administrador ha reabierto la planificación de "
        f"{period_label} para hacer correcciones. Mientras esté en "
        f"borrador no la verás en \"Mis turnos\". Recibirás un nuevo "
        f"aviso en cuanto se vuelva a publicar.\n\n"
        f"{app_url}/me/turnos\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def password_reset_email(
    *,
    recipient_name: str,
    reset_url: str,
    ttl_minutes: int,
) -> tuple[str, str]:
    """Sent when the user clicks "He olvidado mi contraseña" and
    enters their address. Body is intentionally generic — the
    address either belongs to a Trivu account (and the link
    works) or it doesn't (the address is the recipient's own
    inbox, no harm).

    1h TTL is the canonical window; we don't mention "single-use"
    because the binding-to-current-hash trick makes that the
    behaviour without needing to state it."""
    subject = "Restablece tu contraseña de Trivu"
    body = (
        f"Hola {recipient_name},\n\n"
        f"Has solicitado restablecer la contraseña de tu cuenta "
        f"Trivu. Abre este enlace para elegir una nueva:\n\n"
        f"{reset_url}\n\n"
        f"El enlace caduca en {ttl_minutes} minutos. Si no has sido "
        f"tú, ignora este correo — tu contraseña actual sigue "
        f"funcionando.\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def welcome_and_verify_email(
    *,
    recipient_name: str,
    recipient_first_name: str | None,
    tenant_name: str,
    confirm_url: str,
    app_base_url: str,
    ttl_hours: int,
) -> tuple[str, str]:
    """The single email a new admin gets after signup.

    Doubles as (a) welcome — "tu servicio está listo, esto es lo
    que sigue", and (b) email verification — "para mantener tu
    cuenta activa, confirma esta dirección".

    Sending two separate emails (welcome + verify) would just
    crowd the inbox; merging them is friendlier and the
    verification link still does its job. The /admin banner keeps
    nagging until they click, so the verify CTA isn't buried.
    """
    days = ttl_hours // 24
    when = (
        f"{days} días" if days >= 2 and ttl_hours % 24 == 0 else f"{ttl_hours} horas"
    )
    greeting_name = (recipient_first_name or recipient_name).strip() or "hola"
    base = app_base_url.rstrip("/")
    onboarding_url = f"{base}/onboarding/preset"
    terms_url = f"{base}/terms"
    privacy_url = f"{base}/privacy"

    subject = f"Bienvenido a Trivu — confirma tu email"
    body = (
        f"Hola {greeting_name},\n\n"
        f"Hemos creado «{tenant_name}» en Trivu y tú eres su "
        f"primer administrador. Gracias por probarnos.\n\n"
        f"Confirma tu correo\n"
        f"------------------\n"
        f"Para mantener la cuenta activa, abre este enlace desde "
        f"esta dirección:\n\n"
        f"{confirm_url}\n\n"
        f"Caduca en {when}. Si no fuiste tú, ignora este mensaje.\n\n"
        f"Qué sigue\n"
        f"---------\n"
        f"Si todavía no lo has hecho, sigue el asistente de "
        f"configuración para dejar tu servicio listo en unos "
        f"minutos:\n\n"
        f"  1. Elige el tipo de equipo (médico, quirúrgico u otro)\n"
        f"  2. Revisa las categorías profesionales\n"
        f"  3. Define las actividades (turnos) del equipo\n"
        f"  4. Invita a tus compañeros\n\n"
        f"Empieza aquí: {onboarding_url}\n\n"
        f"Para cualquier duda, responde a este correo.\n\n"
        f"— El equipo de Trivu\n\n"
        f"---\n"
        f"Términos: {terms_url}\n"
        f"Privacidad: {privacy_url}\n"
    )
    return subject, body


def email_change_confirm_email(
    *,
    recipient_name: str,
    new_email: str,
    current_email: str,
    confirm_url: str,
    ttl_hours: int,
) -> tuple[str, str]:
    """Sent to the NEW email address. Clicking the link is the only
    way to actually apply the change — until the user confirms, the
    account keeps its current email."""
    subject = "Confirma tu nuevo email de Trivu"
    body = (
        f"Hola {recipient_name},\n\n"
        f"Has solicitado cambiar el email de tu cuenta Trivu de "
        f"{current_email} a {new_email}. Para aplicar el cambio, "
        f"confirma desde esta dirección:\n\n"
        f"{confirm_url}\n\n"
        f"El enlace caduca en {ttl_hours} horas. Si no has sido tú "
        f"quien ha solicitado este cambio, ignora este correo — tu "
        f"cuenta sigue usando {current_email}.\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def schedule_published_member_email(
    *,
    recipient_name: str,
    period_label: str,
    app_url: str,
    is_republish: bool,
) -> tuple[str, str]:
    """Sent to every assigned team member when an admin publishes a
    schedule. `is_republish` is True when the schedule was previously
    reopened — the copy then explicitly closes the loop on the
    "reabierta para ajustes" notice the same members received earlier."""
    if is_republish:
        subject = f"Planificación de {period_label} publicada de nuevo"
        body = (
            f"Hola {recipient_name},\n\n"
            f"La planificación de {period_label} se ha vuelto a publicar "
            f"con los ajustes del administrador. Ya puedes ver tus turnos "
            f"actualizados en \"Mis turnos\".\n\n"
            f"{app_url}/me/turnos\n\n"
            f"— El equipo de Trivu\n"
        )
    else:
        subject = f"Planificación de {period_label} publicada"
        body = (
            f"Hola {recipient_name},\n\n"
            f"La planificación de {period_label} ya está disponible. "
            f"Consulta tus turnos en \"Mis turnos\".\n\n"
            f"{app_url}/me/turnos\n\n"
            f"— El equipo de Trivu\n"
        )
    return subject, body
