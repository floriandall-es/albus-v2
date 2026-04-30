"""Minimal SMTP-backed email service.

Behavior:
- If `EMAIL_ENABLED` is False, `send_email` logs the full message at INFO
  and does not touch the network. This is the default for tests and for any
  environment that hasn't explicitly opted in to SMTP.
- If True, opens an SMTP connection and sends. STARTTLS if `SMTP_USE_TLS`.
- Sending NEVER raises. Failures are logged at ERROR — the caller's HTTP
  flow must keep working even if the mail relay is down.

Templates live in `app.services.email_templates` to keep this module small.
"""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from app.core.config import settings

logger = logging.getLogger("app.email")


def send_email(
    to: str,
    subject: str,
    body_text: str,
    body_html: str | None = None,
) -> None:
    """Send an email or log it. Never raises."""
    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body_text)
    if body_html:
        msg.add_alternative(body_html, subtype="html")

    if not settings.email_enabled:
        logger.info(
            "Email disabled; would send to=%s subject=%s\n---\n%s\n---",
            to,
            subject,
            body_text,
        )
        return

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
            if settings.smtp_use_tls:
                smtp.starttls()
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(msg)
        logger.info("Email sent to=%s subject=%s", to, subject)
    except Exception as exc:  # pragma: no cover - exercised via monkeypatch tests
        logger.error("Failed to send email to=%s subject=%s err=%s", to, subject, exc)
