"""Pydantic schemas for the meetings (reuniones) feature.

Two write shapes:
  - RegularMeetingCreate / RegularMeetingUpdate — admin-only,
    weekly recurring template (weekday + time, no date).
  - AdHocMeetingCreate / AdHocMeetingUpdate — anyone in the
    tenant, one-off concrete occurrence (date + time).

One read shape (MeetingOut) covers both kinds, with `kind`
disambiguating.

The /meetings/instances endpoint returns MeetingInstance rows,
which are concrete (date, start_time, end_time, title…) tuples
expanded from both ad-hoc rows (1:1) and regular templates
(N occurrences per weekday-match in the requested range).
"""

from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class MeetingAudienceIn(BaseModel):
    """Shared audience block on create/update payloads. At least
    one of include_main_team, group_ids, person_ids must be
    non-empty — enforced at the route layer with a 422 (a meeting
    with nobody invited is almost certainly a bug, not a feature)."""

    include_main_team: bool = False
    group_ids: list[int] = Field(default_factory=list)
    person_ids: list[int] = Field(default_factory=list)


class RegularMeetingCreate(MeetingAudienceIn):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    location: str | None = Field(default=None, max_length=255)
    weekday: int = Field(ge=0, le=6)
    start_time: time
    end_time: time

    @model_validator(mode="after")
    def _check_times(self) -> "RegularMeetingCreate":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class RegularMeetingUpdate(MeetingAudienceIn):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    location: str | None = Field(default=None, max_length=255)
    weekday: int = Field(ge=0, le=6)
    start_time: time
    end_time: time

    @model_validator(mode="after")
    def _check_times(self) -> "RegularMeetingUpdate":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class AdHocMeetingCreate(MeetingAudienceIn):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    location: str | None = Field(default=None, max_length=255)
    date: date
    start_time: time
    end_time: time

    @model_validator(mode="after")
    def _check_times(self) -> "AdHocMeetingCreate":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class AdHocMeetingUpdate(MeetingAudienceIn):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    location: str | None = Field(default=None, max_length=255)
    date: date
    start_time: time
    end_time: time

    @model_validator(mode="after")
    def _check_times(self) -> "AdHocMeetingUpdate":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class MeetingAudienceOut(BaseModel):
    include_main_team: bool
    group_ids: list[int]
    person_ids: list[int]
    # Display-friendly names so the UI doesn't need a second
    # round-trip for the audience labels. Lists are aligned
    # with the corresponding *_ids lists by index.
    group_names: list[str]
    person_names: list[str]


class MeetingOut(BaseModel):
    id: int
    tenant_id: int
    kind: Literal["regular", "ad_hoc"]
    title: str
    description: str | None
    location: str | None
    # For ad-hoc only. Null for regular templates.
    date: date | None
    # For regular only. Null for ad-hoc.
    weekday: int | None
    start_time: time
    end_time: time
    organizer_membership_id: int | None
    organizer_name: str | None
    audience: MeetingAudienceOut
    created_at: datetime


class MeetingInstanceOut(BaseModel):
    """Concrete occurrence on a specific date. Returned by
    /meetings/instances — the frontend uses this for the
    planning-grid Reuniones row and /me/reuniones list.

    For ad-hoc meetings there's one instance per meeting. For
    regular templates we emit one instance per matching weekday
    in the requested range (so a Tuesday-10:00 meeting over a
    31-day month becomes ~4 instances).
    """

    meeting_id: int
    kind: Literal["regular", "ad_hoc"]
    title: str
    description: str | None
    location: str | None
    date: date
    start_time: time
    end_time: time
    organizer_name: str | None
    # Whether the caller can edit/delete the meeting. True for
    # tenant admin on every meeting, or for the organizer on
    # their own ad-hoc meeting.
    can_edit: bool
