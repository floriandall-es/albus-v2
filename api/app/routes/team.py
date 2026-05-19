from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.models import Category, Membership, Person, Slot, SlotAllowedPerson
from app.routes.deps import RequestContext, get_current_context
from app.schemas.team import TeamMemberOut, TeamMemberUpdate

router = APIRouter()


def _serialize(m: Membership, person: Person, category: Category | None) -> TeamMemberOut:
    return TeamMemberOut(
        id=m.id,
        tenant_id=m.tenant_id,
        person_id=m.person_id,
        person_name=person.name,
        person_email=person.email,
        person_locale=person.locale,
        person_avatar_url=person.avatar_url,
        roles=list(m.roles),
        category_id=m.category_id,
        category_name=category.name if category else None,
        fte_pct=m.fte_pct,
        disabled_at=m.disabled_at,
        created_at=m.created_at,
    )


@router.get("/team", response_model=list[TeamMemberOut])
def list_team(ctx: RequestContext = Depends(get_current_context)) -> list[TeamMemberOut]:
    rows = (
        ctx.db.query(Membership, Person, Category)
        .join(Person, Person.id == Membership.person_id)
        .outerjoin(Category, Category.id == Membership.category_id)
        .order_by(Person.name)
        .all()
    )
    return [_serialize(m, p, c) for m, p, c in rows]


def _get_member_or_404(ctx: RequestContext, membership_id: int) -> Membership:
    m = ctx.db.get(Membership, membership_id)
    if not m or m.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Membership not found")
    return m


@router.put("/team/{membership_id}", response_model=TeamMemberOut)
def update_team_member(
    membership_id: int,
    payload: TeamMemberUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> TeamMemberOut:
    m = _get_member_or_404(ctx, membership_id)
    data = payload.model_dump(exclude_unset=True)
    # `disabled` is a bool flag in the API; the column it controls
    # is a timestamp. Translate before the generic setattr loop so
    # we don't try to assign a bool to disabled_at directly.
    disabled = data.pop("disabled", None)
    allowed_slot_ids = data.pop("allowed_slot_ids", None)
    if data.get("category_id") is not None:
        cat = ctx.db.get(Category, data["category_id"])
        if not cat or cat.tenant_id != ctx.tenant.id:
            raise HTTPException(status_code=422, detail="Unknown category_id")
    for k, v in data.items():
        setattr(m, k, v)
    if disabled is not None:
        if disabled and m.disabled_at is None:
            # Stamp the moment we paused — useful later for "disabled
            # since X" UI hints and any cleanup batch jobs.
            m.disabled_at = datetime.now(timezone.utc)
        elif not disabled:
            m.disabled_at = None
    if allowed_slot_ids is not None:
        _sync_allowed_activities(ctx, m, set(allowed_slot_ids))
    ctx.db.flush()
    person = ctx.db.get(Person, m.person_id)
    cat = ctx.db.get(Category, m.category_id) if m.category_id else None
    assert person is not None
    return _serialize(m, person, cat)


def _sync_allowed_activities(
    ctx: RequestContext,
    member: Membership,
    desired_slot_ids: set[int],
) -> None:
    """Reconcile slot_allowed_persons so this member's eligibility
    matches `desired_slot_ids` (the set of slot ids the admin wants
    them authorized on).

    Cases for each slot in the tenant:
      Slot restricted, in desired, not yet in allow-list → INSERT
      Slot restricted, not in desired, currently in allow-list → DELETE
      Slot unrestricted, in desired → no-op (everyone eligible already)
      Slot unrestricted, NOT in desired → CONVERT the slot to
          restricted by inserting all OTHER active members of the
          tenant. The result: the slot has the same effective
          coverage minus this one person. Lets admins say "Pedro
          isn't doing guardias for a while" from the team modal
          without having to touch the activity itself.

    Validation: all ids in `desired_slot_ids` must belong to this
    tenant; unknown ids → 422.
    """
    if desired_slot_ids:
        found = (
            ctx.db.query(Slot.id)
            .filter(
                Slot.id.in_(desired_slot_ids),
                Slot.tenant_id == ctx.tenant.id,
            )
            .all()
        )
        found_ids = {row[0] for row in found}
        missing = desired_slot_ids - found_ids
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown slot_ids: {sorted(missing)}",
            )

    # Slot ids in the tenant + which ones have at least one row in
    # slot_allowed_persons (= "restricted").
    all_slot_ids = {
        row[0]
        for row in ctx.db.query(Slot.id)
        .filter(Slot.tenant_id == ctx.tenant.id)
        .all()
    }
    restricted_slot_ids = {
        row[0]
        for row in ctx.db.query(SlotAllowedPerson.slot_id)
        .filter(SlotAllowedPerson.tenant_id == ctx.tenant.id)
        .distinct()
        .all()
    }

    # Existing person→slot rows for THIS person.
    current_rows = (
        ctx.db.query(SlotAllowedPerson)
        .filter(
            SlotAllowedPerson.tenant_id == ctx.tenant.id,
            SlotAllowedPerson.person_id == member.person_id,
        )
        .all()
    )
    current_slot_ids = {r.slot_id for r in current_rows}

    # Active members of the tenant (excluding this person). Lazily
    # computed only if we need to convert an unrestricted slot.
    other_active_person_ids: set[int] | None = None

    def _get_other_active() -> set[int]:
        nonlocal other_active_person_ids
        if other_active_person_ids is None:
            other_active_person_ids = {
                pid
                for (pid,) in ctx.db.query(Membership.person_id)
                .filter(
                    Membership.tenant_id == ctx.tenant.id,
                    Membership.disabled_at.is_(None),
                    Membership.person_id != member.person_id,
                )
                .all()
            }
        return other_active_person_ids

    for slot_id in all_slot_ids:
        in_desired = slot_id in desired_slot_ids
        is_restricted = slot_id in restricted_slot_ids
        person_listed = slot_id in current_slot_ids

        if is_restricted:
            if in_desired and not person_listed:
                ctx.db.add(
                    SlotAllowedPerson(
                        tenant_id=ctx.tenant.id,
                        slot_id=slot_id,
                        person_id=member.person_id,
                    )
                )
            elif not in_desired and person_listed:
                row = next(r for r in current_rows if r.slot_id == slot_id)
                ctx.db.delete(row)
        else:
            if in_desired:
                # Slot unrestricted, person eligible → no change needed.
                continue
            # Slot unrestricted, person should be EXCLUDED. Convert to
            # restricted by inserting all other active members. If
            # there are no other active members the conversion can't
            # take effect (an empty allow-list is "unrestricted"),
            # which we accept — the exclusion has no peers to honour.
            for other_pid in _get_other_active():
                ctx.db.add(
                    SlotAllowedPerson(
                        tenant_id=ctx.tenant.id,
                        slot_id=slot_id,
                        person_id=other_pid,
                    )
                )


# NOTE: POST /api/team/invite was moved to app.routes.invitations in Sprint 3
# and now creates a token-based Invitation rather than a Person directly.
