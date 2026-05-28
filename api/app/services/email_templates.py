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
