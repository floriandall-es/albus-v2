"""sprint 4: availability_blocks (admin-managed)

Days when a person is unavailable (vacation, sick, training, etc.). The
schedule generator skips these in Sprint 4. Self-service requests +
approval workflow are out of scope here — every row is admin-entered.

Revision ID: 0006_availability_blocks
Revises: 0005_holidays
Create Date: 2026-04-28
"""

from alembic import op
import sqlalchemy as sa

revision = "0006_availability_blocks"
down_revision = "0005_holidays"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "availability_blocks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("block_type", sa.String(length=32), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "block_type IN ('vacation','sick','training','personal','other')",
            name="ck_availability_blocks_type",
        ),
        sa.CheckConstraint(
            "end_date >= start_date", name="ck_availability_blocks_date_order"
        ),
    )
    op.create_index(
        "ix_availability_blocks_tenant_id", "availability_blocks", ["tenant_id"]
    )
    op.create_index(
        "ix_availability_blocks_lookup",
        "availability_blocks",
        ["tenant_id", "person_id", "start_date"],
    )

    op.execute("ALTER TABLE availability_blocks ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE availability_blocks FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY availability_blocks_tenant_isolation ON availability_blocks
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON availability_blocks TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE availability_blocks_id_seq TO albus_app"
    )


def downgrade() -> None:
    op.execute(
        "DROP POLICY IF EXISTS availability_blocks_tenant_isolation ON availability_blocks"
    )
    op.execute("ALTER TABLE availability_blocks DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_availability_blocks_lookup", table_name="availability_blocks")
    op.drop_index("ix_availability_blocks_tenant_id", table_name="availability_blocks")
    op.drop_table("availability_blocks")
