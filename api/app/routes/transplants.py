"""Transplant case log CRUD + stats.

Admin-only — surgeon participation is sensitive enough that we
gate it the same way as /admin/team. Members don't see anything
transplant-related in their /me view (yet).

Cases are written together with their procedures in a single
request: clients think of "a transplant" as the atomic unit
(one patient, one organ, 1–2 operative events) and dealing with
case-then-procedures as a two-step would invite half-saved
states. PATCH replaces the procedure list atomically — the UI
re-sends everything that should remain.

`occurred_on` (the case date) is computed server-side as
`min(occurred_at)` across all procedures, so the client never
has to send a redundant field.
"""

from collections import defaultdict
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func

from app.models import Membership, Person, TransplantCase, TransplantProcedure
from app.routes.deps import RequestContext, get_current_context
from app.schemas.transplant import (
    TransplantCaseCreate,
    TransplantCaseOut,
    TransplantCaseUpdate,
    TransplantProcedureIn,
    TransplantProcedureOut,
    TransplantStatsMonthOut,
    TransplantStatsOut,
    TransplantStatsSurgeonOut,
)

router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _person_name_map(ctx: RequestContext, person_ids: set[int]) -> dict[int, str]:
    """Resolve a set of person ids to display names in one query."""
    if not person_ids:
        return {}
    return {
        pid: name
        for pid, name in (
            ctx.db.query(Person.id, Person.name)
            .filter(Person.id.in_(person_ids))
            .all()
        )
    }


def _validate_person_ids(
    ctx: RequestContext, person_ids: set[int]
) -> None:
    """Make sure every person id belongs to the caller's tenant.
    Raises 422 with the offending ids; cheaper than letting the
    INSERT fail on the FK and unwinding the transaction."""
    if not person_ids:
        return
    found = {
        pid
        for (pid,) in ctx.db.query(Membership.person_id)
        .filter(
            Membership.person_id.in_(person_ids),
            Membership.tenant_id == ctx.tenant.id,
        )
        .distinct()
        .all()
    }
    missing = person_ids - found
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown person_ids in this tenant: {sorted(missing)}",
        )


def _collect_person_ids(procs: list[TransplantProcedureIn]) -> set[int]:
    out: set[int] = set()
    for p in procs:
        if p.primary_person_id is not None:
            out.add(p.primary_person_id)
        if p.secondary_person_id is not None:
            out.add(p.secondary_person_id)
    return out


def _serialize_case(
    case: TransplantCase, names: dict[int, str]
) -> TransplantCaseOut:
    has_explante = any(p.type == "explante" for p in case.procedures)
    has_implante = any(p.type == "implante" for p in case.procedures)
    # Cross-hospital = at least one procedure has no local
    # primary surgeon. That's how the legacy data encodes
    # "received from" or "sent to" another hospital.
    cross_hospital = any(p.primary_person_id is None for p in case.procedures)
    return TransplantCaseOut(
        id=case.id,
        tenant_id=case.tenant_id,
        external_case_id=case.external_case_id,
        occurred_on=case.occurred_on,
        notes=case.notes,
        procedures=[
            TransplantProcedureOut(
                id=p.id,
                type=p.type,
                occurred_at=p.occurred_at,
                primary_person_id=p.primary_person_id,
                primary_person_name=(
                    names.get(p.primary_person_id)
                    if p.primary_person_id
                    else None
                ),
                secondary_person_id=p.secondary_person_id,
                secondary_person_name=(
                    names.get(p.secondary_person_id)
                    if p.secondary_person_id
                    else None
                ),
                notes=p.notes,
            )
            for p in case.procedures
        ],
        has_explante=has_explante,
        has_implante=has_implante,
        is_cross_hospital=cross_hospital,
        created_at=case.created_at,
        updated_at=case.updated_at,
    )


def _serialize_many(
    ctx: RequestContext, cases: list[TransplantCase]
) -> list[TransplantCaseOut]:
    """Batch-resolve names across all procedures to avoid N+1."""
    person_ids: set[int] = set()
    for c in cases:
        for p in c.procedures:
            if p.primary_person_id:
                person_ids.add(p.primary_person_id)
            if p.secondary_person_id:
                person_ids.add(p.secondary_person_id)
    names = _person_name_map(ctx, person_ids)
    return [_serialize_case(c, names) for c in cases]


def _get_or_404(ctx: RequestContext, case_id: int) -> TransplantCase:
    case = ctx.db.get(TransplantCase, case_id)
    if not case or case.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Transplant case not found")
    return case


def _derive_occurred_on(procs: list[TransplantProcedureIn]) -> date:
    return min(p.occurred_at for p in procs).date()


def _replace_procedures(
    ctx: RequestContext,
    case: TransplantCase,
    new_procs: list[TransplantProcedureIn],
) -> None:
    """Atomically replace the case's procedures with the supplied
    list. Caller has already validated person ids.

    Uses delete-orphan via the relationship cascade, but we do an
    explicit delete-then-add to keep the SQL straightforward and
    side-step any ordering ambiguity SQLAlchemy might introduce
    inside one flush."""
    for p in list(case.procedures):
        ctx.db.delete(p)
    ctx.db.flush()
    for p_in in new_procs:
        ctx.db.add(
            TransplantProcedure(
                tenant_id=ctx.tenant.id,
                case_id=case.id,
                type=p_in.type,
                occurred_at=p_in.occurred_at,
                primary_person_id=p_in.primary_person_id,
                secondary_person_id=p_in.secondary_person_id,
                notes=(p_in.notes.strip() if p_in.notes else None) or None,
            )
        )
    ctx.db.flush()


# ---------------------------------------------------------------------------
# List + CRUD
# ---------------------------------------------------------------------------


@router.get("/transplants", response_model=list[TransplantCaseOut])
def list_transplants(
    ctx: RequestContext = Depends(get_current_context),
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    person_id: int | None = Query(
        default=None,
        description="Filter cases where this person appears as a "
        "primary OR secondary surgeon on any procedure.",
    ),
    type: str | None = Query(default=None, description="explante or implante"),
    cross_hospital: bool | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=2000),
) -> list[TransplantCaseOut]:
    _require_admin(ctx)
    q = ctx.db.query(TransplantCase)
    if from_date is not None:
        q = q.filter(TransplantCase.occurred_on >= from_date)
    if to_date is not None:
        q = q.filter(TransplantCase.occurred_on <= to_date)
    # `type` / `person_id` / `cross_hospital` are about procedures —
    # join + filter, then DISTINCT so a case with two matching
    # procedures shows up once.
    proc_filters_active = (
        person_id is not None or type is not None or cross_hospital is True
    )
    if proc_filters_active:
        q = q.join(
            TransplantProcedure,
            TransplantProcedure.case_id == TransplantCase.id,
        )
        if person_id is not None:
            q = q.filter(
                (TransplantProcedure.primary_person_id == person_id)
                | (TransplantProcedure.secondary_person_id == person_id)
            )
        if type is not None:
            if type not in ("explante", "implante"):
                raise HTTPException(
                    status_code=422,
                    detail="type must be 'explante' or 'implante'",
                )
            q = q.filter(TransplantProcedure.type == type)
        if cross_hospital is True:
            q = q.filter(TransplantProcedure.primary_person_id.is_(None))
        q = q.distinct()
    elif cross_hospital is False:
        # Cases where EVERY procedure has a local primary surgeon —
        # easier to express as NOT EXISTS than via the join above.
        q = q.filter(
            ~ctx.db.query(TransplantProcedure.id)
            .filter(
                TransplantProcedure.case_id == TransplantCase.id,
                TransplantProcedure.primary_person_id.is_(None),
            )
            .exists()
        )
    cases = (
        q.order_by(TransplantCase.occurred_on.desc(), TransplantCase.id.desc())
        .limit(limit)
        .all()
    )
    return _serialize_many(ctx, cases)


@router.get("/transplants/stats", response_model=TransplantStatsOut)
def transplants_stats(
    ctx: RequestContext = Depends(get_current_context),
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
) -> TransplantStatsOut:
    _require_admin(ctx)
    # Range filter applied at the case level — months/surgeon
    # rollups query off the procedure rows of the matching cases.
    case_q = ctx.db.query(TransplantCase.id)
    if from_date is not None:
        case_q = case_q.filter(TransplantCase.occurred_on >= from_date)
    if to_date is not None:
        case_q = case_q.filter(TransplantCase.occurred_on <= to_date)
    case_ids_in_range = {row[0] for row in case_q.all()}

    if not case_ids_in_range:
        return TransplantStatsOut(
            total_cases=0,
            total_procedures=0,
            explante_total=0,
            implante_total=0,
            cross_hospital_cases=0,
            months=[],
            surgeons=[],
        )

    procs = (
        ctx.db.query(TransplantProcedure)
        .filter(TransplantProcedure.case_id.in_(case_ids_in_range))
        .all()
    )

    total_procedures = len(procs)
    explante_total = sum(1 for p in procs if p.type == "explante")
    implante_total = total_procedures - explante_total

    # Per-month bars. Key by (year, month) tuple, count per type
    # AND track cross-hospital (NULL primary) on the side.
    months_agg: dict[tuple[int, int], dict[str, int]] = defaultdict(
        lambda: {"explante": 0, "implante": 0, "cross_hospital": 0}
    )
    for p in procs:
        d = p.occurred_at.date()
        key = (d.year, d.month)
        months_agg[key][p.type] += 1
        if p.primary_person_id is None:
            months_agg[key]["cross_hospital"] += 1
    months_out = [
        TransplantStatsMonthOut(
            period=date(y, m, 1),
            explante_count=v["explante"],
            implante_count=v["implante"],
            cross_hospital_count=v["cross_hospital"],
        )
        for (y, m), v in sorted(months_agg.items())
    ]

    # Surgeon participation. Aggregate primary / secondary / type
    # counts in one pass.
    surgeon_agg: dict[int, dict[str, int]] = defaultdict(
        lambda: {
            "primary": 0,
            "secondary": 0,
            "explante": 0,
            "implante": 0,
        }
    )
    for p in procs:
        if p.primary_person_id is not None:
            surgeon_agg[p.primary_person_id]["primary"] += 1
            surgeon_agg[p.primary_person_id][p.type] += 1
        if p.secondary_person_id is not None:
            surgeon_agg[p.secondary_person_id]["secondary"] += 1
            # Don't double-count type for secondary slot — primary's
            # entry already attributes the procedure to its type.

    names = _person_name_map(ctx, set(surgeon_agg.keys()))
    surgeons_out = sorted(
        [
            TransplantStatsSurgeonOut(
                person_id=pid,
                person_name=names.get(pid, "(desconocido)"),
                primary_count=v["primary"],
                secondary_count=v["secondary"],
                explante_count=v["explante"],
                implante_count=v["implante"],
            )
            for pid, v in surgeon_agg.items()
        ],
        # Primary participation drives the sort — that's the
        # "your transplant load" number most people will compare.
        key=lambda s: (-s.primary_count, -s.secondary_count, s.person_name),
    )

    # Cross-hospital is a CASE-level concept (any procedure on
    # the case missing its local primary). Count distinct cases.
    cross_hospital_case_ids = {p.case_id for p in procs if p.primary_person_id is None}

    return TransplantStatsOut(
        total_cases=len(case_ids_in_range),
        total_procedures=total_procedures,
        explante_total=explante_total,
        implante_total=implante_total,
        cross_hospital_cases=len(cross_hospital_case_ids),
        months=months_out,
        surgeons=surgeons_out,
    )


@router.get("/transplants/{case_id}", response_model=TransplantCaseOut)
def get_transplant(
    case_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> TransplantCaseOut:
    _require_admin(ctx)
    case = _get_or_404(ctx, case_id)
    return _serialize_many(ctx, [case])[0]


@router.post(
    "/transplants",
    response_model=TransplantCaseOut,
    status_code=status.HTTP_201_CREATED,
)
def create_transplant(
    payload: TransplantCaseCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> TransplantCaseOut:
    _require_admin(ctx)
    _validate_person_ids(ctx, _collect_person_ids(payload.procedures))
    case = TransplantCase(
        tenant_id=ctx.tenant.id,
        external_case_id=(
            payload.external_case_id.strip()
            if payload.external_case_id
            else None
        )
        or None,
        occurred_on=_derive_occurred_on(payload.procedures),
        notes=(payload.notes.strip() if payload.notes else None) or None,
    )
    ctx.db.add(case)
    ctx.db.flush()
    _replace_procedures(ctx, case, payload.procedures)
    ctx.db.refresh(case)
    return _serialize_many(ctx, [case])[0]


@router.put("/transplants/{case_id}", response_model=TransplantCaseOut)
def update_transplant(
    case_id: int,
    payload: TransplantCaseUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> TransplantCaseOut:
    _require_admin(ctx)
    case = _get_or_404(ctx, case_id)
    _validate_person_ids(ctx, _collect_person_ids(payload.procedures))
    case.external_case_id = (
        payload.external_case_id.strip()
        if payload.external_case_id
        else None
    ) or None
    case.notes = (payload.notes.strip() if payload.notes else None) or None
    case.occurred_on = _derive_occurred_on(payload.procedures)
    # `updated_at` is server-managed; touching it here keeps the
    # value sane even if SQLAlchemy's onupdate doesn't fire on
    # pure-children edits (it doesn't reliably).
    case.updated_at = datetime.now(timezone.utc)
    _replace_procedures(ctx, case, payload.procedures)
    ctx.db.refresh(case)
    return _serialize_many(ctx, [case])[0]


@router.delete(
    "/transplants/{case_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_transplant(
    case_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    case = _get_or_404(ctx, case_id)
    ctx.db.delete(case)
    ctx.db.flush()
