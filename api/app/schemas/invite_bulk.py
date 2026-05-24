from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


PreviewStatus = Literal["ok", "warning", "error"]


class BulkPreviewRow(BaseModel):
    row_number: int
    email: str
    name: str
    category: str | None = None
    category_id: int | None = None
    status: PreviewStatus
    error: str | None = None
    warning: str | None = None


class BulkPreviewSummary(BaseModel):
    total_rows: int
    valid_rows: int
    warning_rows: int
    error_rows: int


class BulkPreviewResponse(BaseModel):
    rows: list[BulkPreviewRow]
    summary: BulkPreviewSummary


class BulkCommitRow(BaseModel):
    row_number: int
    email: str
    name: str = Field(min_length=1, max_length=255)
    category_id: int | None = None


class BulkCommitRequest(BaseModel):
    rows: list[BulkCommitRow]
    # Mirror of InviteCreateRequest.send_email: when false the
    # endpoint creates the Person + Membership + Invitation rows but
    # skips the email blast. Used by the onboarding /team step so
    # the admin can bulk-load the roster up-front and deliver the
    # invitations later from /admin/team. Default true to preserve
    # /admin/team's existing behaviour.
    send_email: bool = True


class BulkCommitInvitation(BaseModel):
    id: int
    email: str
    expires_at: datetime
    accept_url: str


CommitRowStatus = Literal["ok", "skipped", "error"]


class BulkCommitResultRow(BaseModel):
    row_number: int
    email: str
    status: CommitRowStatus
    reason: str | None = None
    invitation: BulkCommitInvitation | None = None


class BulkCommitSummary(BaseModel):
    committed: int
    skipped: int
    errored: int


class BulkCommitResponse(BaseModel):
    results: list[BulkCommitResultRow]
    summary: BulkCommitSummary
