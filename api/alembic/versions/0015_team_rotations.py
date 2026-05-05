"""sprint 15: multi-person team rotations

Allows N people per rotation position (so e.g. "Equipo de trasplante:
Semana 1 = [A,B,C], Semana 2 = [D,E,F]" can be expressed as one rotation
rule). Until now slot_rule_rotation_members had a UNIQUE(rule_id, position)
constraint that limited each position to exactly one person — that
constraint goes away.

Other constraints:
- KEEP UNIQUE(rule_id, person_id): a person can't appear in two positions
  of the same rotation (otherwise the rotation math gets ambiguous and
  fairness counting breaks).
- ADD UNIQUE(rule_id, position, person_id): tightens the previous +
  prevents accidentally double-adding the same person to the same
  position.

For fixed_weekly we already allow N rows per (rule, weekday) — no schema
changes needed there. Migration is reversible: downgrade re-imposes the
old single-person-per-position invariant. If existing data already
violates that invariant, the downgrade will fail loudly (correct: the
admin must remove the extra people first).

Revision ID: 0015_team_rotations
Revises: 0014_slot_dependencies
Create Date: 2026-05-05
"""

from alembic import op


revision = "0015_team_rotations"
down_revision = "0014_slot_dependencies"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop the position-uniqueness constraint to allow multi-person teams
    # at a single position. Use IF EXISTS for resilience against re-runs
    # in dev.
    op.execute(
        "ALTER TABLE slot_rule_rotation_members "
        "DROP CONSTRAINT IF EXISTS uq_slot_rule_rotation_members_rule_position"
    )
    # New unique: (rule, position, person) — equivalent to "no person
    # appears twice in the same position". Combined with the surviving
    # (rule, person) unique, this is strictly tighter than what we had.
    op.create_unique_constraint(
        "uq_slot_rule_rotation_members_rule_position_person",
        "slot_rule_rotation_members",
        ["rule_id", "position", "person_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_slot_rule_rotation_members_rule_position_person",
        "slot_rule_rotation_members",
        type_="unique",
    )
    # Re-impose single-person-per-position. Will fail if existing data
    # violates the invariant — the admin must clean up first.
    op.create_unique_constraint(
        "uq_slot_rule_rotation_members_rule_position",
        "slot_rule_rotation_members",
        ["rule_id", "position"],
    )
