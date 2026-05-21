from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SlotRule(Base):
    __tablename__ = "slot_rules"
    __table_args__ = (
        CheckConstraint(
            "strategy IN ('solver','fixed_weekly','rotation','manual')",
            name="ck_slot_rules_strategy",
        ),
        CheckConstraint(
            "days_bitmap > 0 AND days_bitmap <= 127",
            name="ck_slot_rules_bitmap_range",
        ),
        CheckConstraint(
            "weeks_per_position >= 1",
            name="ck_slot_rules_weeks_per_position_positive",
        ),
        UniqueConstraint("slot_id", "position", name="uq_slot_rules_slot_position"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slot_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("slots.id", ondelete="CASCADE"), nullable=False, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    days_bitmap: Mapped[int] = mapped_column(Integer, nullable=False)
    strategy: Mapped[str] = mapped_column(String(16), nullable=False)
    anchor_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Rotation cycle multiplier. Each position holds the slot for
    # this many weeks before the rotation advances. Default 1 is
    # the historical behaviour (one position per week step). Only
    # consulted when strategy='rotation'; ignored for other
    # strategies. See scheduler.rotation_persons_for for the maths.
    weeks_per_position: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotRuleWeeklyPin(Base):
    __tablename__ = "slot_rule_weekly_pins"
    __table_args__ = (
        CheckConstraint(
            "weekday >= 0 AND weekday <= 6",
            name="ck_slot_rule_weekly_pins_weekday_range",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    weekday: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    person_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotRuleRotationBlock(Base):
    __tablename__ = "slot_rule_rotation_blocks"
    __table_args__ = (
        CheckConstraint(
            "days_bitmap > 0 AND days_bitmap <= 127",
            name="ck_slot_rule_rotation_blocks_bitmap_range",
        ),
        UniqueConstraint(
            "rule_id", "position", name="uq_slot_rule_rotation_blocks_rule_position"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    days_bitmap: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotRuleRotationMember(Base):
    __tablename__ = "slot_rule_rotation_members"
    # Migration 0015 dropped UNIQUE(rule_id, position) so multiple people
    # can share a rotation position (team rotation). UNIQUE(rule_id,
    # person_id) survives — same person can't hold two positions in one
    # rotation. UNIQUE(rule_id, position, person_id) blocks double-adding
    # the same person to the same position.
    __table_args__ = (
        UniqueConstraint(
            "rule_id", "person_id", name="uq_slot_rule_rotation_members_rule_person"
        ),
        UniqueConstraint(
            "rule_id",
            "position",
            "person_id",
            name="uq_slot_rule_rotation_members_rule_position_person",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    person_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
