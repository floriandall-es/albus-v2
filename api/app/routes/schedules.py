"""Schedule + assignment endpoints (admin-only).

Sprint 4 ships the greedy stub generator behind these endpoints. Editing
individual assignments is out of scope (Sprint 5).
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status

from app.models import Assignment, Person, Schedule, Slot, SlotTeamRole
from app.routes.deps import RequestContext, get_current_context
from app.schemas.schedule import (
    AssignmentOut,
    ScheduleDetail,
    ScheduleGenerateRequest,
    ScheduleOut,
)
from app.services import scheduler

router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _serialize_detail(ctx: RequestContext, schedule: Schedule) -> ScheduleDetail:
    rows = (
        ctx.db.query(Assignment, Slot, Person, SlotTeamRole)
        .join(Slot, Slot.id == Assignment.slot_id)
        .outerjoin(Person, Person.id == Assignment.person_id)
        .outerjoin(SlotTeamRole, SlotTeamRole.id == Assignment.team_role_id)
        .filter(Assignment.schedule_id == schedule.id)
        .order_by(Assignment.date, Assignment.slot_id, Assignment.id)
        .all()
    )
    assignments = [
        AssignmentOut(
            id=a.id,
            schedule_id=a.schedule_id,
            slot_id=a.slot_id,
            slot_name=s.name,
            date=a.date,
            person_id=a.person_id,
            person_name=p.name if p else None,
            team_role_id=a.team_role_id,
            team_role_label=tr.role_label if tr else None,
            notes=a.notes,
        )
        for a, s, p, tr in rows
    ]
    return ScheduleDetail(
        id=schedule.id,
        tenant_id=schedule.tenant_id,
        period=schedule.period,
        status=schedule.status,  # type: ignore[arg-type]
        generated_at=schedule.generated_at,
        published_at=schedule.published_at,
        created_at=schedule.created_at,
        assignments=assignments,
    )


@router.get("/schedules", response_model=list[ScheduleOut])
def list_schedules(
    ctx: RequestContext = Depends(get_current_context),
) -> list[Schedule]:
    return (
        ctx.db.query(Schedule)
        .order_by(Schedule.period.desc(), Schedule.id.desc())
        .all()
    )


@router.get("/schedules/{schedule_id}", response_model=ScheduleDetail)
def get_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> ScheduleDetail:
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return _serialize_detail(ctx, s)


@router.post(
    "/schedules/generate",
    response_model=ScheduleDetail,
    status_code=status.HTTP_201_CREATED,
)
def generate(
    payload: ScheduleGenerateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> ScheduleDetail:
    _require_admin(ctx)
    period = date(payload.period.year, payload.period.month, 1)

    existing = (
        ctx.db.query(Schedule)
        .filter(Schedule.period == period)
        .first()
    )
    if existing:
        if existing.status == "published":
            raise HTTPException(
                status_code=400,
                detail=(
                    "Ya hay una planificación publicada para "
                    f"{period.strftime('%Y-%m')} — archívala primero"
                ),
            )
        # Draft or archived: replace.
        ctx.db.delete(existing)
        ctx.db.flush()

    schedule = scheduler.generate_draft(
        ctx.db,
        tenant_id=ctx.tenant.id,
        period=period,
        membership_id=ctx.membership.id,
    )
    return _serialize_detail(ctx, schedule)


@router.post("/schedules/{schedule_id}/publish", response_model=ScheduleOut)
def publish_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Schedule:
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if s.status != "draft":
        raise HTTPException(
            status_code=400, detail="Solo se pueden publicar planificaciones en borrador"
        )
    scheduler.publish(ctx.db, s)
    return s


@router.post("/schedules/{schedule_id}/archive", response_model=ScheduleOut)
def archive_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Schedule:
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    scheduler.archive(ctx.db, s)
    return s


@router.delete(
    "/schedules/{schedule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if s.status != "draft":
        raise HTTPException(
            status_code=400, detail="Solo se pueden eliminar planificaciones en borrador"
        )
    ctx.db.delete(s)
    ctx.db.flush()
