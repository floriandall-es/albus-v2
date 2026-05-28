from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.models import Category, Membership, Person, Slot, SlotAllowedPerson
from app.routes.deps import RequestContext, get_current_context
from app.routes.scope import caller_scope
from app.schemas.invitation import InviteCreateResponse
from app.schemas.team import TeamMemberOut, TeamMemberUpdate
from app.services.invitations import (
    issue_invitation_for_existing_pendiente,
    send_invitation_email,
)

router = APIRouter()


def _serialize(
    m: Membership,
    person: Person,
    category: Category | None,
) -> TeamMemberOut:
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
        is_pending=person.hashed_password is None,
        subscription_status=person.subscription_status,
        trial_end_at=person.trial_end_at,
        created_at=m.created_at,
    )


@router.get("/team", response_model=list[TeamMemberOut])
def list_team(ctx: RequestContext = Depends(get_current_context)) -> list[TeamMemberOut]:
    q = (
        ctx.db.query(Membership, Person, Category)
        .join(Person, Person.id == Membership.person_id)
        .outerjoin(Category, Category.id == Membership.category_id)
        # Order by category first so members cluster together
        # (Adjunto / Neumólogo / Residente sit in three blocks
        # instead of being interleaved alphabetically by surname).
        # Postgres puts NULL category names last by default in
        # ascending order, which is exactly what we want for any
        # rare uncategorised admin row.
        .order_by(Category.name.asc(), Person.name.asc())
    )
    return [_serialize(m, p, c) for m, p, c in q.all()]


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
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(
            status_code=403, detail="Permisos insuficientes."
        )
    m = _get_member_or_404(ctx, membership_id)
    data = payload.model_dump(exclude_unset=True)
    # `disabled` is a bool flag in the API; the column it controls
    # is a timestamp. Translate before the generic setattr loop so
    # we don't try to assign a bool to disabled_at directly.
    disabled = data.pop("disabled", None)
    allowed_slot_ids = data.pop("allowed_slot_ids", None)
    # Admin can rewrite a pendiente member's email — the common case
    # is replacing a placeholder address (from the legacy CSV
    # migration) with the real one before sending an invitation.
    # Activos go through /me/email's confirmation flow instead.
    new_email = data.pop("email", None)
    if new_email is not None:
        new_email = new_email.lower()
        target_person = ctx.db.get(Person, m.person_id)
        if target_person is None:
            raise HTTPException(
                status_code=404, detail="Person record missing for membership."
            )
        if target_person.hashed_password is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Este miembro ya activó su cuenta. Solo puede "
                    "cambiar el email desde su propio perfil."
                ),
            )
        if new_email != target_person.email:
            collision = (
                ctx.db.query(Person)
                .filter(Person.email == new_email, Person.id != target_person.id)
                .first()
            )
            if collision is not None:
                raise HTTPException(
                    status_code=409,
                    detail="Ya existe una cuenta con ese email.",
                )
            target_person.email = new_email
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


@router.post(
    "/team/{membership_id}/invitation",
    response_model=InviteCreateResponse,
)
def issue_membership_invitation(
    membership_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> InviteCreateResponse:
    """Issue a fresh invitation for an EXISTING pendiente Membership.

    Use case: legacy CSV migration creates Person+Membership rows but
    no Invitation tokens. Without this endpoint there's no way for
    the admin to onboard those people short of running a CLI script
    per person. With it, /admin/team gets a per-row "Enviar
    invitación" button on every pendiente — one click revokes any
    stale tokens, issues a new one, emails it, and returns the
    accept_url so the admin can copy it as a fallback if SMTP fails.

    Rejects (400) if the Person has already activated — they can
    use /forgot-password instead, and we don't want to invalidate
    their existing session by handing out an invitation token.
    """
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(
            status_code=403, detail="Permisos insuficientes."
        )
    m = _get_member_or_404(ctx, membership_id)
    person = ctx.db.get(Person, m.person_id)
    if person is None:
        raise HTTPException(
            status_code=404, detail="Person record missing for membership."
        )
    if person.hashed_password is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Esta persona ya ha activado su cuenta. Pídele que "
                "use 'He olvidado mi contraseña' si no puede acceder."
            ),
        )
    created = issue_invitation_for_existing_pendiente(
        ctx.db,
        tenant_id=ctx.tenant.id,
        person=person,
        membership=m,
    )
    # Stamp the inviting admin so the audit trail isn't anonymous —
    # the service function leaves created_by NULL because it's
    # also used by the bootstrap script (no admin caller there).
    created.invitation.created_by_membership_id = ctx.membership.id
    send_invitation_email(
        ctx.db, tenant_id=ctx.tenant.id, created=created
    )
    ctx.db.flush()
    return InviteCreateResponse(
        invitation_id=created.invitation.id,
        email=created.invitation.email,
        expires_at=created.invitation.expires_at,
        accept_url=created.accept_url,
    )


@router.post(
    "/team/{membership_id}/reset-to-pendiente",
    response_model=TeamMemberOut,
)
def reset_member_to_pendiente(
    membership_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> TeamMemberOut:
    """Clear the underlying Person's password so the membership
    flips back to "pendiente" state. Lets an admin re-issue a
    fresh invitation to a different email — common during
    customer onboarding when the admin first signs up the test
    account with their own email to walk through the member
    experience, then needs to hand the real account to the
    actual clinician.

    After the reset:
      - is_pending becomes true on the next /admin/team fetch
      - the email field becomes editable again
      - "Enviar invitación" is available
      - any active session for the user stays valid until its
        JWT expires (we deliberately don't invalidate tokens
        here — for the documented use case the previous user
        is the admin themselves and they're done with that
        session)

    Caveat: Person.hashed_password is global across tenants —
    if this person belongs to other tenants too, this also
    logs them out everywhere on their next password use. We
    don't guard against that yet (alpha customers are
    single-tenant); add a cross-tenant check before we onboard
    a hospital where staff hop between Trivu tenants.
    """
    scope = caller_scope(ctx)
    if not scope.is_tenant_admin:
        raise HTTPException(
            status_code=403,
            detail="Solo el administrador puede reiniciar cuentas.",
        )
    m = _get_member_or_404(ctx, membership_id)
    person = ctx.db.get(Person, m.person_id)
    if person is None:
        raise HTTPException(
            status_code=404, detail="Person record missing for membership."
        )
    if person.hashed_password is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Esta cuenta ya está pendiente — no hace falta "
                "reiniciarla. Edita el email si quieres y pulsa "
                "'Enviar invitación'."
            ),
        )
    person.hashed_password = None
    ctx.db.flush()
    # Reuse the list serializer so the response shape matches
    # what the team page already renders — saves the frontend
    # one extra fetch after the mutation.
    category = (
        ctx.db.get(Category, m.category_id) if m.category_id else None
    )
    return _serialize(m, person, category)


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

    from app.services.slot_rules import cascade_remove_persons_from_slot_rules

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
                # Cascade: drop any pins/rotation_members for this
                # person on this slot. Frontend should have surfaced
                # this in a confirm dialog already.
                cascade_remove_persons_from_slot_rules(
                    ctx.db, slot_id, {member.person_id}
                )
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
            # Cascade rules: even though the slot was unrestricted,
            # this person could have been pinned/in a rotation via
            # any rule on it. After the conversion they're no longer
            # eligible, so drop those references.
            cascade_remove_persons_from_slot_rules(
                ctx.db, slot_id, {member.person_id}
            )


# NOTE: POST /api/team/invite was moved to app.routes.invitations in Sprint 3
# and now creates a token-based Invitation rather than a Person directly.
