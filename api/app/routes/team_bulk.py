"""Bulk team invitations via CSV upload.

Two-stage flow:

  POST /api/team/invite/bulk/preview   (multipart file)
      → parses + validates CSV against current tenant state, NO DB writes.
      → returns per-row status (ok | warning | error) plus a summary.

  POST /api/team/invite/bulk/commit    (JSON body of pre-validated rows)
      → re-checks cheap conditions, creates invitations one at a time,
        returns per-row result. Best-effort, no batch transaction.

Why two endpoints (rather than one with `dry_run=true`): cleaner OpenAPI,
easier to reason about, easier to test.
"""

from __future__ import annotations

import csv
import io
import logging
from typing import Iterable

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import validate_email
from sqlalchemy.exc import IntegrityError

from app.models import Category, Invitation
from app.routes.deps import RequestContext, get_current_context
from app.schemas.invite_bulk import (
    BulkCommitInvitation,
    BulkCommitRequest,
    BulkCommitResponse,
    BulkCommitResultRow,
    BulkCommitSummary,
    BulkPreviewResponse,
    BulkPreviewRow,
    BulkPreviewSummary,
)
from app.services.invitations import (
    create_invitation as create_invitation_service,
)
from app.services.invitations import (
    has_live_invitation,
    is_already_member,
)

logger = logging.getLogger("app.team_bulk")

router = APIRouter()

REQUIRED_HEADERS = ["email", "name", "category"]
MAX_FILE_BYTES = 1 * 1024 * 1024  # 1 MB
MAX_ROWS = 5000

# CSV template returned by the GET endpoint and shipped to the frontend.
CSV_TEMPLATE = (
    "email,name,category\r\n"
    "maria@hospital.es,Maria Lopez,Adjunto\r\n"
    "juan@hospital.es,Juan Garcia,Residente R3\r\n"
)


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _strip_bom(text: str) -> str:
    if text.startswith("﻿"):
        return text[1:]
    return text


def _validate_email(value: str) -> str | None:
    """Returns the normalized (lowercased) email or None if invalid."""
    try:
        # Pydantic's validate_email returns (name, email) tuple. Raises
        # PydanticCustomError on invalid input — we catch broadly because that
        # error class isn't part of the public API.
        _, normalized = validate_email(value)
        return normalized.lower()
    except Exception:
        return None


def _parse_csv(raw: bytes) -> list[dict[str, str]]:
    """Parse CSV bytes → list of rows as dicts. Raises HTTPException(400) on
    malformed header. Skips fully blank rows.
    """
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="El archivo debe estar codificado en UTF-8.",
        )
    text = _strip_bom(text)

    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        raise HTTPException(status_code=400, detail="El archivo CSV está vacío.")

    normalized = [(h or "").strip().lower() for h in header]
    if normalized != REQUIRED_HEADERS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Cabecera incorrecta. Se esperaba exactamente: "
                f"{','.join(REQUIRED_HEADERS)}"
            ),
        )

    rows: list[dict[str, str]] = []
    for raw_row in reader:
        # Skip blank lines (all empty / whitespace fields).
        if not raw_row or all((c or "").strip() == "" for c in raw_row):
            continue
        # Pad / truncate to header length.
        padded = (raw_row + [""] * len(REQUIRED_HEADERS))[: len(REQUIRED_HEADERS)]
        rows.append(
            {
                "email": (padded[0] or "").strip(),
                "name": (padded[1] or "").strip(),
                "category": (padded[2] or "").strip(),
            }
        )
        if len(rows) > MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"El archivo supera el máximo de {MAX_ROWS} filas.",
            )
    return rows


def _load_categories_by_lower_name(ctx: RequestContext) -> dict[str, Category]:
    cats = ctx.db.query(Category).filter(Category.tenant_id == ctx.tenant.id).all()
    return {c.name.strip().lower(): c for c in cats}


@router.get("/team/invite/bulk/template")
def download_template():
    from fastapi.responses import Response

    return Response(
        content=CSV_TEMPLATE,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="plantilla-equipo.csv"'
        },
    )


@router.post(
    "/team/invite/bulk/preview",
    response_model=BulkPreviewResponse,
)
async def preview_bulk(
    file: UploadFile = File(...),
    ctx: RequestContext = Depends(get_current_context),
) -> BulkPreviewResponse:
    _require_admin(ctx)

    raw = await file.read()
    if len(raw) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"El archivo supera el máximo de {MAX_FILE_BYTES // 1024} KB.",
        )

    rows = _parse_csv(raw)
    cats_by_name = _load_categories_by_lower_name(ctx)

    out: list[BulkPreviewRow] = []
    seen_emails: set[str] = set()
    valid = warning = errored = 0

    for idx, r in enumerate(rows, start=1):
        email_raw = r["email"]
        name_raw = r["name"]
        cat_raw = r["category"]

        # 1) email format
        normalized_email = _validate_email(email_raw) if email_raw else None
        # 2) name
        name_clean = name_raw.strip()

        error: str | None = None
        warning_msg: str | None = None
        category_id: int | None = None

        if not email_raw:
            error = "El email es obligatorio."
        elif not normalized_email:
            error = "Email no válido."
        elif not name_clean:
            error = "El nombre es obligatorio."
        elif len(name_clean) > 255:
            error = "El nombre supera los 255 caracteres."
        else:
            # Category lookup
            if cat_raw:
                cat = cats_by_name.get(cat_raw.lower())
                if not cat:
                    error = f"La categoría «{cat_raw}» no existe en este equipo."
                else:
                    category_id = cat.id

        if error is None and normalized_email is not None:
            # 3) duplicate within file
            if normalized_email in seen_emails:
                error = "Email duplicado en el archivo."
            else:
                seen_emails.add(normalized_email)

        if error is None and normalized_email is not None:
            # 4) already a member?
            if is_already_member(ctx.db, ctx.tenant.id, normalized_email):
                error = "Esta persona ya es miembro del equipo."

        if error is None and normalized_email is not None:
            # 5) live invitation already exists → warning, not error
            if has_live_invitation(ctx.db, ctx.tenant.id, normalized_email):
                warning_msg = (
                    "Ya existe una invitación pendiente; se reemplazará al confirmar."
                )

        status_code = (
            "error" if error else ("warning" if warning_msg else "ok")
        )
        if status_code == "ok":
            valid += 1
        elif status_code == "warning":
            warning += 1
        else:
            errored += 1

        out.append(
            BulkPreviewRow(
                row_number=idx,
                email=normalized_email or email_raw,
                name=name_clean,
                category=cat_raw or None,
                category_id=category_id,
                status=status_code,
                error=error,
                warning=warning_msg,
            )
        )

    return BulkPreviewResponse(
        rows=out,
        summary=BulkPreviewSummary(
            total_rows=len(out),
            valid_rows=valid,
            warning_rows=warning,
            error_rows=errored,
        ),
    )


@router.post(
    "/team/invite/bulk/commit",
    response_model=BulkCommitResponse,
)
def commit_bulk(
    payload: BulkCommitRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> BulkCommitResponse:
    _require_admin(ctx)

    if len(payload.rows) > MAX_ROWS:
        raise HTTPException(
            status_code=400,
            detail=f"El número de filas supera el máximo de {MAX_ROWS}.",
        )

    results: list[BulkCommitResultRow] = []
    committed = skipped = errored = 0
    seen: set[str] = set()

    for row in payload.rows:
        email_norm = _validate_email(row.email)
        if not email_norm:
            errored += 1
            results.append(
                BulkCommitResultRow(
                    row_number=row.row_number,
                    email=row.email,
                    status="error",
                    reason="Email no válido.",
                )
            )
            continue

        if email_norm in seen:
            skipped += 1
            results.append(
                BulkCommitResultRow(
                    row_number=row.row_number,
                    email=email_norm,
                    status="skipped",
                    reason="Email duplicado en la solicitud.",
                )
            )
            continue
        seen.add(email_norm)

        # Validate category belongs to this tenant if supplied (defensive).
        if row.category_id is not None:
            cat = ctx.db.get(Category, row.category_id)
            if not cat or cat.tenant_id != ctx.tenant.id:
                errored += 1
                results.append(
                    BulkCommitResultRow(
                        row_number=row.row_number,
                        email=email_norm,
                        status="error",
                        reason="Categoría desconocida.",
                    )
                )
                continue

        if is_already_member(ctx.db, ctx.tenant.id, email_norm):
            skipped += 1
            results.append(
                BulkCommitResultRow(
                    row_number=row.row_number,
                    email=email_norm,
                    status="skipped",
                    reason="Ya es miembro del equipo.",
                )
            )
            continue

        try:
            created = create_invitation_service(
                ctx.db,
                tenant_id=ctx.tenant.id,
                email=email_norm,
                person_name=row.name.strip(),
                created_by_membership_id=ctx.membership.id,
                category_id=row.category_id,
                roles=["member"],
            )
        except IntegrityError:
            ctx.db.rollback()
            errored += 1
            results.append(
                BulkCommitResultRow(
                    row_number=row.row_number,
                    email=email_norm,
                    status="error",
                    reason="Conflicto al crear la invitación.",
                )
            )
            continue
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception(
                "Unexpected error creating bulk invitation tenant=%s email=%s: %s",
                ctx.tenant.slug,
                email_norm,
                exc,
            )
            ctx.db.rollback()
            errored += 1
            results.append(
                BulkCommitResultRow(
                    row_number=row.row_number,
                    email=email_norm,
                    status="error",
                    reason="Error inesperado.",
                )
            )
            continue

        committed += 1
        results.append(
            BulkCommitResultRow(
                row_number=row.row_number,
                email=email_norm,
                status="ok",
                invitation=BulkCommitInvitation(
                    id=created.invitation.id,
                    email=created.invitation.email,
                    expires_at=created.invitation.expires_at,
                    accept_url=created.accept_url,
                ),
            )
        )

    logger.warning(
        "Bulk invite commit tenant=%s committed=%s skipped=%s errored=%s",
        ctx.tenant.slug,
        committed,
        skipped,
        errored,
    )

    return BulkCommitResponse(
        results=results,
        summary=BulkCommitSummary(
            committed=committed,
            skipped=skipped,
            errored=errored,
        ),
    )


# Silence unused import warnings if the linter is fussy
_ = (Iterable, Invitation)
