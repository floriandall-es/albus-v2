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
    jwt_ttl_minutes: int = 60
    # TTL for the short-lived pre-auth token issued during the multi-tenant
    # login picker flow. 5 minutes is plenty for "user clicks a tenant card"
    # but tight enough that a leaked token isn't a long-term threat.
    pre_auth_ttl_minutes: int = 5
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

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
