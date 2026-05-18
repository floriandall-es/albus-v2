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
