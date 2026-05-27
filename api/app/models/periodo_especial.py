"""Periodo Especial + per-period snapshot/overrides.

A `PeriodoEspecial` defines a tenant-scoped date range during which
the scheduler applies a modified configuration — vacation, Christmas,
Semana Santa, etc. See docs/vacation-periods.md for the full design.

Two override mechanics live here:

  1. **Slot snapshots** (V.2.5 — migration 0077). Per-(period, slot)
     full duplicate of the slot config + its rules + the rules' child
     rows (weekly_pins, rotation_blocks, rotation_members, team_roles,
     team_role_categories, slot_categories, slot_allowed_persons).
     When a snapshot exists, the solver uses it in place of the
     slot's defaults for in-period dates. When no snapshot exists,
     defaults apply unchanged.

  2. **Succession + frequency cap deltas** (V.2 — migration 0076).
     Tenant-scoped cross-slot rules don't fit the snapshot framing,
     so we keep per-row delta overrides: relax days_after / severity,
     change max_count, disable for the period.

Both share the `PeriodoEspecial` parent. Per-row delta tables remain
for succession + caps. The V.1/V.2 slot+rule delta tables
(`slot_period_overrides`, `slot_rule_period_overrides`) were dropped
in 0077 — their UI was replaced by the snapshot model.

Non-overlap per tenant is enforced at the DB layer via a GiST
exclusion constraint; the model doesn't repeat it. The route layer
catches the IntegrityError and turns it into a friendly 422.
"""

from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class PeriodoEspecial(Base):
    """A defined "special" date range — typically a vacation or
    holiday window. The scheduler consults snapshots / overrides
    keyed on this period for any date that falls inside
    [start_date, end_date] (inclusive on both ends).
    """

    __tablename__ = "periodos_especiales"
    __table_args__ = (
        CheckConstraint(
            "end_date >= start_date",
            name="ck_periodos_especiales_date_order",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # User-facing label — "Verano 2026", "Navidad 2025", etc.
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Inclusive on both ends. A 1-day periodo has start == end.
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ---------------------------------------------------------------------------
# Slot snapshots (V.2.5 — migration 0077)
# ---------------------------------------------------------------------------


class SlotPeriodSnapshot(Base):
    """Per-(period, slot) snapshot of the slot's config. When a row
    exists, the solver uses these fields in place of the slot's
    defaults for in-period dates. When no row exists, defaults
    apply unchanged.

    `dismissed=true` short-circuits the rest of the fields — the
    slot doesn't run at all during the period. We still store the
    other fields so the admin can toggle dismissed off later
    without re-entering them.

    Note: there's no `name` column. The slot keeps its name across
    periods — a snapshot describes "Guardia during Verano 2026,"
    not "rename Guardia to something else." If that's needed later
    a column can be added.
    """

    __tablename__ = "slot_period_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "period_id", "slot_id", name="uq_slot_period_snapshots_period_slot"
        ),
        CheckConstraint(
            "days_applied IN ('all','weekdays','weekends_holidays','custom')",
            name="ck_slot_period_snapshots_days_applied",
        ),
        CheckConstraint(
            "staffing_mode IN ('single','multiple_same','team_composition')",
            name="ck_slot_period_snapshots_staffing_mode",
        ),
        CheckConstraint(
            "headcount >= 1",
            name="ck_slot_period_snapshots_headcount_positive",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("periodos_especiales.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    slot_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    dismissed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Slot config mirror.
    start_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    end_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    days_applied: Mapped[str] = mapped_column(String(32), nullable=False)
    custom_days_bitmap: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    staffing_mode: Mapped[str] = mapped_column(String(32), nullable=False)
    headcount: Mapped[int] = mapped_column(Integer, nullable=False)
    post_slot_rest: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    counts_for_equity: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    guardia_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # ORM relationships used by the upsert route + Pydantic
    # serializer in app/routes/periodos.py. Cascade is "save-update,
    # merge" only — the actual ON DELETE CASCADE happens at the DB
    # level via the ForeignKey definitions above, and the upsert
    # path deletes the snapshot row directly (which CASCADEs all
    # children in one statement). Setting delete-orphan here would
    # be redundant and could conflict with that bulk-delete.
    rules: Mapped[list["SlotPeriodSnapshotRule"]] = relationship(
        "SlotPeriodSnapshotRule",
        primaryjoin=(
            "SlotPeriodSnapshot.id == SlotPeriodSnapshotRule.snapshot_id"
        ),
        foreign_keys="SlotPeriodSnapshotRule.snapshot_id",
        lazy="selectin",
    )
    team_roles: Mapped[list["SlotPeriodSnapshotTeamRole"]] = relationship(
        "SlotPeriodSnapshotTeamRole",
        primaryjoin=(
            "SlotPeriodSnapshot.id == SlotPeriodSnapshotTeamRole.snapshot_id"
        ),
        foreign_keys="SlotPeriodSnapshotTeamRole.snapshot_id",
        lazy="selectin",
    )
    categories: Mapped[list["SlotPeriodSnapshotCategory"]] = relationship(
        "SlotPeriodSnapshotCategory",
        primaryjoin=(
            "SlotPeriodSnapshot.id == SlotPeriodSnapshotCategory.snapshot_id"
        ),
        foreign_keys="SlotPeriodSnapshotCategory.snapshot_id",
        lazy="selectin",
    )
    allowed_persons: Mapped[list["SlotPeriodSnapshotAllowedPerson"]] = relationship(
        "SlotPeriodSnapshotAllowedPerson",
        primaryjoin=(
            "SlotPeriodSnapshot.id == SlotPeriodSnapshotAllowedPerson.snapshot_id"
        ),
        foreign_keys="SlotPeriodSnapshotAllowedPerson.snapshot_id",
        lazy="selectin",
    )


class SlotPeriodSnapshotRule(Base):
    """Mirrors SlotRule for a snapshot. The snapshot can have a
    completely different set of rules than the default slot —
    add new ones, remove existing ones, change days_bitmap, etc.
    """

    __tablename__ = "slot_period_snapshot_rules"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_id",
            "position",
            name="uq_slot_period_snapshot_rules_snapshot_position",
        ),
        CheckConstraint(
            "strategy IN ('solver','fixed_weekly','rotation','manual')",
            name="ck_slot_period_snapshot_rules_strategy",
        ),
        CheckConstraint(
            "days_bitmap > 0 AND days_bitmap <= 127",
            name="ck_slot_period_snapshot_rules_bitmap_range",
        ),
        CheckConstraint(
            "weeks_per_position >= 1",
            name="ck_slot_period_snapshot_rules_weeks_per_position_positive",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_period_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    days_bitmap: Mapped[int] = mapped_column(Integer, nullable=False)
    strategy: Mapped[str] = mapped_column(String(16), nullable=False)
    anchor_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    weeks_per_position: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    weekly_pins: Mapped[list["SlotPeriodSnapshotRuleWeeklyPin"]] = relationship(
        "SlotPeriodSnapshotRuleWeeklyPin",
        primaryjoin=(
            "SlotPeriodSnapshotRule.id == SlotPeriodSnapshotRuleWeeklyPin.snapshot_rule_id"
        ),
        foreign_keys="SlotPeriodSnapshotRuleWeeklyPin.snapshot_rule_id",
        lazy="selectin",
    )
    rotation_blocks: Mapped[list["SlotPeriodSnapshotRuleRotationBlock"]] = relationship(
        "SlotPeriodSnapshotRuleRotationBlock",
        primaryjoin=(
            "SlotPeriodSnapshotRule.id == SlotPeriodSnapshotRuleRotationBlock.snapshot_rule_id"
        ),
        foreign_keys="SlotPeriodSnapshotRuleRotationBlock.snapshot_rule_id",
        lazy="selectin",
    )
    rotation_members: Mapped[list["SlotPeriodSnapshotRuleRotationMember"]] = relationship(
        "SlotPeriodSnapshotRuleRotationMember",
        primaryjoin=(
            "SlotPeriodSnapshotRule.id == SlotPeriodSnapshotRuleRotationMember.snapshot_rule_id"
        ),
        foreign_keys="SlotPeriodSnapshotRuleRotationMember.snapshot_rule_id",
        lazy="selectin",
    )


class SlotPeriodSnapshotRuleWeeklyPin(Base):
    """Mirrors SlotRuleWeeklyPin for a snapshot rule."""

    __tablename__ = "slot_period_snapshot_rule_weekly_pins"
    __table_args__ = (
        CheckConstraint(
            "weekday >= 0 AND weekday <= 6",
            name="ck_slot_period_snapshot_rule_weekly_pins_weekday_range",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_rule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_period_snapshot_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    weekday: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    person_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotPeriodSnapshotRuleRotationBlock(Base):
    """Mirrors SlotRuleRotationBlock for a snapshot rule."""

    __tablename__ = "slot_period_snapshot_rule_rotation_blocks"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_rule_id",
            "position",
            name="uq_slot_period_snapshot_rule_rotation_blocks_rule_pos",
        ),
        CheckConstraint(
            "days_bitmap > 0 AND days_bitmap <= 127",
            name="ck_slot_period_snapshot_rule_rotation_blocks_bitmap_range",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_rule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_period_snapshot_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    days_bitmap: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotPeriodSnapshotRuleRotationMember(Base):
    """Mirrors SlotRuleRotationMember for a snapshot rule. Same
    uniqueness shape (same person can't hold two positions; one
    position can have multiple members for team rotation)."""

    __tablename__ = "slot_period_snapshot_rule_rotation_members"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_rule_id",
            "person_id",
            name="uq_slot_period_snapshot_rule_rotation_members_rule_person",
        ),
        UniqueConstraint(
            "snapshot_rule_id",
            "position",
            "person_id",
            name="uq_slot_period_snapshot_rule_rotation_members_rule_pos_person",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_rule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_period_snapshot_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    person_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotPeriodSnapshotTeamRole(Base):
    """Mirrors SlotTeamRole for a snapshot."""

    __tablename__ = "slot_period_snapshot_team_roles"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_id",
            "role_label",
            name="uq_slot_period_snapshot_team_roles_snapshot_label",
        ),
        CheckConstraint(
            "headcount >= 1",
            name="ck_slot_period_snapshot_team_roles_headcount_positive",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_period_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role_label: Mapped[str] = mapped_column(String(255), nullable=False)
    headcount: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    categories: Mapped[list["SlotPeriodSnapshotTeamRoleCategory"]] = relationship(
        "SlotPeriodSnapshotTeamRoleCategory",
        primaryjoin=(
            "SlotPeriodSnapshotTeamRole.id == SlotPeriodSnapshotTeamRoleCategory.snapshot_team_role_id"
        ),
        foreign_keys="SlotPeriodSnapshotTeamRoleCategory.snapshot_team_role_id",
        lazy="selectin",
    )


class SlotPeriodSnapshotTeamRoleCategory(Base):
    """Mirrors SlotTeamRoleCategory for a snapshot team role."""

    __tablename__ = "slot_period_snapshot_team_role_categories"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_team_role_id",
            "category_id",
            name="uq_slot_period_snapshot_team_role_categories_role_cat",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_team_role_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(
            "slot_period_snapshot_team_roles.id", ondelete="CASCADE"
        ),
        nullable=False,
        index=True,
    )
    category_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("categories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotPeriodSnapshotCategory(Base):
    """Mirrors SlotCategory for a snapshot."""

    __tablename__ = "slot_period_snapshot_categories"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_id",
            "category_id",
            name="uq_slot_period_snapshot_categories_snapshot_category",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_period_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    category_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("categories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotPeriodSnapshotAllowedPerson(Base):
    """Mirrors SlotAllowedPerson for a snapshot."""

    __tablename__ = "slot_period_snapshot_allowed_persons"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_id",
            "person_id",
            name="uq_slot_period_snapshot_allowed_persons_snapshot_person",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_period_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    person_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ---------------------------------------------------------------------------
# Succession + frequency cap deltas (V.2 — migration 0076, kept)
# ---------------------------------------------------------------------------


class SlotSuccessionRulePeriodOverride(Base):
    """Per-(period, SlotSuccessionRule) override. Lets the admin
    relax a "X then no Y for N days" rule during vacation — shorten
    the gap, downgrade severity, or disable entirely.

    Note: same-day (`days_after = 0`) incompatibility CAN be relaxed
    to a wider window or a non-zero gap during the periodo. The
    semantics stay the same as the base rule's; only the value
    changes.
    """

    __tablename__ = "slot_succession_rule_period_overrides"
    __table_args__ = (
        UniqueConstraint(
            "period_id",
            "succession_rule_id",
            name="uq_slot_succession_rule_period_overrides_period_rule",
        ),
        CheckConstraint(
            "days_after_override IS NULL "
            "OR (days_after_override >= 0 AND days_after_override <= 14)",
            name="ck_slot_succession_rule_period_overrides_days_after",
        ),
        CheckConstraint(
            "severity_override IS NULL OR "
            "severity_override IN ('hard','soft')",
            name="ck_slot_succession_rule_period_overrides_severity",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("periodos_especiales.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    succession_rule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_succession_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    days_after_override: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    severity_override: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )
    disabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotFrequencyCapPeriodOverride(Base):
    """Per-(period, SlotFrequencyCap) override. Raise the per-window
    max (so a "2 guardias/month" cap can become "5/month" during
    summer), flip severity, or disable."""

    __tablename__ = "slot_frequency_cap_period_overrides"
    __table_args__ = (
        UniqueConstraint(
            "period_id",
            "cap_id",
            name="uq_slot_frequency_cap_period_overrides_period_cap",
        ),
        CheckConstraint(
            "max_count_override IS NULL OR max_count_override >= 0",
            name="ck_slot_frequency_cap_period_overrides_max_count",
        ),
        CheckConstraint(
            "severity_override IS NULL OR "
            "severity_override IN ('hard','soft')",
            name="ck_slot_frequency_cap_period_overrides_severity",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("periodos_especiales.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    cap_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_frequency_caps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    max_count_override: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    severity_override: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )
    disabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
