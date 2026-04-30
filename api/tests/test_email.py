"""Email service: when EMAIL_ENABLED, smtplib is invoked with a properly
composed message; when disabled, no network is touched. Failures never raise."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.core.config import settings
from app.services.email import send_email


def test_send_email_disabled_logs_and_skips_smtp():
    prev = settings.email_enabled
    settings.email_enabled = False
    try:
        with patch("app.services.email.smtplib.SMTP") as smtp_cls:
            send_email("a@example.com", "Hi", "body")
            smtp_cls.assert_not_called()
    finally:
        settings.email_enabled = prev


def test_send_email_enabled_invokes_smtp_with_correct_message():
    prev = settings.email_enabled
    settings.email_enabled = True
    try:
        smtp_obj = MagicMock()
        cm = MagicMock()
        cm.__enter__.return_value = smtp_obj
        cm.__exit__.return_value = False
        with patch("app.services.email.smtplib.SMTP", return_value=cm) as smtp_cls:
            send_email("dest@example.com", "Asunto", "Cuerpo")
        smtp_cls.assert_called_once()
        smtp_obj.send_message.assert_called_once()
        msg = smtp_obj.send_message.call_args[0][0]
        assert msg["To"] == "dest@example.com"
        assert msg["Subject"] == "Asunto"
        assert "Cuerpo" in msg.get_content()
    finally:
        settings.email_enabled = prev


def test_send_email_swallows_smtp_failure():
    prev = settings.email_enabled
    settings.email_enabled = True
    try:
        with patch(
            "app.services.email.smtplib.SMTP",
            side_effect=ConnectionRefusedError("nope"),
        ):
            # Must not raise.
            send_email("dest@example.com", "x", "y")
    finally:
        settings.email_enabled = prev
