from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


ScheduleStatus = Literal["draft", "published", "archived"]
SolverUsed = Literal["cpsat", "greedy"]
ViolationKind = Literal[
    "incompatibility", "succession", "frequency", "time_overlap", "post_rest"
]


class ViolationCellOut(BaseModel):
    assignment_id: int
    date: date
    slot_id: int
    person_id: int


class ViolationOut(BaseModel):
    """One rule breach detected against a schedule's current
    assignments. Warning only — never blocks a save. See
    app/services/violations.py for the detection logic.
    """

    kind: ViolationKind
    message: str
    cells: list[ViolationCellOut]
    rule_id: int | None = None
    # Hard / soft from the rule definition, when available. Implicit
    # checks (time_overlap, post_rest) have no rule row → null.
    severity: Literal["hard", "soft"] | None = None
    # Stable identity hash. Echo back when calling
    # POST /schedules/{id}/violations/suppress to "hide" this
    # violation, or DELETE .../suppressions/{signature} to un-hide.
    # Computed by services/violations.py::violation_signature over
    # (kind, sorted cells, rule_id); excludes assignment_id so
    # suppressions survive schedule regeneration when the same
    # conflict reappears.
    signature: str
    # When the admin has overruled this conflict via the "Ocultar"
    # button, the suppression timestamp. The frontend hides
    # suppressed entries by default behind a "Mostrar N ocultos"
    # toggle but still receives them so the banner can offer a way
    # to revert. NULL = currently flagged.
    suppressed_at: datetime | None = None


class ViolationSuppressRequest(BaseModel):
    """Request body for POST /schedules/{id}/violations/suppress.

    Only the signature is required — it's the stable identity the
    GET response already returned. We accept `kind` as an audit
    breadcrumb so the row written to violation_suppressions is
    self-describing without re-fetching the violations engine.
    """

    signature: str = Field(min_length=64, max_length=64)
    kind: ViolationKind


class AssignmentSaveResponse(BaseModel):
    """Wrapper returned by PATCH and POST /assignments. Used to
    surface new rule warnings the edit triggered without changing
    the AssignmentOut shape (which is used in many other contexts
    where warnings don't apply).
    """

    assignment: "AssignmentOut"
    warnings: list[ViolationOut] = []


class GroupPublicationOut(BaseModel):
    """Per-group publication marker carried on every Schedule serialization.

    Sub-equipo members' "Mis turnos" view is gated by the publication
    state of THEIR group, not by the parent Schedule.status. We expose
    the timestamp here so the member-side UI can show "Publicado el
    [date]" using the right value (the lead's publish moment, not the
    tenant admin's).
    """

    group_id: int
    published_at: datetime


class ScheduleOut(BaseModel):
    id: int
    tenant_id: int
    period: date
    status: ScheduleStatus
    generated_at: datetime | None
    published_at: datetime | None
    reopened_at: datetime | None = None
    solver_used: SolverUsed | None = None
    # Group ids whose lead has published the group's plan for this
    # schedule. Empty when no group has published. Visible to all
    # callers — used by both /lead/planificacion (to drive the
    # Publicar/Despublicar button) and /me/turnos (to decide which
    # group-slot assignments to render).
    published_group_ids: list[int] = []
    # Same set of groups as `published_group_ids` but with their
    # per-group `published_at` timestamps. Sprint 30: the /me/turnos
    # "Publicado el…" line uses this for sub-equipo members so it
    # reflects the lead's publish moment instead of the parent
    # schedule's (which may still be draft from the admin's view).
    # Kept as a parallel field rather than replacing the legacy
    # ids list so existing callers that only need ids stay unchanged.
    published_groups: list[GroupPublicationOut] = []
    created_at: datetime

    model_config = {"from_attributes": True}


class AssignmentOut(BaseModel):
    id: int
    schedule_id: int
    slot_id: int
    slot_name: str
    slot_color: str | None = None
    # Admin-controlled display order — same as Slot.position. Sent
    # with every assignment so the planning grid can sort rows by
    # it without needing a separate slot lookup.
    slot_position: int = 0
    # Sub-team grouping (post-0035). When non-null the slot belongs
    # to a Group; the admin/members planning grid renders a small
    # pill on the row so tenant admins can tell at a glance which
    # rows are managed by a group lead.
    slot_group_id: int | None = None
    slot_group_name: str | None = None
    # Slot hours (HH:MM:SS strings). Surfaced on each assignment so
    # the member-side "Mis turnos" list can show "08:00 – 15:00"
    # without a second roundtrip. Null = on-call / all-day slot.
    slot_start_time: str | None = None
    slot_end_time: str | None = None
    date: date
    person_id: int | None
    person_name: str | None
    # Split-name fields for tight UI columns. Both nullable because
    # legacy person rows haven't filled them in yet; the frontend
    # helpers fall back to splitting `person_name` heuristically.
    person_first_name: str | None = None
    person_last_name: str | None = None
    person_avatar_url: str | None = None
    team_role_id: int | None
    team_role_label: str | None
    notes: str | None
    locked_at: datetime | None = None
    locked_by_membership_id: int | None = None
    # Sprint 28 / migration 0049: set when admin marked this
    # (slot, date) as "No aplica" — the cell is intentionally not
    # staffed. Distinct from person_id=null/locked_at=null which
    # means "empty/pending". Dismissed rows are auto-locked.
    dismissed_at: datetime | None = None
    swap_offer_id: int | None = None


class AssignmentPatch(BaseModel):
    person_id: int | None = None
    team_role_id: int | None = None
    # Sentinel: clients pass clear_person=True to set person_id=null.
    clear_person: bool = False


class AssignmentCreate(BaseModel):
    """Body for POST /api/schedules/{id}/assignments — used by
    group leads to create a new Assignment row for one of THEIR
    group's slots on a specific date. Tenant admin uses a
    different path (assignments come from the solver run)."""
    slot_id: int
    date: date
    person_id: int | None = None
    team_role_id: int | None = None


class EligiblePersonOut(BaseModel):
    person_id: int
    person_name: str


class ScheduleDetail(ScheduleOut):
    assignments: list[AssignmentOut] = Field(default_factory=list)


class ScheduleGenerateRequest(BaseModel):
    period: date


# AssignmentSaveResponse forward-refs AssignmentOut; resolve once
# both classes are in scope.
AssignmentSaveResponse.model_rebuild()
