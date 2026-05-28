"""Grandfather alpha pilots — free, forever.

Every tenant + person that exists when this migration runs predates
the Stripe rollout. We promised the alpha pilots they'd keep using
Trivu for free as a thank-you for shaking out the early bugs, so we
mark them all `active` with a `trial_end_at` so far in the future
that nothing ever lapses them.

`billing_model` is flipped to `team_pays` for those tenants because
that's the simpler shape: the tenant subscription gates access for
everyone, and we never have to bother members with a personal
subscription prompt. Since we're not actually billing them, the
gating just always evaluates to "active" via the tenant row.

The cutoff is "right now" — `created_at <= NOW()` matches every
existing row at migration time and nothing created afterwards.
That's exactly what we want: anyone signing up after this migration
runs hits the real billing flow.

Revision ID: 0081_grandfather_alpha
Revises: 0080_billing
Create Date: 2026-05-28
"""

from alembic import op


revision = "0081_grandfather_alpha"
down_revision = "0080_billing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Tenants: active, far-future trial, team_pays mode (so the
    # tenant-level status alone decides access).
    op.execute(
        """
        UPDATE tenants
           SET subscription_status = 'active',
               trial_end_at        = '2099-12-31 00:00:00+00',
               billing_model       = 'team_pays'
         WHERE created_at <= NOW()
        """
    )
    # Persons: every member of a grandfathered tenant. Under
    # team_pays the person-level status doesn't actually gate
    # anything (the tenant row does), but we still flip it so the
    # admin UI doesn't render "En papel" chips for them.
    op.execute(
        """
        UPDATE persons p
           SET subscription_status = 'active',
               trial_end_at        = '2099-12-31 00:00:00+00'
          FROM memberships m
         WHERE m.person_id = p.id
           AND m.tenant_id IN (
               SELECT id FROM tenants
                WHERE trial_end_at = '2099-12-31 00:00:00+00'
           )
        """
    )


def downgrade() -> None:
    # Best-effort reversal: knock the same rows back to the
    # pre-billing defaults. We can identify them by the sentinel
    # trial_end_at value — nothing else in the system would ever
    # write that exact timestamp.
    op.execute(
        """
        UPDATE persons
           SET subscription_status = 'never_subscribed',
               trial_end_at        = NULL
         WHERE trial_end_at = '2099-12-31 00:00:00+00'
        """
    )
    op.execute(
        """
        UPDATE tenants
           SET subscription_status = NULL,
               trial_end_at        = NULL,
               billing_model       = 'members_pay'
         WHERE trial_end_at = '2099-12-31 00:00:00+00'
        """
    )
