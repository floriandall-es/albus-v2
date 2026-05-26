from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.hospital import Hospital


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Sprint 28 / migration 0051: optional parent hospital. NULL =
    # standalone tenant (the historical default and what every
    # pre-0051 tenant is). Non-null = this tenant is one department
    # of a hospital — see Hospital model + signup find-or-create.
    hospital_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("hospitals.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Joined-load so TenantOut.model_validate can read .hospital_name
    # without a second roundtrip. lazy="joined" because every
    # serialization needs it and the join is cheap (single small row).
    hospital: Mapped["Hospital | None"] = relationship(
        "Hospital", lazy="joined"
    )
    # Equipos redesign (migration 0069): the Servicio this Equipo
    # belongs to. NULL today only for legacy tenants that don't have
    # a hospital_id either (pre-sprint-28). Becomes NOT NULL in a
    # follow-up migration after operator data cleanup. Every signed-
    # up tenant after Phase D requires a servicio_id.
    servicio_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("servicios.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    # What this Equipo exposes to other Equipos in its Servicio:
    #   'none'     → nothing (default for new signups).
    #   'selected' → only slots flagged shared_with_servicio=true.
    #   'full'     → every slot's assignments (read-only).
    # Enforced by a CHECK constraint in the migration.
    share_policy: Mapped[str] = mapped_column(
        String(16), nullable=False, default="none", server_default="none"
    )
    # 'pending' = waiting for a sibling admin in the same Servicio
    # to approve. 'approved' = visible in the Servicio timeline and
    # eligible for cross-tenant meeting invitations. The first
    # tenant in a brand-new Servicio is auto-approved; subsequent
    # ones start as 'pending' (see signup route in Phase C).
    approval_state: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="approved",
        server_default="approved",
    )

    @property
    def hospital_name(self) -> str | None:
        return self.hospital.name if self.hospital else None
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
    # Legacy column kept for backward compatibility with existing DB
    # rows; the sub-equipos / Groups machinery was dropped in Phase E.
    # Always False on new tenants going forward.
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
