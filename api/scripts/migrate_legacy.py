"""One-off CSV → Trivu migration for the alpha customer (legacy
thoracic-surgery scheduler).

Reads the Cloud SQL Studio CSV exports from
`data/legacy-migration/` and builds a fresh tenant containing:

  - 6 surgeons (categoría Adjunto, from the source user accounts),
    6 neumólogos (categoría Neumólogo, no source user accounts),
    and 8 residents (categoría Residente, no source user
    accounts). All created as `pendientes` (NULL password) so
    they activate via the existing invitation flow post-cutover.
    Neumólogos are scheduled in surgeon_shifts via the
    `neumologo` role; the source `assignee_name` field carries
    their last name. (The surgeon Pastor and the neumólogo
    Pastor are different people per the customer — the surgeon
    Pastor is an inactive profile in user_surgeon_map with no
    user account; the neumólogo Pastor lands as a real
    main-team person.)
  - Two old-system shared logins are dropped: `test@gmail.com`
    (the standalone "admin" account) and `residentes@local.test`
    (the standalone sub-equipo lead). Trivu's model lets one
    Person carry both clinical and management capabilities, so
    instead we MERGE: surgeon Sales gets `roles=["admin",
    "member"]` on top of their normal Adjunto membership, and
    resident Gascón becomes the Residentes sub-equipo lead.
    Result: one human → one login, everywhere.
  - One sub-equipo "Residentes" with resident Gascón as its
    lead (Group.lead_membership_id) and the 8 residents as
    members (categoría Residente).
  - 6 main-team slots, two of which use team_composition:
    Quirófano (Cirujano 1, Cirujano 2) and Trasplante
    (Explante, Implante 1, Implante 2). Plus 7 sub-equipo
    slots (one per source resident role), all single-staffing.
    Source surgeon_shifts rows with role=quirofano_1 /
    implante_2 / etc. map onto the matching team_role inside
    the parent slot — Assignment.team_role_id carries the
    position so the planning grid shows "Quirófano · Cirujano 1"
    style rows after import.
  - 5 monthly schedules (Feb–Jun 2026) with DRAFT / PUBLISHED
    status preserved, plus ~2 400 assignments.
  - 102 availability_blocks from the source `vacations` table
    PLUS additional blocks from `libre` shift rows. `libre`
    means "this person is taking the day off" (a vacation day),
    so each libre row becomes an availability_block — deduped
    against the explicit vacations table so a 5-day vacation
    doesn't get re-blocked five times.
  - 16 holidays, and 25 incident-log entries from `notes`.
  - The transplant case log: 297 transplant_cases + 512
    transplant_procedures (EXPLANTE + IMPLANTE pairs) from
    `surgeries`. Pastor — an inactive surgeon profile with no
    user account but 18 historical procedure references —
    lands as a Person + disabled Membership so attribution
    survives without polluting the active team list.

Skipped on purpose (counts go in the final report):

  - `surgeons` (8 rows) — directory used only by `surgeries`,
    we resolve via the same user_surgeon_map the assignments
    migration uses.
  - `audit_log` (1 001 rows) — internal app log, zero value.
  - `events` (317), `vacation_locks` (76) — purpose unclear,
    customer chose skip.
  - `swap_*` (16 total) — history only.

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
    SlotTeamRole,
    Tenant,
    TransplantCase,
    TransplantProcedure,
)


# ---------------------------------------------------------------------------
# Config (customer-specific)
# ---------------------------------------------------------------------------

TENANT_NAME = "Cirugía Torácica — Hospital La Fe"
TENANT_SLUG = "cirugia-toracica-hospital-la-fe"
COUNTRY_CODE = "ES"
REGION_CODE = "ES-VC"
PRESET_KIND = "quirurgico"
# The customer runs the regional lung transplant program — turn
# on the trasplantes module so the imported case log surfaces in
# /admin/trasplantes from day one.
TRANSPLANTS_ENABLED = True

# Categorías we create. Most surgeons in the source data have no
# explicit categoría — we put them all under "Adjunto" and the
# admin can split later (Jefe, Adjunto, etc.).
CATEGORY_ADJUNTO = "Adjunto"
CATEGORY_RESIDENTE = "Residente"
CATEGORY_NEUMOLOGO = "Neumólogo"

SUBTEAM_NAME = "Residentes"

# In the legacy system, "admin" and "Residentes" were shared
# logins decoupled from any clinical person. Trivu merges those
# powers into the real humans' memberships so the customer has
# one identity per person.
#
#   - The surgeon whose source username matches this gets
#     roles=["admin", "member"] (clinical + admin) — the source
#     `test@gmail.com` admin account is dropped.
#   - The resident whose display_name matches this becomes
#     Group.lead_membership_id of the Residentes sub-equipo — the
#     source `residentes@local.test` account is dropped.
#
# Both source rows (user_id=1 ADMIN and user_id=8 RESIDENT_ADMIN)
# are skipped by the users loop via DROP_SOURCE_USER_IDS.
ADMIN_INHERITS_SURGEON_USERNAME = "Sales"
SUBTEAM_LEAD_RESIDENT_DISPLAY_NAME = "Gascón"
DROP_SOURCE_USER_IDS = {"1", "8"}


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
    # The source has two "directory" tables that look identical at
    # the column level but hold different people:
    #   - 1041 (3): 6 NEUMÓLOGOS (Anguera, Montull, Reig, Selma,
    #     Pastor, Solé) — same names appear as assignee_name on the
    #     `neumologo` rows of surgeon_shifts.
    #   - 1042 (1): 8 actual RESIDENTS (Cuadros, Doménech, Pérez,
    #     Espinós, Gascón, H. Tovar, M. Garcia, David) — FK target
    #     of resident_shifts.resident_id (1–8).
    "neumologos": "studio_results_20260521_1041 (3).csv",
    "residents": "studio_results_20260521_1042 (1).csv",
    "surgeon_shifts": "studio_results_20260521_1042 (2).csv",
    "resident_shifts": "studio_results_20260521_1042.csv",
    "vacations": "studio_results_20260521_1041 (1).csv",
    "holidays": "studio_results_20260521_1041 (4).csv",
    "notes": "studio_results_20260521_1041 (2).csv",
    # 512 procedure rows, 297 cases. Grouped into transplant_cases
    # + transplant_procedures by `case_id`. The 18 procedures
    # attributed to the inactive surgeon Pastor resolve via
    # PASTOR_SURGEON_ID below.
    "surgeries": "studio_results_20260521_1044 (1).csv",
}

# The inactive surgeon profile in user_surgeon_map has no user_id
# and so isn't migrated by the main users loop. But Pastor still
# appears as primary/secondary on 18 historical transplant
# procedures. We create a placeholder Person + disabled
# Membership so attribution survives the import without
# polluting the active /admin/team list.
#
# Note this is the SURGEON Pastor (user_surgeon_map.id=7), not
# the neumólogo Pastor — per the customer they're two different
# people sharing a last name.
PASTOR_SURGEON_ID = "7"
PASTOR_DISPLAY_NAME = "Pastor (inactivo)"
PASTOR_PLACEHOLDER_EMAIL = "pastor.legacy.s7@trivu.invalid"


# ---------------------------------------------------------------------------
# Slot definitions (derived from source `role` enums; `libre` is
# excluded because it means "no assignment", not a slot)
# ---------------------------------------------------------------------------

# Main-team slots. The source enum is flat (quirofano_1,
# quirofano_2, explante, implante_1, implante_2 are all separate
# role values), but conceptually they're positions WITHIN an
# activity, not separate activities. We collapse them here:
#
#   - Quirófano (team_composition): Cirujano 1, Cirujano 2
#   - Trasplante (team_composition): Explante, Implante 1, Implante 2
#
# Single-role slots get staffing_mode="single" and no
# SlotTeamRole rows. Multi-role slots get
# staffing_mode="team_composition" + one SlotTeamRole per role,
# and Assignment.team_role_id is set to the matching role on
# every imported row.
#
# `roles` items are (source_role_slug, team_role_label_or_None).
# None means "this slot has no named positions; everyone goes
# in the single bucket."
MAIN_TEAM_SLOTS: list[dict[str, Any]] = [
    {"name": "Consulta",  "roles": [("consulta",  None)]},
    {"name": "Guardia",   "roles": [("guardia",   None)]},
    {"name": "Neumólogo", "roles": [("neumologo", None)]},
    {"name": "Planta",    "roles": [("planta",    None)]},
    {
        "name": "Quirófano",
        "roles": [
            ("quirofano_1", "Cirujano 1"),
            ("quirofano_2", "Cirujano 2"),
        ],
    },
    {
        "name": "Trasplante",
        "roles": [
            ("explante",   "Explante"),
            ("implante_1", "Implante 1"),
            ("implante_2", "Implante 2"),
        ],
    },
]

# Sub-equipo "Residentes" slots. The source enum has no
# numbered duplicates here (one quirofano, one implante…), so
# we keep them as flat single-staffing slots. `rotacion` is a
# real activity for residents per customer confirmation
# (rotating residents from other services).
RESIDENT_SLOTS = [
    "consulta",
    "explante",
    "guardia",
    "implante",
    "planta",
    "quirofano",
    "rotacion",
]


def resident_slot_display_name(slug: str) -> str:
    """Map a residents-side source slug to a human-readable Slot
    name. Main-team slot names are spelled out directly in
    MAIN_TEAM_SLOTS, so this helper covers residents only."""
    table = {
        "consulta": "Consulta",
        "explante": "Explante",
        "guardia": "Guardia",
        "implante": "Implante",
        "planta": "Planta",
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


def parse_iso_datetime(s: str) -> datetime:
    """Same source format as parse_date but preserve the full
    timestamp — transplant_procedures.occurred_at is a tz-aware
    datetime, not just a date."""
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


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
    src_neumologos = read_csv(CSV["neumologos"])
    src_residents = read_csv(CSV["residents"])
    src_surgeon_shifts = read_csv(CSV["surgeon_shifts"])
    src_resident_shifts = read_csv(CSV["resident_shifts"])
    src_vacations = read_csv(CSV["vacations"])
    src_holidays = read_csv(CSV["holidays"])
    src_notes = read_csv(CSV["notes"])

    print(
        f"Read CSVs: users={len(src_users)}, "
        f"user_surgeon_map={len(src_usm)}, "
        f"neumologos={len(src_neumologos)}, "
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
        transplants_enabled=TRANSPLANTS_ENABLED,
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
    cat_neumologo = Category(tenant_id=tenant.id, name=CATEGORY_NEUMOLOGO)
    db.add_all([cat_adjunto, cat_residente, cat_neumologo])
    db.flush()
    report["counts"]["categories"] = 3

    # ------------------------------------------------------------------
    # 4. Persons + Memberships from `users` table.
    #    Build indexes to resolve shift FKs later. The two shared
    #    logins (admin, Residentes) are dropped here; their
    #    powers are merged into real clinical memberships below.
    # ------------------------------------------------------------------
    # source user_id → Person row + Membership row
    person_by_user_id: dict[str, Person] = {}
    membership_by_user_id: dict[str, Membership] = {}

    # Track Sales's membership so we can assert we found them
    # before the merged-admin claim is true.
    admin_inheritor_found = False
    users_dropped = 0

    for u in src_users:
        if u["id"] in DROP_SOURCE_USER_IDS:
            users_dropped += 1
            continue
        first, last = split_name(u["name"])
        username = u.get("username", "")
        is_admin_inheritor = username == ADMIN_INHERITS_SURGEON_USERNAME
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

        ms = Membership(
            tenant_id=tenant.id,
            person_id=person.id,
            # Sales gets BOTH admin and member: admin powers (the
            # /admin sidebar, planning tools) layered on top of a
            # normal Adjunto clinical membership. They're still
            # scheduled by the solver like any other surgeon.
            roles=["admin", "member"] if is_admin_inheritor else ["member"],
            category_id=cat_adjunto.id,
            fte_pct=100,
        )
        db.add(ms)
        db.flush()
        membership_by_user_id[u["id"]] = ms
        if is_admin_inheritor:
            admin_inheritor_found = True

    if not admin_inheritor_found:
        raise RuntimeError(
            f"Could not find a source surgeon with username "
            f"'{ADMIN_INHERITS_SURGEON_USERNAME}' to inherit the "
            f"admin role. Update ADMIN_INHERITS_SURGEON_USERNAME "
            f"or check the users CSV."
        )

    report["counts"]["persons_from_users"] = len(src_users) - users_dropped
    report["counts"]["memberships_from_users"] = len(src_users) - users_dropped
    report["skipped"]["users_merged_into_clinical_memberships"] = users_dropped

    # ------------------------------------------------------------------
    # 5. Residentes sub-equipo. Lead is one of the residents (see
    #    SUBTEAM_LEAD_RESIDENT_DISPLAY_NAME) — we know who but not
    #    their membership id yet, so we create the Group with
    #    lead_membership_id=None and back-fill it in step 6b once
    #    the residents loop has run.
    # ------------------------------------------------------------------
    group = Group(
        tenant_id=tenant.id,
        name=SUBTEAM_NAME,
        lead_membership_id=None,
    )
    db.add(group)
    db.flush()
    report["counts"]["groups"] = 1

    # ------------------------------------------------------------------
    # 6a. Neumólogos → main-team persons + memberships with categoría
    #     Neumólogo. NOT a sub-equipo: per the customer they sit in
    #     the main team alongside the surgeons (different categoría).
    #     They show up as assignee_name in surgeon_shifts' `neumologo`
    #     rows; we resolve via last-name match against this group.
    #     Source has no email → placeholder.
    # ------------------------------------------------------------------
    person_by_neumologo_id: dict[str, Person] = {}
    person_by_neumologo_lastname: dict[str, Person] = {}
    for n in src_neumologos:
        display = n["display_name"]
        first, last = split_name(display)
        placeholder_email = (
            f"{normalize_last_name(last or display).replace(' ', '-')}"
            f".n{n['id']}@trivu.invalid"
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
        person_by_neumologo_id[n["id"]] = person
        if last:
            person_by_neumologo_lastname[normalize_last_name(last)] = person

        ms = Membership(
            tenant_id=tenant.id,
            person_id=person.id,
            roles=["member"],
            category_id=cat_neumologo.id,
            fte_pct=100,
            group_id=None,  # main team
        )
        db.add(ms)
        db.flush()

    report["counts"]["persons_from_neumologos"] = len(src_neumologos)
    report["counts"]["memberships_from_neumologos"] = len(src_neumologos)

    # ------------------------------------------------------------------
    # 6b. Residents (Cuadros, Doménech, …) → persons + memberships in
    #     the "Residentes" sub-equipo with categoría Residente. FK
    #     target of resident_shifts.resident_id (1–8). Source has no
    #     email → placeholder.
    # ------------------------------------------------------------------
    person_by_resident_id: dict[str, Person] = {}
    chief_resident_lead_membership: Membership | None = None
    chief_resident_target_lastname = normalize_last_name(
        SUBTEAM_LEAD_RESIDENT_DISPLAY_NAME
    )
    for r in src_residents:
        display = r["display_name"]
        first, last = split_name(display)
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
        if normalize_last_name(display) == chief_resident_target_lastname:
            chief_resident_lead_membership = ms

    if chief_resident_lead_membership is None:
        raise RuntimeError(
            f"Could not find a resident with display_name "
            f"'{SUBTEAM_LEAD_RESIDENT_DISPLAY_NAME}' to make the "
            f"Residentes sub-equipo lead. Update "
            f"SUBTEAM_LEAD_RESIDENT_DISPLAY_NAME or check the "
            f"residents CSV."
        )
    group.lead_membership_id = chief_resident_lead_membership.id
    db.flush()

    report["counts"]["persons_from_residents"] = len(src_residents)
    report["counts"]["memberships_from_residents"] = len(src_residents)

    # ------------------------------------------------------------------
    # 7. Surgeon-id → Person resolver
    #    surgeon_shifts.surgeon_id  →  user_surgeon_map.id  →  user_id  →  person
    #
    #    Special-case the inactive surgeon Pastor (surgeon_id=7,
    #    user_id="") — they're absent from the users CSV but
    #    appear on 18 historical transplant procedures. Create a
    #    disabled Person + Membership so attribution survives;
    #    disabled_at filters them out of the active team views,
    #    schedule generation, and notification fan-outs while
    #    keeping past procedures attributed correctly.
    # ------------------------------------------------------------------
    person_by_surgeon_id: dict[str, Person] = {}
    pastor_disabled_membership: Membership | None = None
    for row in src_usm:
        surgeon_id = row["id"]
        user_id = row["user_id"]
        if not user_id:
            if surgeon_id == PASTOR_SURGEON_ID:
                # Pastor — create the disabled-from-day-one shim.
                pastor_person = Person(
                    email=PASTOR_PLACEHOLDER_EMAIL,
                    name=PASTOR_DISPLAY_NAME,
                    first_name=None,
                    last_name=row.get("display_name") or "Pastor",
                    hashed_password=None,
                )
                db.add(pastor_person)
                db.flush()
                pastor_disabled_membership = Membership(
                    tenant_id=tenant.id,
                    person_id=pastor_person.id,
                    roles=["member"],
                    category_id=cat_adjunto.id,
                    fte_pct=100,
                    disabled_at=datetime.now(timezone.utc),
                )
                db.add(pastor_disabled_membership)
                db.flush()
                person_by_surgeon_id[surgeon_id] = pastor_person
            # Other surgeons without a user_id stay unmapped — shifts
            # referencing them land with person_id=NULL.
            continue
        person = person_by_user_id.get(user_id)
        if person is None:
            report["warnings"].append(
                f"user_surgeon_map row {surgeon_id} refers to user_id "
                f"{user_id} but no Person was created for that user."
            )
            continue
        person_by_surgeon_id[surgeon_id] = person
    if pastor_disabled_membership is not None:
        report["counts"]["persons_legacy_inactive_surgeons"] = 1

    # ------------------------------------------------------------------
    # 8. Slots
    # ------------------------------------------------------------------
    # Source role slug → (Slot, SlotTeamRole or None). Single-role
    # slots map to (slot, None); multi-role slots map each source
    # slug to its matching SlotTeamRole. Drives both the assignment
    # writer below and (implicitly) which rota row each historical
    # shift lands on.
    # Global slot-position counter. Main-team slots take the
    # lower range, sub-equipo slots continue from there — every
    # Slot row in the tenant must end up with a UNIQUE position
    # because /admin/slots' reorder endpoint swaps position
    # values, which is a no-op when two slots share a number.
    # The customer can rearrange order via the up/down arrows
    # after migration.
    slot_position = 0
    slot_role_map: dict[str, tuple[Slot, SlotTeamRole | None]] = {}
    team_roles_created = 0
    for spec in MAIN_TEAM_SLOTS:
        roles = spec["roles"]
        multi = len(roles) > 1
        s = Slot(
            tenant_id=tenant.id,
            name=spec["name"],
            start_time=None,
            end_time=None,
            days_applied="all",
            # Multi-role activities go through team_composition;
            # headcount is the sum of individual role headcounts
            # (each role is 1 here, so just the count).
            staffing_mode="team_composition" if multi else "single",
            headcount=len(roles),
            counts_for_equity=True,
            position=slot_position,
            group_id=None,
        )
        slot_position += 1
        db.add(s)
        db.flush()
        if multi:
            for src_slug, label in roles:
                tr = SlotTeamRole(
                    tenant_id=tenant.id,
                    slot_id=s.id,
                    role_label=label,
                    headcount=1,
                )
                db.add(tr)
                db.flush()
                slot_role_map[src_slug] = (s, tr)
                team_roles_created += 1
        else:
            src_slug, _ = roles[0]
            slot_role_map[src_slug] = (s, None)
    report["counts"]["slots_main"] = len(MAIN_TEAM_SLOTS)
    report["counts"]["team_roles_main"] = team_roles_created

    slot_by_resident_role: dict[str, Slot] = {}
    for slug in RESIDENT_SLOTS:
        s = Slot(
            tenant_id=tenant.id,
            name=resident_slot_display_name(slug),
            start_time=None,
            end_time=None,
            days_applied="all",
            staffing_mode="single",
            headcount=1,
            counts_for_equity=True,
            # Continue the global position counter so sub-equipo
            # slots get unique numbers (the reorder endpoint relies
            # on no two slots in the tenant sharing a position).
            position=slot_position,
            # Sub-equipo slots are scoped by group_id; the partial
            # uniqueness index lets them share names with main-team
            # slots (e.g. both can be called "Consulta").
            group_id=group.id,
        )
        slot_position += 1
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
    # 10. Off-day tracking — `vacations` rows AND `libre` shift rows
    #     both represent "this person is taking the day off". They
    #     overlap: a 5-day approved vacation also shows up as 5
    #     `libre` rows in the shifts table. We process vacations
    #     first (richer metadata: reason, status, multi-day range)
    #     and track which (person, date) pairs are already covered;
    #     libre rows for already-covered dates are deduped away in
    #     the shift loops below.
    # ------------------------------------------------------------------
    off_days_covered: set[tuple[int, date]] = set()
    vac_blocks_created = 0
    vac_blocks_skipped = 0
    for v in src_vacations:
        status = (v.get("status") or "").upper()
        if status not in ("APPROVED", "DECLINED"):
            vac_blocks_skipped += 1
            continue
        person = person_by_surgeon_id.get(v.get("surgeon_id") or "")
        if person is None:
            vac_blocks_skipped += 1
            continue
        start = parse_date(v["start_date"])
        end = parse_date(v["end_date"])
        ab = AvailabilityBlock(
            tenant_id=tenant.id,
            person_id=person.id,
            start_date=start,
            end_date=end,
            block_type=map_vacation_reason(v.get("reason", "")),
            notes=v.get("reason") or None,
            status="approved" if status == "APPROVED" else "denied",
        )
        db.add(ab)
        vac_blocks_created += 1
        # Mark every day in this range as already-covered so the
        # libre rows below don't re-block.
        d_iter = start
        while d_iter <= end:
            off_days_covered.add((person.id, d_iter))
            d_iter = date.fromordinal(d_iter.toordinal() + 1)
    report["counts"]["availability_blocks_from_vacations"] = vac_blocks_created
    report["skipped"]["vacations"] = vac_blocks_skipped

    def record_off_day(person: Person, d: date) -> bool:
        """Create a single-day availability_block for this person on
        d, unless (person, d) is already covered by a previously
        created block. Returns True if a new block was created."""
        key = (person.id, d)
        if key in off_days_covered:
            return False
        off_days_covered.add(key)
        db.add(
            AvailabilityBlock(
                tenant_id=tenant.id,
                person_id=person.id,
                start_date=d,
                end_date=d,
                block_type="vacation",
                notes="libre",
                status="approved",
            )
        )
        return True

    # ------------------------------------------------------------------
    # 11. Surgeon assignments (libre rows → off-day blocks, deduped)
    # ------------------------------------------------------------------
    assignments_main = 0
    libre_blocks_main_new = 0
    libre_main_already_covered = 0
    libre_main_no_person = 0
    skipped_unknown_role = 0
    unresolved_assignee_names: Counter = Counter()

    for row in src_surgeon_shifts:
        role = row["role"]
        d = parse_date(row["date"])

        if role == "libre":
            # libre = "this person is off today". Convert to a
            # single-day availability_block — but only if not
            # already covered by an explicit vacation row.
            surgeon_id = row.get("surgeon_id") or ""
            person = person_by_surgeon_id.get(surgeon_id) if surgeon_id else None
            if person is None:
                libre_main_no_person += 1
                continue
            if record_off_day(person, d):
                libre_blocks_main_new += 1
            else:
                libre_main_already_covered += 1
            continue

        slot_role = slot_role_map.get(role)
        if slot_role is None:
            skipped_unknown_role += 1
            continue
        slot, team_role = slot_role
        sched = schedule_by_month[(d.year, d.month)]

        surgeon_id = row.get("surgeon_id") or ""
        assignee_name = (row.get("assignee_name") or "").strip()
        person: Person | None = None
        notes_text: str | None = None
        if surgeon_id:
            person = person_by_surgeon_id.get(surgeon_id)
            if person is None:
                # Reference to a surgeon profile that didn't resolve to
                # a person (e.g. the deactivated Pastor profile in the
                # user_surgeon_map with no user_id).
                notes_text = f"Origen: surgeon_id={surgeon_id} (no resuelto)"
        elif assignee_name:
            # neumologo rows with surgeon_id empty carry a free-text
            # last name in assignee_name pointing at one of the 6
            # neumólogos. Resolve by normalized last-name match.
            person = person_by_neumologo_lastname.get(
                normalize_last_name(assignee_name)
            )
            if person is None:
                unresolved_assignee_names[assignee_name] += 1
                notes_text = f"Asignado a: {assignee_name}"

        manual_override = (row.get("manual_override") or "").lower() == "true"
        a = Assignment(
            tenant_id=tenant.id,
            schedule_id=sched.id,
            slot_id=slot.id,
            # For team_composition slots this is the specific
            # position (Cirujano 1, Explante, …); for single-mode
            # slots it stays NULL.
            team_role_id=team_role.id if team_role else None,
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
    report["counts"]["availability_blocks_from_libre_main"] = libre_blocks_main_new
    if libre_main_already_covered:
        report["skipped"]["surgeon_shifts.libre_already_covered"] = (
            libre_main_already_covered
        )
    if libre_main_no_person:
        report["skipped"]["surgeon_shifts.libre_no_person"] = libre_main_no_person
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
    # 12. Resident assignments (libre rows → off-day blocks, deduped)
    # ------------------------------------------------------------------
    assignments_residentes = 0
    libre_blocks_residentes_new = 0
    libre_residentes_already_covered = 0
    libre_residentes_no_person = 0
    skipped_unknown_role_residentes = 0
    for row in src_resident_shifts:
        role = row["role"]
        d = parse_date(row["date"])

        if role == "libre":
            resident_id = row.get("resident_id") or ""
            person = (
                person_by_resident_id.get(resident_id) if resident_id else None
            )
            if person is None:
                libre_residentes_no_person += 1
                continue
            if record_off_day(person, d):
                libre_blocks_residentes_new += 1
            else:
                libre_residentes_already_covered += 1
            continue

        slot = slot_by_resident_role.get(role)
        if slot is None:
            skipped_unknown_role_residentes += 1
            continue
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
    report["counts"]["availability_blocks_from_libre_residentes"] = (
        libre_blocks_residentes_new
    )
    if libre_residentes_already_covered:
        report["skipped"]["resident_shifts.libre_already_covered"] = (
            libre_residentes_already_covered
        )
    if libre_residentes_no_person:
        report["skipped"]["resident_shifts.libre_no_person"] = (
            libre_residentes_no_person
        )
    if skipped_unknown_role_residentes:
        report["warnings"].append(
            f"{skipped_unknown_role_residentes} resident_shifts row(s) had "
            "a role not in RESIDENT_SLOTS — skipped."
        )

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

    # ------------------------------------------------------------------
    # 15. Transplant case log
    #
    # Source `surgeries` has 512 procedure rows across 297 unique
    # case_ids. Group by case_id, derive case-level occurred_on as
    # the earliest procedure date, attach EXPLANTE / IMPLANTE
    # procedures with primary + optional secondary surgeon.
    #
    # NULL primary_person_id is preserved verbatim — it carries
    # the "received from another hospital" / "sent elsewhere"
    # semantics together with the free-text notes.
    # ------------------------------------------------------------------
    src_surgeries = read_csv(CSV["surgeries"])
    print(f"Read transplant CSV: surgeries={len(src_surgeries)}")

    # case_id → list of source rows
    by_case: dict[str, list[dict[str, str]]] = {}
    for row in src_surgeries:
        by_case.setdefault(row["case_id"], []).append(row)

    cases_created = 0
    procedures_created = 0
    skipped_unknown_type = 0
    for external_case_id, rows in sorted(
        by_case.items(), key=lambda kv: parse_iso_datetime(kv[1][0]["occurred_at"])
    ):
        # Validate types up-front; the schema has a check
        # constraint so we won't get past flush() if any slip in.
        usable_rows = []
        for r in rows:
            t = (r.get("type") or "").strip().lower()
            if t not in ("explante", "implante"):
                skipped_unknown_type += 1
                continue
            usable_rows.append((t, r))
        if not usable_rows:
            continue

        earliest = min(
            parse_iso_datetime(r["occurred_at"]) for _, r in usable_rows
        )
        case = TransplantCase(
            tenant_id=tenant.id,
            external_case_id=external_case_id or None,
            occurred_on=earliest.date(),
            notes=None,
        )
        db.add(case)
        db.flush()
        cases_created += 1

        for t, r in usable_rows:
            primary_id = (r.get("primary_surgeon_id") or "").strip()
            secondary_id = (r.get("secondary_surgeon_id") or "").strip()
            primary_person = (
                person_by_surgeon_id.get(primary_id) if primary_id else None
            )
            secondary_person = (
                person_by_surgeon_id.get(secondary_id) if secondary_id else None
            )
            note_text = (r.get("notes") or "").strip() or None
            db.add(
                TransplantProcedure(
                    tenant_id=tenant.id,
                    case_id=case.id,
                    type=t,
                    occurred_at=parse_iso_datetime(r["occurred_at"]),
                    primary_person_id=(
                        primary_person.id if primary_person else None
                    ),
                    secondary_person_id=(
                        secondary_person.id if secondary_person else None
                    ),
                    notes=note_text,
                )
            )
            procedures_created += 1
        db.flush()

    report["counts"]["transplant_cases"] = cases_created
    report["counts"]["transplant_procedures"] = procedures_created
    if skipped_unknown_type:
        report["warnings"].append(
            f"{skipped_unknown_type} surgeries row(s) had a type that "
            "isn't EXPLANTE/IMPLANTE — skipped."
        )

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
    out.append("  surgeons.csv          — 8 rows (only directory, resolved via user_surgeon_map)")
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
