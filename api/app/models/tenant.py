from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str | None] = mapped_column(String(8), nullable=True)
    locale: Mapped[str | None] = mapped_column(String(16), nullable=True)
    country_code: Mapped[str | None] = mapped_column(String(8), nullable=True)
    region_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    onboarding_completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Onboarding template chosen on the new first wizard step.
    # One of: 'quirurgico' / 'medico' / 'otro' (validated by a CHECK
    # constraint in migration 0029). Null on tenants created before
    # the preset selector shipped — treated as "otro" by any code
    # that reads this for default-suggestion logic.
    preset_kind: Mapped[str | None] = mapped_column(
        String(32), nullable=True
    )
    # Answered yes/no on the signup form: "¿Vas a usar sub-equipos?".
    # Drives whether /admin Inicio shows a "Configura tus sub-equipos"
    # card. Admins who later change their mind can still create
    # groups via /admin/groups regardless of this flag.
    has_subteams: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Opt-in module flag for the transplant case log
    # (/admin/trasplantes + /api/transplants). False = the feature
    # is dormant: the sidebar entry hides and the API endpoints
    # 404. Set true at signup via the "¿Tu servicio realiza
    # trasplantes?" checkbox; the legacy migration also sets it
    # true for the alpha customer (a lung transplant service).
    transplants_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Sprint 28 / migration 0050: per-tenant cap on how many cambios
    # de turno each member can do per monthly schedule. Null =
    # unlimited (the historical default). When set, both the
    # requester and the accepted responder of a fulfilled swap
    # count toward the limit, scoped to the month of the original
    # assignment's date.
    max_swaps_per_member_per_month: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    # Explicit per-area "I'm done configuring this" flags, set by the
    # admin clicking "Marcar como completado" on each subpage. Drives
    # both the /admin Inicio checklist (which cards remain visible)
    # and the first-visit explanation banner inside each subpage.
    # Migration 0042 added these as nullable timestamps; existing
    # tenants stay NULL until their admin clicks through.
    setup_activities_completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    setup_rules_completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    setup_team_completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    setup_subteams_completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
