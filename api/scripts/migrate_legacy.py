"""One-off CSV → Trivu migration for the alpha customer (legacy
thoracic-surgery scheduler).

Reads the Cloud SQL Studio CSV exports from
`data/legacy-migration/` and builds a fresh tenant containing:

  - The customer's 9 user accounts (admin + sub-equipo lead + 7
    surgeons) and 7 resident profiles, all created as
    `pendientes` (NULL password) so they activate via the
    existing invitation flow post-cutover.
  - One sub-equipo ("Residentes") with the residentes user
    account as its lead.
  - 9 main-team slots and 7 sub-equipo slots, named from the
    source role enum (`consulta`, `quirofano_1`, `implante_1`,
    `neumologo`, etc.).
  - 5 monthly schedules (Feb–Jun 2026) with DRAFT / PUBLISHED
    status preserved, plus ~2 400 assignments.
  - 102 availability_blocks from the source `vacations` table,
    16 holidays, and 25 incident-log entries from `notes`.

Skipped on purpose (counts go in the final report):

  - `surgeries` (513 rows) — historical OR case log, no Trivu
    model.
  - `surgeons` (8 rows) — directory used only by `surgeries`.
  - `audit_log` (1 001 rows) — internal app log, zero value.
  - `events` (317), `vacation_locks` (76) — purpose unclear,
    customer chose skip.
  - `swap_*` (16 total) — history only.
  - `libre` shift rows — they mean "off", not an assignment.

Usage (from `api/`):

    python -m scripts.migrate_legacy           # dry-run, no commit
    python -m scripts.migrate_legacy --commit  # actually apply

Idempotent only via the tenant-slug guard. If a previous run
failed partway, drop the tenant first:

    DELETE FROM tenants WHERE slug = 'cirugia-toracica-hospital-la-fe';

then re-run.
"""

from __future__ import annotations

import argparse
import csv
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy.orm import Session

from app.db.session import SessionLocal, set_tenant
from app.models import (
    Assignment,
    AvailabilityBlock,
    Category,
    Group,
    Holiday,
    Incident,
    Membership,
    Person,
    Schedule,
    Slot,
    Tenant,
)


# ---------------------------------------------------------------------------
# Config (customer-specific)
# ---------------------------------------------------------------------------

TENANT_NAME = "Cirugía Torácica — Hospital La Fe"
TENANT_SLUG = "cirugia-toracica-hospital-la-fe"
COUNTRY_CODE = "ES"
REGION_CODE = "ES-VC"
PRESET_KIND = "quirurgico"
HAS_SUBTEAMS = True

# Categorías we create. Most surgeons in the source data have no
# explicit categoría — we put them all under "Adjunto" and the
# admin can split later (Jefe, Adjunto, etc.).
CATEGORY_ADJUNTO = "Adjunto"
CATEGORY_RESIDENTE = "Residente"

SUBTEAM_NAME = "Residentes"


# ---------------------------------------------------------------------------
# CSV layout (Cloud SQL Studio exports have parens in their filenames)
# ---------------------------------------------------------------------------

DATA_DIR = (
    Path(__file__).resolve().parent.parent.parent
    / "data"
    / "legacy-migration"
)

CSV = {
    "users": "studio_results_20260521_1044 (2).csv",
    "user_surgeon_map": "studio_results_20260521_1042 (3).csv",
    "residents": "studio_results_20260521_1041 (3).csv",
    "surgeon_shifts": "studio_results_20260521_1042 (2).csv",
    "resident_shifts": "studio_results_20260521_1042.csv",
    "vacations": "studio_results_20260521_1041 (1).csv",
    "holidays": "studio_results_20260521_1041 (4).csv",
    "notes": "studio_results_20260521_1041 (2).csv",
}


# ---------------------------------------------------------------------------
# Slot definitions (derived from source `role` enums; `libre` is
# excluded because it means "no assignment", not a slot)
# ---------------------------------------------------------------------------

MAIN_TEAM_SLOTS = [
    "consulta",
    "explante",
    "guardia",
    "implante_1",
    "implante_2",
    "neumologo",
    "planta",
    "quirofano_1",
    "quirofano_2",
]

# `rotacion` is a real activity for residents per customer
# confirmation (rotating residents from other services).
RESIDENT_SLOTS = [
    "consulta",
    "explante",
    "guardia",
    "implante",
    "planta",
    "quirofano",
    "rotacion",
]


def slot_display_name(slug: str) -> str:
    """Convert the source role slug into a human-readable name
    for the Trivu Slot.name field. The admin can rename in
    /admin/slots after migration."""
    table = {
        "consulta": "Consulta",
        "explante": "Explante",
        "guardia": "Guardia",
        "implante_1": "Implante 1",
        "implante_2": "Implante 2",
        "implante": "Implante",
        "neumologo": "Neumólogo",
        "planta": "Planta",
        "quirofano_1": "Quirófano 1",
        "quirofano_2": "Quirófano 2",
        "quirofano": "Quirófano",
        "rotacion": "Rotación",
    }
    return table.get(slug, slug.replace("_", " ").title())


# ---------------------------------------------------------------------------
# Vacation reason → block_type mapping
# ---------------------------------------------------------------------------


def map_vacation_reason(reason: str) -> str:
    r = (reason or "").lower()
    if "congreso" in r or "curso" in r:
        return "training"
    if "vacacion" in r:
        return "vacation"
    if "libre" in r or "disposici" in r:
        return "personal"
    return "other"


def map_holiday_source(scope: str) -> str:
    s = (scope or "").strip().lower()
    if s == "national":
        return "national"
    if s == "regional":
        return "regional"
    return "custom"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def read_csv(filename: str) -> list[dict[str, str]]:
    with (DATA_DIR / filename).open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def parse_date(s: str) -> date:
    """Source dates are ISO with a Z suffix; we only need the
    date portion."""
    return datetime.fromisoformat(s.replace("Z", "+00:00")).date()


def normalize_last_name(s: str) -> str:
    """Lower-case, strip diacritics, strip whitespace. Used to
    match assignee_name free-text against the residents and
    users tables."""
    s = (s or "").strip().lower()
    nfkd = unicodedata.normalize("NFD", s)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))


def split_name(full: str) -> tuple[str | None, str | None]:
    """Best-effort first/last split from a single-string name.
    The source `users.name` field carries last names (e.g.
    "Fontana") so this is mostly a no-op; we leave first_name
    NULL and put the whole thing in last_name."""
    full = (full or "").strip()
    if not full:
        return None, None
    parts = full.split()
    if len(parts) == 1:
        return None, parts[0]
    return parts[0], " ".join(parts[1:])


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------


def run_migration(db: Session) -> dict[str, Any]:
    """Returns a dict of counts + skipped-with-reasons for the
    final report. Raises on any unrecoverable error — caller
    decides commit vs rollback."""

    report: dict[str, Any] = {
        "tenant_id": None,
        "counts": Counter(),
        "skipped": Counter(),
        "warnings": [],
    }

    # ------------------------------------------------------------------
    # 0. Guard rail — never overwrite an existing tenant
    # ------------------------------------------------------------------
    existing = db.query(Tenant).filter(Tenant.slug == TENANT_SLUG).first()
    if existing:
        raise RuntimeError(
            f"Tenant with slug '{TENANT_SLUG}' already exists "
            f"(id={existing.id}). Drop it before re-running."
        )

    # ------------------------------------------------------------------
    # 1. Read everything up-front
    # ------------------------------------------------------------------
    src_users = read_csv(CSV["users"])
    src_usm = read_csv(CSV["user_surgeon_map"])
    src_residents = read_csv(CSV["residents"])
    src_surgeon_shifts = read_csv(CSV["surgeon_shifts"])
    src_resident_shifts = read_csv(CSV["resident_shifts"])
    src_vacations = read_csv(CSV["vacations"])
    src_holidays = read_csv(CSV["holidays"])
    src_notes = read_csv(CSV["notes"])

    print(
        f"Read CSVs: users={len(src_users)}, "
        f"user_surgeon_map={len(src_usm)}, "
        f"residents={len(src_residents)}, "
        f"surgeon_shifts={len(src_surgeon_shifts)}, "
        f"resident_shifts={len(src_resident_shifts)}, "
        f"vacations={len(src_vacations)}, "
        f"holidays={len(src_holidays)}, "
        f"notes={len(src_notes)}"
    )

    # ------------------------------------------------------------------
    # 2. Tenant
    # ------------------------------------------------------------------
    tenant = Tenant(
        name=TENANT_NAME,
        slug=TENANT_SLUG,
        country_code=COUNTRY_CODE,
        region_code=REGION_CODE,
        preset_kind=PRESET_KIND,
        has_subteams=HAS_SUBTEAMS,
        onboarding_completed_at=datetime.now(timezone.utc),
    )
    db.add(tenant)
    db.flush()
    set_tenant(db, tenant.id)
    report["tenant_id"] = tenant.id
    report["counts"]["tenants"] = 1

    # ------------------------------------------------------------------
    # 3. Categorías
    # ------------------------------------------------------------------
    cat_adjunto = Category(tenant_id=tenant.id, name=CATEGORY_ADJUNTO)
    cat_residente = Category(tenant_id=tenant.id, name=CATEGORY_RESIDENTE)
    db.add_all([cat_adjunto, cat_residente])
    db.flush()
    report["counts"]["categories"] = 2

    # ------------------------------------------------------------------
    # 4. Persons + Memberships from `users` table.
    #    Build indexes to resolve shift FKs later.
    # ------------------------------------------------------------------
    # source user_id → Person row + Membership row
    person_by_user_id: dict[str, Person] = {}
    membership_by_user_id: dict[str, Membership] = {}
    # Lowercased last-name → Person, used to resolve the free-text
    # `assignee_name` on neumologo shifts. Built up as we create
    # users + residents.
    person_by_lastname: dict[str, Person] = {}

    # Find the "Residentes" user so we can mark them as lead later.
    residentes_user = None

    for u in src_users:
        first, last = split_name(u["name"])
        role = u.get("role", "")
        is_admin = role == "ADMIN"
        is_resident_admin = role == "RESIDENT_ADMIN"
        # All migrated users start as pendientes — source hashes are
        # SHA-256, not bcrypt, so we can't reuse them. They activate
        # post-cutover via the standard invitation accept flow.
        person = Person(
            email=u["email"].lower(),
            name=u["name"],
            first_name=first,
            last_name=last,
            hashed_password=None,
        )
        db.add(person)
        db.flush()
        person_by_user_id[u["id"]] = person
        if last:
            person_by_lastname[normalize_last_name(last)] = person

        ms = Membership(
            tenant_id=tenant.id,
            person_id=person.id,
            roles=["admin"] if is_admin else ["member"],
            category_id=(
                None
                if is_admin or is_resident_admin
                else cat_adjunto.id
            ),
            fte_pct=100,
        )
        db.add(ms)
        db.flush()
        membership_by_user_id[u["id"]] = ms

        if is_resident_admin:
            residentes_user = u

    report["counts"]["persons_from_users"] = len(src_users)
    report["counts"]["memberships_from_users"] = len(src_users)

    # ------------------------------------------------------------------
    # 5. Residentes sub-equipo + its lead
    # ------------------------------------------------------------------
    group = Group(
        tenant_id=tenant.id,
        name=SUBTEAM_NAME,
        lead_membership_id=(
            membership_by_user_id[residentes_user["id"]].id
            if residentes_user
            else None
        ),
    )
    db.add(group)
    db.flush()
    report["counts"]["groups"] = 1

    # ------------------------------------------------------------------
    # 6. Resident profiles → persons + memberships in the sub-equipo.
    #    Source residents have no email; we generate placeholders so
    #    the unique-email constraint holds. The admin can swap real
    #    emails in via /admin/team if/when they want residents in the
    #    app.
    # ------------------------------------------------------------------
    person_by_resident_id: dict[str, Person] = {}
    for r in src_residents:
        display = r["display_name"]
        first, last = split_name(display)
        # Placeholder email pattern is obvious from the UI so the
        # admin spots them and updates the real ones.
        placeholder_email = (
            f"{normalize_last_name(last or display).replace(' ', '-')}"
            f".r{r['id']}@trivu.invalid"
        )
        person = Person(
            email=placeholder_email,
            name=display,
            first_name=first,
            last_name=last,
            hashed_password=None,
        )
        db.add(person)
        db.flush()
        person_by_resident_id[r["id"]] = person
        if last:
            person_by_lastname.setdefault(normalize_last_name(last), person)

        ms = Membership(
            tenant_id=tenant.id,
            person_id=person.id,
            roles=["member"],
            category_id=cat_residente.id,
            fte_pct=100,
            group_id=group.id,
        )
        db.add(ms)
        db.flush()

    report["counts"]["persons_from_residents"] = len(src_residents)
    report["counts"]["memberships_from_residents"] = len(src_residents)

    # ------------------------------------------------------------------
    # 7. Surgeon-id → Person resolver
    #    surgeon_shifts.surgeon_id  →  user_surgeon_map.id  →  user_id  →  person
    # ------------------------------------------------------------------
    person_by_surgeon_id: dict[str, Person] = {}
    for row in src_usm:
        surgeon_id = row["id"]
        user_id = row["user_id"]
        if not user_id:
            # Deactivated profile with no user account (e.g. Pastor).
            # We just skip the mapping; any shift referencing this
            # surgeon_id will land with person_id=NULL.
            continue
        person = person_by_user_id.get(user_id)
        if person is None:
            report["warnings"].append(
                f"user_surgeon_map row {surgeon_id} refers to user_id "
                f"{user_id} but no Person was created for that user."
            )
            continue
        person_by_surgeon_id[surgeon_id] = person

    # ------------------------------------------------------------------
    # 8. Slots
    # ------------------------------------------------------------------
    slot_by_main_role: dict[str, Slot] = {}
    for pos, slug in enumerate(MAIN_TEAM_SLOTS):
        s = Slot(
            tenant_id=tenant.id,
            name=slot_display_name(slug),
            start_time=None,
            end_time=None,
            days_applied="all",
            staffing_mode="single",
            headcount=1,
            counts_for_equity=True,
            position=pos,
            group_id=None,
        )
        db.add(s)
        db.flush()
        slot_by_main_role[slug] = s
    report["counts"]["slots_main"] = len(slot_by_main_role)

    slot_by_resident_role: dict[str, Slot] = {}
    for pos, slug in enumerate(RESIDENT_SLOTS):
        s = Slot(
            tenant_id=tenant.id,
            name=slot_display_name(slug),
            start_time=None,
            end_time=None,
            days_applied="all",
            staffing_mode="single",
            headcount=1,
            counts_for_equity=True,
            position=pos,
            group_id=group.id,
        )
        db.add(s)
        db.flush()
        slot_by_resident_role[slug] = s
    report["counts"]["slots_residentes"] = len(slot_by_resident_role)

    # ------------------------------------------------------------------
    # 9. Schedules — one per (year, month) present in either shifts
    #    table. Status = PUBLISHED if any source shift in that month
    #    is PUBLISHED, else DRAFT.
    # ------------------------------------------------------------------
    months_seen: dict[tuple[int, int], str] = {}

    def note_month(d: date, status: str):
        key = (d.year, d.month)
        if status == "PUBLISHED" or months_seen.get(key) != "PUBLISHED":
            months_seen[key] = status

    for row in src_surgeon_shifts:
        note_month(parse_date(row["date"]), row["status"])
    for row in src_resident_shifts:
        note_month(parse_date(row["date"]), row["status"])

    schedule_by_month: dict[tuple[int, int], Schedule] = {}
    for (year, month), src_status in sorted(months_seen.items()):
        target_status = "published" if src_status == "PUBLISHED" else "draft"
        s = Schedule(
            tenant_id=tenant.id,
            period=date(year, month, 1),
            status=target_status,
            generated_at=datetime.now(timezone.utc),
            published_at=(
                datetime.now(timezone.utc)
                if target_status == "published"
                else None
            ),
        )
        db.add(s)
        db.flush()
        schedule_by_month[(year, month)] = s
    report["counts"]["schedules"] = len(schedule_by_month)

    # ------------------------------------------------------------------
    # 10. Surgeon assignments
    # ------------------------------------------------------------------
    assignments_main = 0
    skipped_libre = 0
    skipped_unknown_role = 0
    unresolved_assignee_names: Counter = Counter()

    for row in src_surgeon_shifts:
        role = row["role"]
        if role == "libre":
            skipped_libre += 1
            continue
        slot = slot_by_main_role.get(role)
        if slot is None:
            skipped_unknown_role += 1
            continue
        d = parse_date(row["date"])
        sched = schedule_by_month[(d.year, d.month)]

        surgeon_id = row.get("surgeon_id") or ""
        assignee_name = (row.get("assignee_name") or "").strip()
        person: Person | None = None
        notes_text: str | None = None
        if surgeon_id:
            person = person_by_surgeon_id.get(surgeon_id)
            if person is None:
                # Reference to a surgeon profile that didn't resolve to
                # a person (e.g. the deactivated Pastor profile).
                notes_text = f"Origen: surgeon_id={surgeon_id} (no resuelto)"
        elif assignee_name:
            person = person_by_lastname.get(normalize_last_name(assignee_name))
            if person is None:
                unresolved_assignee_names[assignee_name] += 1
                notes_text = f"Asignado a: {assignee_name}"

        manual_override = (row.get("manual_override") or "").lower() == "true"
        a = Assignment(
            tenant_id=tenant.id,
            schedule_id=sched.id,
            slot_id=slot.id,
            date=d,
            person_id=person.id if person else None,
            notes=notes_text,
            locked_at=(
                datetime.now(timezone.utc) if manual_override else None
            ),
        )
        db.add(a)
        assignments_main += 1

    report["counts"]["assignments_main"] = assignments_main
    report["skipped"]["surgeon_shifts.libre"] = skipped_libre
    if skipped_unknown_role:
        report["warnings"].append(
            f"{skipped_unknown_role} surgeon_shifts row(s) had a role "
            "not in MAIN_TEAM_SLOTS — skipped."
        )
    if unresolved_assignee_names:
        report["warnings"].append(
            "Unresolved neumologo assignee_name values (kept as "
            f"person_id=NULL with notes): {dict(unresolved_assignee_names)}"
        )

    # ------------------------------------------------------------------
    # 11. Resident assignments
    # ------------------------------------------------------------------
    assignments_residentes = 0
    skipped_libre_residentes = 0
    skipped_unknown_role_residentes = 0
    for row in src_resident_shifts:
        role = row["role"]
        if role == "libre":
            skipped_libre_residentes += 1
            continue
        slot = slot_by_resident_role.get(role)
        if slot is None:
            skipped_unknown_role_residentes += 1
            continue
        d = parse_date(row["date"])
        sched = schedule_by_month[(d.year, d.month)]

        resident_id = row.get("resident_id") or ""
        person = person_by_resident_id.get(resident_id) if resident_id else None

        a = Assignment(
            tenant_id=tenant.id,
            schedule_id=sched.id,
            slot_id=slot.id,
            date=d,
            person_id=person.id if person else None,
        )
        db.add(a)
        assignments_residentes += 1

    report["counts"]["assignments_residentes"] = assignments_residentes
    report["skipped"]["resident_shifts.libre"] = skipped_libre_residentes
    if skipped_unknown_role_residentes:
        report["warnings"].append(
            f"{skipped_unknown_role_residentes} resident_shifts row(s) had "
            "a role not in RESIDENT_SLOTS — skipped."
        )

    # ------------------------------------------------------------------
    # 12. Vacations → availability_blocks. surgeon_id → person resolved
    #     through the same map as shifts.
    # ------------------------------------------------------------------
    blocks_created = 0
    blocks_skipped = 0
    for v in src_vacations:
        status = (v.get("status") or "").upper()
        if status not in ("APPROVED", "DECLINED"):
            blocks_skipped += 1
            continue
        person = person_by_surgeon_id.get(v.get("surgeon_id") or "")
        if person is None:
            blocks_skipped += 1
            continue
        ab = AvailabilityBlock(
            tenant_id=tenant.id,
            person_id=person.id,
            start_date=parse_date(v["start_date"]),
            end_date=parse_date(v["end_date"]),
            block_type=map_vacation_reason(v.get("reason", "")),
            notes=v.get("reason") or None,
            status="approved" if status == "APPROVED" else "denied",
        )
        db.add(ab)
        blocks_created += 1
    report["counts"]["availability_blocks"] = blocks_created
    report["skipped"]["vacations"] = blocks_skipped

    # ------------------------------------------------------------------
    # 13. Holidays
    # ------------------------------------------------------------------
    holidays_created = 0
    for h in src_holidays:
        hd = Holiday(
            tenant_id=tenant.id,
            date=parse_date(h["date"]),
            name=h["name"],
            source=map_holiday_source(h.get("scope", "")),
            region_code=REGION_CODE if h.get("scope", "").lower() != "national" else None,
        )
        db.add(hd)
        holidays_created += 1
    report["counts"]["holidays"] = holidays_created

    # ------------------------------------------------------------------
    # 14. Notes → incidents (free-text admin log)
    # ------------------------------------------------------------------
    incidents_created = 0
    for n in src_notes:
        title = (n.get("description") or "").strip()
        if not title:
            continue
        category = (n.get("category") or "").strip()
        # Composite title so the source category is visible in the
        # incident list — easy to filter on later if the customer
        # wants.
        prefix = f"[{category}] " if category else ""
        inc = Incident(
            tenant_id=tenant.id,
            occurred_at=parse_date(n["created_at"]),
            title=f"{prefix}{title}"[:255],
            body=None,
            created_by_membership_id=None,
        )
        db.add(inc)
        incidents_created += 1
    report["counts"]["incidents"] = incidents_created

    return report


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def format_report(report: dict[str, Any]) -> str:
    out: list[str] = []
    out.append("")
    out.append("=" * 60)
    out.append(f"  Migration report — tenant_id={report['tenant_id']}")
    out.append("=" * 60)
    out.append("")
    out.append("CREATED")
    for k, v in sorted(report["counts"].items()):
        out.append(f"  {k:<35} {v}")
    if report["skipped"]:
        out.append("")
        out.append("SKIPPED")
        for k, v in sorted(report["skipped"].items()):
            out.append(f"  {k:<35} {v}")
    if report["warnings"]:
        out.append("")
        out.append("WARNINGS")
        for w in report["warnings"]:
            out.append(f"  - {w}")
    out.append("")
    out.append("STATIC SKIPS (per customer / mapping plan)")
    out.append("  surgeries.csv         — 513 rows (no Trivu OR-case model)")
    out.append("  surgeons.csv          — 8 rows (only used by surgeries)")
    out.append("  audit_log.csv         — 1001 rows (internal log)")
    out.append("  events.csv            — 317 rows (purpose unknown)")
    out.append("  vacation_locks.csv    — 76 rows (purpose unknown)")
    out.append("  swap_requests.csv     — 8 rows (history only)")
    out.append("  swap_offers.csv       — 3 rows (history only)")
    out.append("  swap_acks.csv         — 5 rows (history only)")
    out.append("")
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually write to the database. Without this flag the "
        "script runs in dry-run mode and rolls back at the end.",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        report = run_migration(db)
        if args.commit:
            db.commit()
            print(format_report(report))
            print("COMMITTED ✓")
        else:
            db.rollback()
            print(format_report(report))
            print("DRY RUN — rolled back. Re-run with --commit to apply.")
        return 0
    except Exception as exc:
        db.rollback()
        print(f"\nMIGRATION FAILED: {type(exc).__name__}: {exc}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
