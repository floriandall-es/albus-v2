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
    subject = "Te han invitado a Albus"
    expires_str = format_spanish_date(expires_at)
    body = (
        f"Hola {person_name},\n\n"
        f"{tenant_name} te ha invitado a unirte a su equipo en Albus.\n\n"
        f"Acepta la invitación abriendo el siguiente enlace y eligiendo una contraseña:\n"
        f"{accept_url}\n\n"
        f"Este enlace caduca el {expires_str}.\n\n"
        f"Si no esperabas esta invitación, puedes ignorar este mensaje.\n"
    )
    return subject, body
