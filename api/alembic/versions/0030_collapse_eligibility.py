"""Collapse Pools + Skills into a single per-slot allowed_persons table.

Pools, Skills, and the per-slot Skill requirements all served the
same purpose in the solver: restrict which people can be assigned
to which slots. For Trivu's customer profile (hospital service of
10-30 people), three different mechanisms for one concept was
overkill — most admins never used skills, the Pool model carried
dead fields (membership_mode, equity_independent), and the indirect
"add skill → mark persons with it → require skill on slot" workflow
was friction we didn't pay back.

This migration replaces all three with a single direct relation:

    slot_allowed_persons(slot_id, person_id)

Semantics: if a slot has zero rows, anyone in the team is eligible
(modulo categories, guardia types, availability, etc.). If a slot
has one or more rows, ONLY those people are eligible. Categories
remain the per-role qualification filter — unchanged.

Materialization: for each slot today, we compute the current
eligible set as
    (members of slot.pool_id if set, else everyone in the tenant)
    ∩ (people with all 'hard'-strength required skills)
…and write that set into slot_allowed_persons, BUT ONLY IF the
slot actually had a restriction today (pool_id set, or any hard
skill requirement). Slots with no restriction stay empty so the
admin sees "Todo el equipo" in the new UI, matching what they had
before.

Trade-off the admin needs to know about: once we drop skills, the
materialized list is frozen. A new hire with the surgical Robótica
training won't automatically become eligible for a Robótica slot —
the admin has to add them to the slot's allowed list. A one-time
banner on the slot page will surface this.

Drops `pools`, `pool_memberships`, `skills`, `person_skills`,
`slot_skills_required`, and the `slot.pool_id` column.

Revision ID: 0030_collapse_eligibility
Revises: 0029_tenant_preset_kind
Create Date: 2026-05-18
"""

import sqlalchemy as sa
from alembic import op

revision = "0030_collapse_eligibility"
down_revision = "0029_tenant_preset_kind"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. New table — the single source of truth going forward.
    # ------------------------------------------------------------------
    op.create_table(
        "slot_allowed_persons",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "slot_id",
            sa.Integer,
            sa.ForeignKey("slots.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "person_id",
            sa.Integer,
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "slot_id", "person_id", name="uq_slot_allowed_persons_slot_person"
        ),
    )

    # ------------------------------------------------------------------
    # 2. Materialize current eligibility into the new table.
    #
    # One INSERT per slot, broken into two cases depending on whether
    # the slot had a pool restriction. SQL only — no Python data layer
    # at migration time so we avoid the "alembic loads ORM with the
    # CURRENT model definitions" trap.
    # ------------------------------------------------------------------

    # Case A: slot has a pool_id. Eligible = pool members ∩ (people
    # who satisfy all hard skill requirements on this slot).
    op.execute(
        """
        INSERT INTO slot_allowed_persons (tenant_id, slot_id, person_id)
        SELECT DISTINCT s.tenant_id, s.id, pm.person_id
        FROM slots s
        JOIN pool_memberships pm ON pm.pool_id = s.pool_id
        WHERE s.pool_id IS NOT NULL
          AND NOT EXISTS (
            -- The person must satisfy EVERY hard skill requirement.
            -- Equivalent to: for every required skill on this slot,
            -- the person has it.
            SELECT 1
            FROM slot_skills_required ssr
            WHERE ssr.slot_id = s.id
              AND ssr.strength = 'hard'
              AND NOT EXISTS (
                SELECT 1 FROM person_skills ps
                WHERE ps.person_id = pm.person_id
                  AND ps.skill_id = ssr.skill_id
              )
          )
        """
    )

    # Case B: slot has NO pool_id but DOES have hard skill requirements.
    # Eligible = everyone in the tenant who has all the required skills.
    # Without a pool restriction we'd implicitly include EVERY tenant
    # member — which is "no restriction", so we skip in that case.
    op.execute(
        """
        INSERT INTO slot_allowed_persons (tenant_id, slot_id, person_id)
        SELECT DISTINCT s.tenant_id, s.id, p.id
        FROM slots s
        JOIN persons p ON p.tenant_id = s.tenant_id
        WHERE s.pool_id IS NULL
          AND EXISTS (
            SELECT 1 FROM slot_skills_required ssr2
            WHERE ssr2.slot_id = s.id AND ssr2.strength = 'hard'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM slot_skills_required ssr
            WHERE ssr.slot_id = s.id
              AND ssr.strength = 'hard'
              AND NOT EXISTS (
                SELECT 1 FROM person_skills ps
                WHERE ps.person_id = p.id
                  AND ps.skill_id = ssr.skill_id
              )
          )
        """
    )

    # ------------------------------------------------------------------
    # 3. Drop the now-unused old structures.
    #    Order matters because of FK dependencies.
    # ------------------------------------------------------------------
    op.drop_column("slots", "pool_id")
    op.drop_table("slot_skills_required")
    op.drop_table("person_skills")
    op.drop_table("skills")
    op.drop_table("pool_memberships")
    op.drop_table("pools")


def downgrade() -> None:
    # Recreating the old structures empty is pointless — the data
    # they held was destructively materialized into slot_allowed_persons
    # and we don't have the inverse mapping (which combinations of
    # pool/skills produced which allowed set). A real downgrade would
    # require a pre-upgrade backup. Document and bail out loudly.
    raise NotImplementedError(
        "Downgrade not supported: the old pool/skill structures held "
        "data that was destructively materialized. Restore from a "
        "pre-0030 database backup if you need to roll back."
    )
