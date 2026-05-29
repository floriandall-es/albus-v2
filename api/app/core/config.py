from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Used by Alembic for migrations. Should be a superuser/owner role.
    database_url: str = "postgresql+psycopg2://albus:albus_dev_password@db:5432/albus"
    # Used by the FastAPI runtime. MUST be a non-superuser, NOBYPASSRLS role,
    # otherwise RLS policies won't isolate tenants. Defaults to database_url
    # only when explicitly unset (dev convenience), but the docker-compose
    # supplies a separate APP_DATABASE_URL.
    app_database_url: str | None = None

    @property
    def runtime_db_url(self) -> str:
        return self.app_database_url or self.database_url
    jwt_secret: str = "change-me-in-prod-this-is-only-for-dev"
    jwt_algorithm: str = "HS256"
    # 8 hours: long enough to cover a sit-down onboarding session
    # (signup → wizard → first day's planning) or a full hospital
    # shift, short enough that a stolen token has bounded value.
    # Override via JWT_TTL_MINUTES in the env. There's no refresh-
    # token flow yet; once this expires the user has to log in again.
    jwt_ttl_minutes: int = 60 * 8
    # HMAC key for the invitation token-lookup hash. Has to be set
    # in prod via INVITATION_LOOKUP_SECRET. If it ever rotates, all
    # pending invitations become inaccessible — recipients must be
    # re-sent fresh invites. Rotate alongside JWT_SECRET on a
    # compromise.
    invitation_lookup_secret: str = "change-me-in-prod-invite-lookup"
    # TTL for the short-lived pre-auth token issued during the multi-tenant
    # login picker flow. 5 minutes is plenty for "user clicks a tenant card"
    # but tight enough that a leaked token isn't a long-term threat.
    pre_auth_ttl_minutes: int = 5
    # TTL for the email-change confirmation link sent to the NEW
    # address. 24h matches typical "verify your email" UX (recipient
    # may read it on a phone, switch devices, etc.) while keeping the
    # exposure window short.
    email_change_ttl_hours: int = 24
    # TTL for the email-verification link sent on signup. 7 days
    # matches typical "click to verify" UX — long enough for the
    # admin to sign up Friday afternoon and confirm on Monday, but
    # short enough that abandoned signups stop showing as
    # legitimate-looking accounts within a sprint.
    email_verify_ttl_hours: int = 24 * 7
    # TTL for the password-reset link emailed by /forgot-password.
    # 1 hour is the canonical window — long enough for "open email
    # on phone, finish on laptop", short enough that a stolen
    # mailbox doesn't yield long-term reset capability.
    password_reset_ttl_minutes: int = 60
    # TTL for the admin promotion accept/decline link (migration
    # 0087). 14 days lets a vacationing member catch up to the
    # email; long enough not to be annoying, short enough that
    # the admin's mental model "they didn't reply, ping them again"
    # stays valid.
    admin_promotion_ttl_hours: int = 24 * 14

    # Current version string of the Terms of Service + Privacy
    # Policy. Stored on persons.terms_accepted_version when a user
    # accepts; bumping this constant after a substantive update
    # makes existing acceptances "stale" and the frontend can
    # re-prompt. Keep this in sync with the actual /terms and
    # /privacy pages (web/src/app/terms, /privacy).
    terms_current_version: str = "1.0"
    cors_origins: str = "http://localhost:3000"
    # Used to build invite accept URLs. In dev this points at the web service
    # exposed on the host; in prod it's the public domain.
    public_base_url: str = "http://localhost:3030"

    # SMTP / email delivery. EMAIL_ENABLED=False means send_email() logs the
    # body at INFO level and does NOT touch the network — used in tests and
    # when SMTP isn't configured. When True, smtplib actually sends.
    smtp_host: str = "mailhog"
    smtp_port: int = 1025
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "Trivu <noreply@trivu.local>"
    smtp_use_tls: bool = False
    email_enabled: bool = False

    # CP-SAT solver budget. Bigger problems benefit from more time, but a
    # 30s ceiling keeps interactive "regenerate" from feeling broken.
    solver_max_seconds: int = 30
    solver_workers: int = 4

    # Directory where profile photos land. Mounted from a host volume in
    # prod (/srv/albus/avatars); in dev defaults to a sibling of the app.
    avatars_dir: str = "/app/avatars"

    # ---------------------------------------------------------------
    # Stripe Billing (migration 0080 / docs/billing-plan.md).
    # All four are filled in by the production .env once the Stripe
    # Dashboard side is configured. In dev they stay empty and the
    # billing code paths short-circuit without touching the network
    # (the helpers in app/services/stripe_client raise a clear
    # RuntimeError if called while unconfigured).
    # ---------------------------------------------------------------
    stripe_secret_key: str = ""
    # Webhook signing secret (whsec_…). The /api/stripe/webhook
    # handler verifies every request against this; mismatch → 400.
    stripe_webhook_secret: str = ""
    # The two recurring Prices created in the Stripe Dashboard at
    # Dashboard setup time. €29.90/mo and €4.90/mo respectively.
    stripe_price_admin: str = ""
    stripe_price_member: str = ""

    # ---------------------------------------------------------------
    # Web Push (migration 0089). VAPID keypair signs every push
    # request; the public key is also handed to the browser via
    # GET /api/push/vapid-public-key so the SW can subscribe.
    # Subject is a mailto: or https:// URI the push services (FCM,
    # Mozilla autopush, Apple) email/call if Trivu's traffic gets
    # flagged for abuse. Generate via
    # `npx web-push generate-vapid-keys`.
    #
    # All three default to empty so the API still boots without them
    # — push code paths short-circuit silently when missing (see
    # app/services/push.py::is_configured). In prod they MUST be set
    # via /srv/albus/.env.
    # ---------------------------------------------------------------
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
