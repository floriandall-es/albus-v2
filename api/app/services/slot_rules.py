"""Helpers for keeping slot rules in sync with slot allow-lists.

When admin removes a person from a slot's allow-list, the rules
attached to that slot can still reference them in `weekly_pins`
or `rotation_members`. The eligibility filter at solve time would
silently drop the assignment (the cell never becomes a variable),
producing surprising schedules and "why didn't the pin stick?"
support questions.

The cascade helper here deletes those orphaned rule rows in the
same transaction as the allow-list change, so both sides stay
consistent. Used by:
  - app.routes.slots._replace_allowed_persons (activity side)
  - app.routes.team._sync_allowed_activities  (member side)
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import SlotRule, SlotRuleRotationMember, SlotRuleWeeklyPin


def cascade_remove_persons_from_slot_rules(
    db: Session, slot_id: int, person_ids: set[int]
) -> None:
    """Delete every weekly_pin and rotation_member for `slot_id`
    whose person_id is in `person_ids`. Safe to call with an empty
    set — returns immediately.

    Does NOT touch SlotRuleRotationBlock rows. Blocks describe the
    rotation's day grouping; they're independent of which people
    are in the cycle and stay valid even when members are removed.
    The rotation can keep running, just with fewer (or zero)
    members until the admin re-populates it.
    """
    if not person_ids:
        return

    rule_ids = [
        r[0]
        for r in db.query(SlotRule.id).filter(SlotRule.slot_id == slot_id).all()
    ]
    if not rule_ids:
        return

    db.query(SlotRuleWeeklyPin).filter(
        SlotRuleWeeklyPin.rule_id.in_(rule_ids),
        SlotRuleWeeklyPin.person_id.in_(person_ids),
    ).delete(synchronize_session=False)

    db.query(SlotRuleRotationMember).filter(
        SlotRuleRotationMember.rule_id.in_(rule_ids),
        SlotRuleRotationMember.person_id.in_(person_ids),
    ).delete(synchronize_session=False)
