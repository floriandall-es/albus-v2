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
    cors_origins: str = "http://localhost:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
