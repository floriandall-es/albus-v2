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


# ---------------------------------------------------------------------------
# HTML shell — shared by the transactional emails that carry a token URL.
# ---------------------------------------------------------------------------
# Token-bearing URLs (verify / accept / reset) are intrinsically long
# because the JWT lives in the query string, and Microsoft 365 wraps every
# href through safelinks.protection.outlook.com on inbox arrival —
# inflating them to ~600 chars. We can't strip the safelinks wrap, but we
# can stop printing the raw URL in the body. These helpers render a clean
# card with a CTA button instead.
#
# Plain inline styles only — Gmail strips <style> blocks and corporate
# mail filters often quarantine emails with external CSS. Tested with
# Outlook (web + native), Gmail, and Apple Mail.


def _html_button(href: str, label: str, *, outline: bool = False) -> str:
    """Inline-styled CTA button. Two variants: solid (primary) and
    outline (secondary). Brand teal (#0d9488)."""
    if outline:
        return (
            f"<a href='{href}' "
            f"style='display:inline-block;background:#ffffff;color:#0d9488;"
            f"text-decoration:none;padding:10px 20px;border-radius:8px;"
            f"font-weight:600;font-size:14px;border:1px solid #0d9488;'>"
            f"{label}"
            f"</a>"
        )
    return (
        f"<a href='{href}' "
        f"style='display:inline-block;background:#0d9488;color:#ffffff;"
        f"text-decoration:none;padding:12px 24px;border-radius:8px;"
        f"font-weight:600;font-size:14px;'>"
        f"{label}"
        f"</a>"
    )


def _html_shell(*, title: str, inner: str, footer_links: list[tuple[str, str]] | None = None) -> str:
    """Wrap inner HTML in the standard Trivu email card.

    `inner` is the card body — paragraphs, headings, buttons composed
    by the caller. `footer_links` is a list of (href, label) pairs
    rendered as a small centred line under the card (typically
    Términos · Privacidad).
    """
    footer = ""
    if footer_links:
        parts = [
            f"<a href='{href}' style='color:#9ca3af;text-decoration:underline;'>{label}</a>"
            for href, label in footer_links
        ]
        footer = (
            f"<p style='margin:16px 0 0;font-size:11px;color:#9ca3af;text-align:center;'>"
            + " · ".join(parts)
            + "</p>"
        )
    return (
        f"<!doctype html>"
        f"<html lang='es'><head><meta charset='utf-8'>"
        f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title></head>"
        f"<body style=\"margin:0;padding:0;background:#f5f7fa;"
        f"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
        f"color:#111827;line-height:1.55;\">"
        f"<div style='max-width:560px;margin:0 auto;padding:32px 20px;'>"
        f"<div style='background:#ffffff;border-radius:12px;padding:32px;"
        f"border:1px solid #e5e7eb;'>"
        + inner
        + "</div>"
        + footer
        + "</div></body></html>"
    )


def invitation_email(
    *,
    person_name: str,
    tenant_name: str,
    accept_url: str,
    expires_at: datetime,
) -> tuple[str, str, str]:
    """Returns (subject, body_text, body_html).

    Sent to every person an admin adds to their equipo, so it
    earns the HTML treatment — same pattern as the welcome
    email (clickable button instead of raw token URL).
    """
    subject = f"Te han invitado a unirte a {tenant_name} en Trivu"
    expires_str = format_spanish_date(expires_at)
    body_text = (
        f"Hola {person_name},\n\n"
        f"{tenant_name} te ha invitado a unirte a su equipo en Trivu.\n\n"
        f"Acepta la invitación abriendo el siguiente enlace y eligiendo una contraseña:\n"
        f"{accept_url}\n\n"
        f"Este enlace caduca el {expires_str}.\n\n"
        f"Si no esperabas esta invitación, puedes ignorar este mensaje.\n\n"
        f"— El equipo de Trivu\n"
    )
    inner = (
        f"<p style='margin:0 0 16px;font-size:15px;'>Hola {person_name},</p>"
        f"<p style='margin:0 0 24px;font-size:15px;'>"
        f"<strong>{tenant_name}</strong> te ha invitado a unirte a su equipo en Trivu."
        f"</p>"
        f"<p style='margin:0 0 20px;font-size:14px;color:#4b5563;'>"
        f"Acepta la invitación y elige una contraseña para empezar:"
        f"</p>"
        f"<p style='margin:0 0 20px;'>"
        + _html_button(accept_url, "Aceptar invitación →")
        + "</p>"
        f"<p style='margin:0 0 8px;font-size:12px;color:#6b7280;'>"
        f"El enlace caduca el {expires_str}."
        f"</p>"
        f"<p style='margin:0;font-size:12px;color:#6b7280;'>"
        f"Si no esperabas esta invitación, puedes ignorar este mensaje."
        f"</p>"
    )
    body_html = _html_shell(title=subject, inner=inner)
    return subject, body_text, body_html


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
# Admin approval / veto (migration 0084)
# ---------------------------------------------------------------------------


def swap_admin_pending_approval_email(
    *,
    admin_name: str,
    requester_name: str,
    responder_name: str,
    kind: str,
    slot_name: str,
    shift_date: str,
    app_url: str,
) -> tuple[str, str]:
    """Tenant enabled admin approval; requester just accepted a
    response. Tell every admin the cambio is parked in their queue
    and link them straight to /admin/swaps where the approve / veto
    buttons live."""
    action = "cubrir" if kind == "cover" else "cambiar"
    subject = (
        f"Aprobar cambio de turno: {requester_name} → {responder_name} "
        f"({shift_date})"
    )
    body = (
        f"Hola {admin_name},\n\n"
        f"Un cambio de turno está esperando tu aprobación:\n"
        f"  · {slot_name} — {shift_date}\n"
        f"  · {requester_name} quiere que {responder_name} lo {action}\n\n"
        f"Aprueba o deniega desde:\n{app_url}/admin/swaps\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def swap_vetoed_email(
    *,
    recipient_name: str,
    audience: str,
    admin_name: str,
    scope: str,
    slot_name: str,
    shift_date: str,
    notes: str | None,
    app_url: str,
) -> tuple[str, str]:
    """Admin vetoed a pending_admin swap; the requester, the
    responder, and (when scope='entire_offer') any other people
    who had open responses on the offer all get this so nobody is
    left wondering. `audience` picks the right opening
    ("Tu cambio…" vs "El cambio que ibas a cubrir…").

    `scope` decides the closing line:
      - 'response_only': the offer reopens, so the requester (or
        another responder) can keep trying.
      - 'entire_offer': the offer is closed for good."""
    if audience == "requester":
        opening = f"Tu solicitud de cambio para {slot_name} ({shift_date}) ha sido denegada por {admin_name}."
    elif audience == "responder":
        opening = f"El cambio para {slot_name} ({shift_date}) en el que ibas a participar ha sido denegado por {admin_name}."
    else:
        # other_responder: their offer to help is no longer relevant.
        opening = f"La solicitud de cambio para {slot_name} ({shift_date}) ha sido cerrada por {admin_name}."

    if scope == "response_only":
        closing = (
            "La solicitud sigue abierta — el solicitante puede aceptar "
            "otra respuesta o cancelarla."
        )
    else:
        closing = "La solicitud queda cerrada."

    notes_line = f"\nMotivo: {notes}\n" if notes else ""

    subject = f"Cambio denegado: {slot_name} ({shift_date})"
    body = (
        f"Hola {recipient_name},\n\n"
        f"{opening}\n"
        f"{notes_line}\n"
        f"{closing}\n\n"
        f"Consulta el detalle:\n{app_url}/me/swaps\n\n"
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


def pending_equipo_approval_email(
    *,
    recipient_first_name: str,
    new_equipo_name: str,
    new_admin_name: str,
    new_admin_email: str,
    servicio_name: str,
    deep_link: str,
) -> tuple[str, str]:
    """Sent to every approved sibling admin when a new equipo signs
    up against an existing Servicio. The recipient lands on
    /admin/equipos-pendientes via the deep link and approves or
    declines from there."""
    subject = (
        f"Nueva solicitud de equipo en {servicio_name}: {new_equipo_name}"
    )
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"{new_admin_name} ({new_admin_email}) ha creado un nuevo "
        f"equipo llamado «{new_equipo_name}» dentro del servicio "
        f"«{servicio_name}». Necesita tu aprobación (o la de otro "
        "administrador del servicio) antes de que aparezca en la "
        "vista conjunta del servicio o pueda invitar a tu equipo a "
        "reuniones.\n\n"
        f"Aprobar o rechazar:\n{deep_link}\n\n"
        "— Trivu"
    )
    return subject, body


def equipo_declined_email(
    *,
    recipient_first_name: str,
    equipo_name: str,
    servicio_name: str,
) -> tuple[str, str]:
    """Sent to the admin of an equipo whose join request was
    declined. We don't name the deciding admin — keeps the message
    neutral and doesn't put a person in the firing line."""
    subject = f"Tu solicitud para «{servicio_name}» no se ha aprobado"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"Tu solicitud para añadir el equipo «{equipo_name}» al "
        f"servicio «{servicio_name}» no ha sido aprobada por los "
        "administradores existentes.\n\n"
        "Tu cuenta sigue activa y puedes seguir usando Trivu, pero "
        "tu equipo no aparecerá en la vista conjunta del servicio. "
        "Si crees que ha sido un error, ponte en contacto con uno "
        "de los administradores del servicio.\n\n"
        "— Trivu"
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
) -> tuple[str, str, str]:
    """The single email a new admin gets after signup.

    Doubles as (a) welcome — "tu servicio está listo, esto es lo
    que sigue", and (b) email verification — "para mantener tu
    cuenta activa, confirma esta dirección".

    Sending two separate emails (welcome + verify) would just
    crowd the inbox; merging them is friendlier and the
    verification link still does its job. The /admin banner keeps
    nagging until they click, so the verify CTA isn't buried.

    Returns (subject, body_text, body_html). The HTML variant
    hides the long verification URL behind a clickable button —
    Outlook's safelinks wrapper still bloats the href, but the
    user no longer sees the raw 600-char string in the body.
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
    body_text = (
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
    inner = (
        f"<p style='margin:0 0 16px;font-size:15px;'>Hola {greeting_name},</p>"
        f"<p style='margin:0 0 24px;font-size:15px;'>"
        f"Hemos creado <strong>«{tenant_name}»</strong> en Trivu y tú eres su "
        f"primer administrador. Gracias por probarnos."
        f"</p>"
        f"<h2 style='margin:0 0 12px;font-size:17px;color:#111827;'>"
        f"Confirma tu correo"
        f"</h2>"
        f"<p style='margin:0 0 20px;font-size:14px;color:#4b5563;'>"
        f"Para mantener la cuenta activa, pulsa el botón:"
        f"</p>"
        f"<p style='margin:0 0 20px;'>"
        + _html_button(confirm_url, "Confirma tu correo →")
        + "</p>"
        f"<p style='margin:0 0 28px;font-size:12px;color:#6b7280;'>"
        f"Caduca en {when}. Si no fuiste tú, ignora este mensaje."
        f"</p>"
        f"<h2 style='margin:0 0 12px;font-size:17px;color:#111827;'>"
        f"Qué sigue"
        f"</h2>"
        f"<p style='margin:0 0 12px;font-size:14px;color:#4b5563;'>"
        f"Si todavía no lo has hecho, sigue el asistente de configuración "
        f"para dejar tu servicio listo en unos minutos:"
        f"</p>"
        f"<ol style='margin:0 0 20px;padding-left:20px;font-size:14px;color:#374151;'>"
        f"<li style='margin-bottom:4px;'>Elige el tipo de equipo (médico, quirúrgico u otro)</li>"
        f"<li style='margin-bottom:4px;'>Revisa las categorías profesionales</li>"
        f"<li style='margin-bottom:4px;'>Define las actividades (turnos) del equipo</li>"
        f"<li>Invita a tus compañeros</li>"
        f"</ol>"
        f"<p style='margin:0 0 24px;'>"
        + _html_button(onboarding_url, "Empieza aquí →", outline=True)
        + "</p>"
        f"<p style='margin:0 0 8px;font-size:13px;color:#6b7280;'>"
        f"Para cualquier duda, responde a este correo."
        f"</p>"
        f"<p style='margin:0;font-size:13px;color:#6b7280;'>"
        f"— El equipo de Trivu"
        f"</p>"
    )
    body_html = _html_shell(
        title=subject,
        inner=inner,
        footer_links=[(terms_url, "Términos"), (privacy_url, "Privacidad")],
    )
    return subject, body_text, body_html


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


def meeting_reminder_email(
    *,
    recipient_first_name: str,
    title: str,
    when_label: str,
    location: str | None,
    organizer_name: str | None,
    description: str | None,
    app_url: str,
) -> tuple[str, str]:
    """Migration 0066: fires N minutes before each meeting instance
    (N picked by the creator). Body is intentionally compact — the
    reminder's job is "you've got something soon", not to dump the
    whole agenda.

    `when_label` is the pre-formatted human time, e.g. "hoy a las
    10:00" / "mañana a las 10:00" / "el lunes a las 10:00 (en 1
    hora)". The worker builds it; the template just stitches.
    """
    subject = f"Recordatorio: {title} — {when_label}"
    location_line = f"Lugar: {location}\n" if location else ""
    organizer_line = (
        f"Organiza: {organizer_name}\n" if organizer_name else ""
    )
    description_block = (
        f"\n{description.strip()}\n" if description and description.strip() else ""
    )
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"Te recordamos que tienes esta reunión {when_label}:\n\n"
        f"  {title}\n"
        f"{location_line}"
        f"{organizer_line}"
        f"{description_block}\n"
        f"Más detalles en Trivu:\n"
        f"{app_url}\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def dm_unread_email(
    *,
    recipient_first_name: str,
    sender_display_name: str,
    body_preview: str,
    deep_link: str,
) -> tuple[str, str]:
    """Sprint 28 / DMs Phase 2B: sent when a DM arrives and the
    recipient isn't actively reading (5min window) AND we haven't
    emailed them about this conversation in the last 2h.

    Preview is the first ~200 chars of the message body; the link
    deep-jumps to the conversation. Subject names the sender so
    the recipient can triage from their inbox without opening."""
    subject = f"Tienes un mensaje de {sender_display_name} en Trivu"
    # Keep the preview readable but bounded — strip newlines so
    # the email body stays a single paragraph.
    preview_oneline = body_preview.replace("\r", " ").replace("\n", " ").strip()
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"{sender_display_name} te ha escrito en Trivu:\n\n"
        f"  \"{preview_oneline}\"\n\n"
        f"Responde abriendo la conversación:\n"
        f"{deep_link}\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


# ---------------------------------------------------------------------------
# Billing (migration 0080 / docs/billing-plan.md, chunk 14)
# ---------------------------------------------------------------------------
#
# Nine templates covering the full subscription lifecycle. Four go
# to admins (trial-ending × 3-day cadence, trial-ended, payment
# failed, sub canceled); four to members on members_pay (trial-
# ending × 3-day cadence, trial-ended, payment failed); plus one
# system mail for members whose tenant flipped to team_pays.
#
# All deep-links point at `/admin/billing` or `/me/billing` so the
# recipient lands on the page with the actionable button. No card
# numbers or PII leak into bodies — Stripe owns the invoice copy
# via the Customer Portal.


# ---- Admin: trial countdown ----------------------------------------------

def admin_trial_ending_email(
    *,
    recipient_first_name: str,
    days_remaining: int,
    trial_end_at: datetime,
    billing_url: str,
) -> tuple[str, str]:
    """Sent at days 23 / 27 / 29 of the admin trial. One template
    with a count down — three sends because by day 29 the calmer
    earlier nudges have failed to convert and we need a sharper
    "tomorrow" framing."""
    when = format_spanish_date(trial_end_at)
    if days_remaining <= 1:
        subject = "Tu prueba de Trivu termina mañana"
    else:
        subject = f"Tu prueba de Trivu termina en {days_remaining} días"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"Tu prueba de Trivu termina el {when} "
        f"({days_remaining} día{'s' if days_remaining != 1 else ''} restantes).\n\n"
        f"Para no perder acceso al panel ni a la planificación, "
        f"activa tu suscripción desde:\n"
        f"{billing_url}\n\n"
        f"Si decides no continuar, no tienes que hacer nada — la "
        f"cuenta se desactivará sola al terminar la prueba y nadie "
        f"te cobrará.\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def admin_trial_ended_email(
    *,
    recipient_first_name: str,
    billing_url: str,
) -> tuple[str, str]:
    """Sent on day 31, the morning after the trial expires. The
    admin is now read-only — no new planning generation, no
    invites, no publishing — but past planning stays visible."""
    subject = "Tu prueba de Trivu ha terminado"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"Tu prueba ha terminado. La planificación que ya has hecho "
        f"sigue accesible, pero no podrás generar planificaciones "
        f"nuevas ni invitar a más miembros hasta que actives la "
        f"suscripción.\n\n"
        f"Activa cuando quieras desde:\n"
        f"{billing_url}\n\n"
        f"Si necesitas más tiempo para decidir, contesta a este "
        f"correo y lo hablamos.\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def admin_payment_failed_email(
    *,
    recipient_first_name: str,
    billing_url: str,
) -> tuple[str, str]:
    """Sent when Stripe reports a failed charge on the tenant
    subscription. We don't include the amount — Stripe's own
    "your card was declined" mail already does that, and we
    want to focus on the action."""
    subject = "No hemos podido cobrar tu suscripción de Trivu"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"El último cargo de tu suscripción de Trivu no se ha "
        f"podido procesar. Lo intentaremos automáticamente en los "
        f"próximos días, pero si la tarjeta sigue rechazándose "
        f"perderás acceso al panel.\n\n"
        f"Actualiza tu método de pago aquí:\n"
        f"{billing_url}\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def admin_subscription_canceled_email(
    *,
    recipient_first_name: str,
    billing_url: str,
) -> tuple[str, str]:
    """Sent when the admin's subscription transitions to canceled
    (either by their own action via the Portal, or because every
    retry failed). Read-only state starts immediately."""
    subject = "Suscripción de Trivu cancelada"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"Tu suscripción de Trivu se ha cancelado. La planificación "
        f"existente sigue accesible en modo solo lectura, pero ya "
        f"no podrás generar planificaciones nuevas ni invitar a "
        f"más miembros.\n\n"
        f"Si fue un error o quieres volver, reactívala desde:\n"
        f"{billing_url}\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


# ---- Member: trial countdown (members_pay only) --------------------------

def member_trial_ending_email(
    *,
    recipient_first_name: str,
    days_remaining: int,
    trial_end_at: datetime,
    billing_url: str,
) -> tuple[str, str]:
    """Same 23 / 27 / 29-day cadence as the admin version, but
    pointing at /me/billing and framed for the individual
    member. Only fires under members_pay — under team_pays
    members don't have a personal subscription."""
    when = format_spanish_date(trial_end_at)
    if days_remaining <= 1:
        subject = "Tu prueba de Trivu termina mañana"
    else:
        subject = f"Tu prueba de Trivu termina en {days_remaining} días"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"Tu prueba personal de Trivu termina el {when} "
        f"({days_remaining} día{'s' if days_remaining != 1 else ''} restantes).\n\n"
        f"Si quieres seguir viendo tus turnos en el móvil, recibir "
        f"avisos de cambios y proponer permutas, activa la "
        f"suscripción (4,90 €/mes, sin permanencia) desde:\n"
        f"{billing_url}\n\n"
        f"Si prefieres volver al papel, no tienes que hacer nada — "
        f"tu acceso se cerrará solo al terminar la prueba y tu "
        f"admin seguirá imprimiendo la planificación como hasta "
        f"ahora.\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def member_trial_ended_email(
    *,
    recipient_first_name: str,
    billing_url: str,
) -> tuple[str, str]:
    """Sent the morning after the member's personal trial ends.
    The member loses app access; they're still in the planning,
    so the admin can keep scheduling them."""
    subject = "Tu prueba de Trivu ha terminado"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"Tu prueba ha terminado. Seguirás apareciendo en la "
        f"planificación de tu equipo, pero ya no podrás abrir la "
        f"app ni recibir avisos en el móvil.\n\n"
        f"Si quieres reactivarla (4,90 €/mes, sin permanencia):\n"
        f"{billing_url}\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


def member_payment_failed_email(
    *,
    recipient_first_name: str,
    billing_url: str,
) -> tuple[str, str]:
    """Sent when a member's personal subscription charge fails
    under members_pay. Doesn't apply under team_pays — the
    tenant sub is the one billed there."""
    subject = "No hemos podido cobrar tu suscripción de Trivu"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"El último cargo de tu suscripción de Trivu no se ha "
        f"podido procesar. Lo intentaremos otra vez en los "
        f"próximos días — si la tarjeta sigue fallando, perderás "
        f"el acceso a la app.\n\n"
        f"Actualiza tu método de pago aquí:\n"
        f"{billing_url}\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


# ---- System: billing model switch ----------------------------------------

def member_switched_to_team_pays_email(
    *,
    recipient_first_name: str,
    tenant_name: str,
    billing_url: str,
) -> tuple[str, str]:
    """Sent to every member whose tenant flipped from members_pay
    to team_pays. Their personal subscription has been canceled
    (and any unused balance prorated back to their card by
    Stripe); they keep access at no cost to them, covered by
    the team's new single invoice."""
    subject = f"{tenant_name} ahora paga tu acceso a Trivu"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"El administrador de {tenant_name} ha cambiado al modelo "
        f"\"el equipo paga por todos\". Tu suscripción personal "
        f"se ha cancelado automáticamente y, si te quedaba algo "
        f"pendiente de uso, Stripe lo devuelve a tu tarjeta en "
        f"los próximos días.\n\n"
        f"Sigues teniendo acceso completo a la app — ahora lo "
        f"cubre el equipo sin coste para ti.\n\n"
        f"Si quieres ver el detalle:\n"
        f"{billing_url}\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


# ---------------------------------------------------------------------------
# Admin promotion consent (migration 0087)
# ---------------------------------------------------------------------------


def admin_promotion_request_email(
    *,
    recipient_name: str,
    inviter_name: str,
    tenant_name: str,
    billing_model: str,
    accept_url: str,
    decline_url: str,
    ttl_hours: int,
) -> tuple[str, str]:
    """Sent to the target of an admin promotion (migration 0087).

    Under members_pay this is REQUIRED before we can change their
    Stripe price. Under team_pays the team card pays so consent is
    informational but the same template flows; the price line
    adapts so the recipient isn't told they'll be charged more
    when they won't be."""
    subject = f"{inviter_name} quiere promocionarte a admin en {tenant_name}"
    if billing_model == "members_pay":
        price_line = (
            "Tu suscripción de Trivu pasaría del precio Miembro al "
            "precio Admin a partir de la próxima factura. Puedes ver "
            "los importes desde tu Portal de Stripe."
        )
    else:
        price_line = (
            "El equipo paga tu acceso, así que tu tarjeta no recibirá "
            "ningún cargo adicional."
        )
    body = (
        f"Hola {recipient_name},\n\n"
        f"{inviter_name} te ha propuesto el rol de administrador en "
        f"{tenant_name}. Como admin podrás gestionar el equipo, las "
        f"actividades, las reglas y la planificación.\n\n"
        f"{price_line}\n\n"
        f"Aceptar: {accept_url}\n"
        f"Rechazar: {decline_url}\n\n"
        f"El enlace caduca en {ttl_hours // 24} días. Si no respondes "
        f"a tiempo, el admin puede volver a enviarte la solicitud.\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body


# ---------------------------------------------------------------------------
# Pulse weekly invite (migration 0090)
# ---------------------------------------------------------------------------


def pulse_invite_email(
    *,
    recipient_first_name: str,
    deep_link: str,
) -> tuple[str, str]:
    """Friday-afternoon fan-out from the pulse worker for anyone
    without a push subscription. Plain prose — the 5-question
    payload itself lives behind the link, not inline, so we can
    iterate copy without re-templating every email."""
    subject = "Pulso semanal de Trivu · 30 segundos"
    body = (
        f"Hola {recipient_first_name},\n\n"
        f"Esta semana, ¿cómo te ha ido? Tenemos 5 preguntas rápidas "
        f"sobre carga, descanso y reparto. Tu respuesta es siempre "
        f"agregada — el jefe ve la media del equipo, nunca quién "
        f"contestó qué.\n\n"
        f"Contestar (30 segundos): {deep_link}\n\n"
        f"Si esta semana no es buen momento, también está bien "
        f"saltarse: la próxima llegará el viernes que viene.\n\n"
        f"— El equipo de Trivu\n"
    )
    return subject, body
