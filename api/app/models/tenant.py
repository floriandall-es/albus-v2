from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.hospital import Hospital
from app.models.servicio import Servicio


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
    # Joined-load so TenantOut.model_validate can read .servicio_name
    # without a second roundtrip — mirrors the hospital pattern just
    # above. Cheap join, one small row per tenant.
    servicio: Mapped["Servicio | None"] = relationship(
        "Servicio", lazy="joined"
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

    @property
    def servicio_name(self) -> str | None:
        return self.servicio.name if self.servicio else None
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
    # unlimited (the historical default). Only the requester is
    # charged a cambio at fulfilment — covering for a colleague no
    # longer burns the responder's quota (changed after launch on
    # customer feedback; see _swap_count_for_person_in_month in
    # routes/shift_swaps.py for the reasoning).
    max_swaps_per_member_per_month: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    # Migration 0084. Opt-in: when true, an accepted response moves
    # the offer into `pending_admin` and an admin must approve before
    # assignments swap. Default false preserves the historical
    # "requester decision is final" flow. The flag is read at *accept*
    # time, so toggling it mid-flight applies to whichever offers are
    # decided after the change.
    swap_requires_admin_approval: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
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
    # ---------------------------------------------------------------
    # Billing (migration 0080). See docs/billing-plan.md.
    #
    # The admin's Stripe Customer + Subscription, plus a flag for
    # which billing model the equipo runs on. The Subscription has
    # one or two Items depending on `billing_model`:
    #   - members_pay: 1 item (price_admin × 1)
    #   - team_pays:   2 items (price_admin × 1 + price_member × N)
    # N tracks active+activated members; reconciled by the billing
    # service on membership changes.
    #
    # `subscription_status` is NULL for tenants created before
    # billing went live; the grandfather migration flips them to
    # 'active' with a far-future `trial_end_at`.
    # ---------------------------------------------------------------
    stripe_customer_id: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    stripe_subscription_id: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    subscription_status: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    trial_end_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    billing_email: Mapped[str | None] = mapped_column(Text, nullable=True)
    # NIF / CIF for the Spanish IVA invoice. Collected via Stripe
    # Customer Portal at first card entry; we mirror it here for
    # convenience (e.g. showing it on /admin/billing without a
    # round-trip to Stripe).
    billing_tax_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 'members_pay' (default) or 'team_pays'. Picked at admin signup;
    # switchable from /admin/billing. CHECK enforced in the
    # migration.
    billing_model: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="members_pay",
        server_default="members_pay",
    )
