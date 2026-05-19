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
    """Reconcile slot_allowed_persons for `member` so the slots the
    person is authorized on match `desired_slot_ids`.

    Subtle bit: we only touch slots that are ALREADY restricted
    (have at least one row in slot_allowed_persons). Unrestricted
    slots stay unrestricted — adding this person would mean turning
    a "Todo el equipo" activity into "only this one person", which
    is a side effect this endpoint must not produce. The team
    modal's UI mirrors this by disabling the checkbox for
    unrestricted activities.

    Validation:
      - all slot ids must belong to this tenant; unknown ids → 422.
    """
    if not desired_slot_ids:
        # Empty set is valid — means "remove from every activity's
        # allow-list". We still need to validate by going through
        # the existing rows.
        pass
    else:
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

    # All slots in the tenant that currently have a restriction.
    # A slot with zero allow-list rows is unrestricted; we don't
    # write a row to it even if it appears in desired_slot_ids
    # (that would silently convert it from "everyone" to "just
    # this person"). The slot detail page is the only place that
    # establishes a slot's allow-list in the first place.
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

    # Limit the desired set to restricted-and-known slots only.
    effective_desired = desired_slot_ids & restricted_slot_ids

    to_remove = current_slot_ids - effective_desired
    to_add = effective_desired - current_slot_ids

    if to_remove:
        for row in current_rows:
            if row.slot_id in to_remove:
                ctx.db.delete(row)
    for slot_id in to_add:
        ctx.db.add(
            SlotAllowedPerson(
                tenant_id=ctx.tenant.id,
                slot_id=slot_id,
                person_id=member.person_id,
            )
        )


# NOTE: POST /api/team/invite was moved to app.routes.invitations in Sprint 3
# and now creates a token-based Invitation rather than a Person directly.
