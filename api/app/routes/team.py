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
        person_last_name=person.last_name,
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
    # Role updates — only "admin" is recognised today. Three guards:
    #   1. Reject unknown role strings so a typo doesn't silently
    #      leak into the membership row and confuse later code.
    #   2. Prevent an admin from removing 'admin' from their OWN
    #      membership — they'd lock themselves out of /admin in one
    #      click. They can ask another admin to demote them.
    #   3. Prevent removing 'admin' from the LAST admin in the
    #      tenant. Without at least one admin nobody can manage the
    #      team. The caller would also be locking themselves out
    #      since they ARE that last admin in most realistic flows,
    #      but we guard structurally rather than relying on (2).
    # Snapshot the pre-write admin state so we can decide later
    # whether to reconcile the admin seat count on Stripe.
    was_admin = "admin" in (m.roles or [])
    # Under members_pay a promotion changes the target's Stripe
    # price — we can't silently swap a recurring charge. The
    # /api/team/{id}/admin-promotion endpoint runs the consent
    # flow (email with accept link). Direct promotions via this
    # PUT are rejected here. Demotions are fine because they only
    # lower the bill; team_pays is fine because the tenant card
    # pays so no consent matters.
    if (
        "roles" in data
        and data["roles"] is not None
        and ctx.tenant.billing_model == "members_pay"
        and not was_admin
        and "admin" in list(data["roles"])
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Para promocionar un miembro a admin en este "
                "modelo de facturación, usa el flujo de "
                "consentimiento: POST /api/team/{id}/admin-promotion."
            ),
        )
    if "roles" in data and data["roles"] is not None:
        next_roles = list(data["roles"])
        unknown = [r for r in next_roles if r not in {"admin"}]
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"Rol desconocido: {', '.join(sorted(set(unknown)))}",
            )
        is_currently_admin = "admin" in (m.roles or [])
        will_be_admin = "admin" in next_roles
        is_demotion = is_currently_admin and not will_be_admin
        if is_demotion and m.id == ctx.membership.id:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No puedes quitarte el rol de admin a ti mismo. "
                    "Pide a otro admin que lo haga."
                ),
            )
        if is_demotion:
            # Count remaining admins in the tenant — including
            # disabled ones, because we don't want a tenant whose
            # only admin is paused.
            other_admin_count = (
                ctx.db.query(Membership)
                .filter(
                    Membership.tenant_id == ctx.tenant.id,
                    Membership.id != m.id,
                    Membership.roles.op("@>")(["admin"]),
                )
                .count()
            )
            if other_admin_count == 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "No puedes quitar el rol de admin al único admin "
                        "del equipo. Asigna primero el rol a otro miembro."
                    ),
                )
    for k, v in data.items():
        setattr(m, k, v)
    disabled_state_changed = False
    if disabled is not None:
        if disabled and m.disabled_at is None:
            # Stamp the moment we paused — useful later for "disabled
            # since X" UI hints and any cleanup batch jobs.
            m.disabled_at = datetime.now(timezone.utc)
            disabled_state_changed = True
        elif not disabled and m.disabled_at is not None:
            m.disabled_at = None
            disabled_state_changed = True
    if allowed_slot_ids is not None:
        _sync_allowed_activities(ctx, m, set(allowed_slot_ids))
    ctx.db.flush()
    # Billing reconciliation. The model determines who gets billed:
    #
    # team_pays — the tenant pays for everyone. Tenant sub has both
    # price_admin × N_admins and price_member × N_non_admin_members.
    # When a role flips OR a member's disabled state changes, both
    # counts may move (a promoted member shifts from price_member
    # to price_admin; a disabled admin drops both counts by one,
    # etc.) so we call both reconcilers and let each query the
    # current state. Idempotent + cheap (one Stripe call each).
    #
    # members_pay — each person pays for themselves via their own
    # personal sub. The promoted admin's sub swaps from
    # price_member to price_admin; the demoted admin's swaps back.
    # The tenant sub stays at price_admin × 1 forever (the founder).
    is_admin_now = "admin" in (m.roles or [])
    role_admin_changed = was_admin != is_admin_now
    if ctx.tenant.billing_model == "team_pays":
        if disabled_state_changed or role_admin_changed:
            from app.services.billing import (
                reconcile_admin_seats,
                reconcile_team_pays_seats,
            )
            reconcile_admin_seats(ctx.tenant, ctx.db)
            reconcile_team_pays_seats(ctx.tenant, ctx.db)
    else:
        # members_pay
        if role_admin_changed:
            from app.services.billing import swap_personal_sub_role
            affected_person = ctx.db.get(Person, m.person_id)
            if affected_person is not None:
                swap_personal_sub_role(
                    ctx.tenant,
                    affected_person,
                    is_admin=is_admin_now,
                )
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
