from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


BlockType = Literal["vacation", "sick", "training", "personal", "other"]
BlockStatus = Literal["pending", "approved", "denied"]


class AvailabilityBlockBase(BaseModel):
    person_id: int
    start_date: date
    end_date: date
    block_type: BlockType
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_dates(self) -> "AvailabilityBlockBase":
        if self.end_date < self.start_date:
            raise ValueError("end_date must be >= start_date")
        return self


class AvailabilityBlockCreate(AvailabilityBlockBase):
    pass


class AvailabilityBlockUpdate(AvailabilityBlockBase):
    pass


class ConflictingShift(BaseModel):
    """One assignment that would be displaced if the admin approves
    the bloqueo. Computed only for pending blocks (no point flagging
    conflicts on already-decided ones)."""

    date: date
    slot_name: str
    # The sub-actividad / team_role label when the slot is
    # team_composition — null for single / multiple_same slots.
    role_label: str | None = None


class AvailabilityBlockOut(BaseModel):
    id: int
    tenant_id: int
    person_id: int
    person_name: str
    start_date: date
    end_date: date
    block_type: BlockType
    notes: str | None
    status: BlockStatus = "approved"
    requested_by_membership_id: int | None = None
    reviewed_by_membership_id: int | None = None
    reviewed_at: datetime | None = None
    review_notes: str | None = None
    # Migration 0083. The membership the member chose to review their
    # bloqueo. May reference an admin in a sibling tenant within the
    # same servicio. NULL on legacy rows (any admin in the block's
    # own tenant can review).
    reviewer_membership_id: int | None = None
    # Display labels for the chosen reviewer, denormalised at read
    # time so the frontend doesn't need a second fetch to render
    # "Solicitada a: Dr. Pérez (Cardiología)". NULL when
    # reviewer_membership_id is NULL.
    reviewer_person_name: str | None = None
    reviewer_tenant_name: str | None = None
    # Person id of the chosen reviewer (when reviewer_membership_id is
    # set). Lets the member open an in-context DM with the reviewer
    # ("Comentar" on their own bloqueo). NULL when no reviewer.
    reviewer_person_id: int | None = None
    # Migration 0083 follow-up. Shifts the requester already has on
    # days inside this block's range — what the admin would be
    # asking the solver to re-assign if they approve. Populated ONLY
    # for status='pending' rows (other statuses get []). Capped at
    # 20 entries per block — past that the admin gets the gist.
    conflicting_shifts: list[ConflictingShift] = []
    # True when the conflict list was truncated. UI uses it to render
    # "… y N más" so the admin knows there are more.
    conflicting_shifts_truncated: bool = False
    created_at: datetime

    model_config = {"from_attributes": True}


class AvailabilityRequestCreate(BaseModel):
    start_date: date
    end_date: date
    block_type: BlockType
    notes: str | None = Field(default=None, max_length=2000)
    # Migration 0083. Required — members must explicitly pick which
    # admin reviews their bloqueo. Validated at the route layer to
    # make sure the chosen membership is actually an admin in an
    # approved equipo within the same servicio. (Pre-0083 rows in
    # the DB still have NULL here and follow legacy "any admin of
    # own tenant" semantics — we just don't allow NEW NULL writes.)
    reviewer_membership_id: int

    @model_validator(mode="after")
    def _check_dates(self) -> "AvailabilityRequestCreate":
        if self.end_date < self.start_date:
            raise ValueError("end_date must be >= start_date")
        return self


class ServicioAdminOut(BaseModel):
    """One row of the cross-equipo admin picker shown on
    /me/bloqueos when raising a request. Returned inside a
    ServicioAdminPickerOut wrapper by GET /api/me/servicio/admins."""

    membership_id: int
    person_id: int
    person_name: str
    tenant_id: int
    tenant_name: str
    # True when this admin lives in the caller's own tenant. The
    # picker uses it to render "Tu equipo" / "Otros equipos del
    # servicio" group headers without needing the caller's tenant_id.
    is_own_tenant: bool


class ServicioAdminPickerOut(BaseModel):
    """Wrapper for GET /api/me/servicio/admins.

    Carries both the picker list (`admins`) and the servicio's
    bloqueo routing mode (migration 0085). The frontend uses
    `mode` to decide whether to render a dropdown or a read-only
    "Se enviará a X" line: in centralised mode with a resolved
    jefe, `admins` collapses to that single membership and the
    UI hides the picker."""

    mode: Literal["delegated", "centralised"]
    admins: list[ServicioAdminOut]


class AvailabilityDenyRequest(BaseModel):
    review_notes: str | None = Field(default=None, max_length=2000)


class TeamAbsence(BaseModel):
    """Sanitized public read-only view: just enough to render the Libre
    row in the planning grid. No notes, no review_notes, no reviewer
    metadata — visible to any authenticated user in the tenant."""
    person_id: int
    person_name: str
    # Split-name fields so the Libre row can show just the last name,
    # consistent with the rest of the planning grid.
    person_first_name: str | None = None
    person_last_name: str | None = None
    person_avatar_url: str | None = None
    start_date: date
    end_date: date
    block_type: BlockType
