"""Schedule PDF export.

WeasyPrint renders a Jinja-templated HTML page into a one-or-two page
landscape PDF. The layout splits the month into TWO horizontal slices
of ~half the days each, stacked vertically on a single landscape page
when they fit and spilling onto a second page when they don't. Same
output for admin and members — members only get the public file if
the schedule is published or archived (draft access is admin-only,
matching what the planning grid already does).

The function is intentionally pure (no DB / FastAPI dependencies) so
it can be exercised from tests with synthetic data.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"
TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates" / "pdf"

_env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=select_autoescape(["html", "xml"]),
    trim_blocks=True,
    lstrip_blocks=True,
)


# Spanish weekday short-labels (Mon..Sun). Matches the planning grid
# ordering so the PDF reads identically.
_WEEKDAY_LABELS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]


def _last_name(full_name: str | None, last_name: str | None) -> str:
    """Mirror of the frontend `personLastName` helper. Use the
    explicit last_name field when set (Sprint 18+); otherwise
    fall back to the last whitespace-separated token of the
    canonical `name` for legacy rows.

    Result drives every cell + Libre chip in the PDF — the same
    convention the on-screen grids use, so a printed plan reads
    identically to /me/turnos and /lead/planificacion.
    """
    if last_name and last_name.strip():
        return last_name.strip()
    if not full_name:
        return ""
    parts = full_name.strip().split()
    return parts[-1] if parts else full_name


@dataclass(frozen=True)
class PdfRow:
    """One slot/role row in the PDF grid. Mirrors PlanningGrid rows on
    the frontend so the visual output matches what admins see online."""
    slot_id: int
    slot_name: str
    slot_position: int
    team_role_label: str | None
    color: str | None
    # date_iso (YYYY-MM-DD) -> ordered list of (person_name, role_label_or_none)
    cells: dict[str, list[tuple[str, str | None]]]


@dataclass(frozen=True)
class PdfAbsence:
    person_name: str
    block_type: str


def build_rows_from_assignments(
    assignments: list[Any],
) -> list[PdfRow]:
    """Pivot an assignments list (SQLAlchemy Assignment + joined Slot /
    Person / SlotTeamRole tuples, OR pre-built dicts with the same keys)
    into PdfRow shape. Accepts the same tuple shape used by
    `_serialize_detail` so route code can pass already-fetched rows
    straight in."""
    # rows keyed by (slot_id, team_role_label_or_None)
    bucket: dict[tuple[int, str | None], PdfRow] = {}
    for a, s, p, tr in assignments:
        key = (s.id, tr.role_label if tr else None)
        row = bucket.get(key)
        if row is None:
            row = PdfRow(
                slot_id=s.id,
                slot_name=s.name,
                slot_position=s.position,
                team_role_label=tr.role_label if tr else None,
                color=s.color,
                cells=defaultdict(list),
            )
            bucket[key] = row
        d_iso = a.date.isoformat()
        # Last name only — matches the on-screen planning grids
        # so a printed plan reads the same way ("Tovar", not
        # "H. Tovar"). p.last_name is populated for Sprint-18+
        # rows; legacy rows fall back to the last token of name.
        person_label = (
            _last_name(p.name, getattr(p, "last_name", None))
            if p
            else None
        )
        row.cells[d_iso].append(
            (person_label or "—", tr.role_label if tr else None)
        )
    # Sort: slot position (admin-controlled) → slot name → role.
    return sorted(
        bucket.values(),
        key=lambda r: (
            r.slot_position,
            r.slot_name,
            (r.team_role_label or ""),
        ),
    )


def build_absences_by_date(
    team_absences: list[Any], dates: list[date]
) -> dict[str, list[PdfAbsence]]:
    """Expand TeamAbsence ranges into per-date lists. The grid Libre row
    in the PDF reads from this map."""
    out: dict[str, list[PdfAbsence]] = defaultdict(list)
    for d in dates:
        d_iso = d.isoformat()
        seen: set[int] = set()
        for a in team_absences:
            if a.start_date <= d <= a.end_date and a.person_id not in seen:
                seen.add(a.person_id)
                out[d_iso].append(
                    PdfAbsence(
                        # Same last-name-only rule the assignment
                        # cells use — keeps the Libre row visually
                        # aligned with the rest of the grid.
                        person_name=_last_name(
                            a.person_name,
                            getattr(a, "person_last_name", None),
                        ),
                        block_type=a.block_type,
                    )
                )
        # Stable alphabetical so the PDF doesn't shuffle on every render.
        out[d_iso].sort(key=lambda x: x.person_name)
    return out


def render_schedule_pdf(
    *,
    schedule_period: date,
    schedule_status: str,
    rows: list[PdfRow],
    absences_by_date: dict[str, list[PdfAbsence]],
    holiday_dates: set[date],
    tenant_name: str,
    generated_at: datetime,
) -> bytes:
    """Render the full schedule PDF (full month, identical content for
    admin and members)."""
    # Lazy import — WeasyPrint pulls in cairo/pango at import time, and
    # importing it at module load would balloon worker startup for a
    # rarely-used feature.
    from weasyprint import HTML

    days = _days_in_month(schedule_period)
    # Two-row layout: ~half the days each. Splits at ceil(n/2) so when
    # the month has an odd number of days the first row is longer.
    half = (len(days) + 1) // 2
    chunks = [days[:half], days[half:]]

    # Drop empty chunks (single-day or empty schedules — defensive).
    chunks = [c for c in chunks if c]

    chunk_data = []
    for chunk in chunks:
        chunk_data.append(
            {
                "dates": [
                    {
                        "iso": d.isoformat(),
                        "day": d.day,
                        "weekday": _WEEKDAY_LABELS[d.weekday()],
                        "is_weekend": d.weekday() >= 5,
                        "is_holiday": d in holiday_dates,
                    }
                    for d in chunk
                ],
                "rows": [
                    {
                        "slot_name": r.slot_name,
                        "team_role_label": r.team_role_label,
                        "color": r.color,
                        "cells": [
                            [
                                {"person_name": pn, "role_label": rl}
                                for pn, rl in r.cells.get(d.isoformat(), [])
                            ]
                            for d in chunk
                        ],
                    }
                    for r in rows
                ],
                "absences": [
                    [
                        {"person_name": a.person_name}
                        for a in absences_by_date.get(d.isoformat(), [])
                    ]
                    for d in chunk
                ],
            }
        )

    status_label = {
        "draft": "Borrador",
        "published": "Publicada",
        "archived": "Archivada",
    }.get(schedule_status, schedule_status)
    spanish_month = _spanish_month(schedule_period)

    template = _env.get_template("schedule.html.j2")
    html_string = template.render(
        chunks=chunk_data,
        tenant_name=tenant_name,
        period_label=spanish_month,
        status_label=status_label,
        generated_at=generated_at.strftime("%Y-%m-%d %H:%M"),
        logo_url=(ASSETS_DIR / "logo.jpeg").as_uri(),
    )
    return HTML(string=html_string, base_url=str(ASSETS_DIR)).write_pdf()


def _days_in_month(period: date) -> list[date]:
    last = calendar.monthrange(period.year, period.month)[1]
    return [date(period.year, period.month, d) for d in range(1, last + 1)]


_SPANISH_MONTHS = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]


def _spanish_month(d: date) -> str:
    return f"{_SPANISH_MONTHS[d.month - 1].capitalize()} {d.year}"


def schedule_pdf_filename(period: date) -> str:
    """Same name for everyone, per the spec: planificacion-YYYY-MM.pdf."""
    return f"planificacion-{period.strftime('%Y-%m')}.pdf"
