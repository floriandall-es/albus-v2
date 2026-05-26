"""Public (no-auth) catalog endpoints for the signup wizard.

These routes drive the typeahead pickers on /signup so a new
user can pick their hospital (from the CNH-seeded list) and
then either join an existing servicio at that hospital or
create a new one.

Public on purpose — the catalog itself is public information
(Ministerio de Sanidad). We surface:

  - GET /api/public/hospitals/search?q=la+fe
       Returns up to ~20 CNH-coded hospitals whose name or city
       matches the query (accent + case insensitive). Hospitals
       without a public_code are excluded — Phase D enforces
       "you can only sign up under a known-good hospital".

  - GET /api/public/hospitals/{id}/servicios
       Returns approved Servicios at that hospital with the
       count of approved Equipos in each. Used by step 3 of the
       wizard to let the user choose between "join existing" and
       "create new". Pending servicios are excluded.

Neither leaks any tenant-private data — only public catalog +
servicio names (which by virtue of being multi-tenant
groupings, are not secret in the same way a single tenant's
schedule is).
"""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import AdminSessionLocal


router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas (local to this module — they only exist here)
# ---------------------------------------------------------------------------


class PublicHospitalOut(BaseModel):
    id: int
    name: str
    city: str | None
    province: str | None
    autonomous_community: str | None


class PublicServicioOut(BaseModel):
    id: int
    name: str
    slug: str
    # Number of approved equipos in this servicio — surfaces "join a
    # busy one" vs "join a quiet one" in the wizard. Doesn't reveal
    # anything sensitive (the count is one number, no names).
    approved_equipo_count: int


# ---------------------------------------------------------------------------
# DB session — public endpoints don't go through get_current_context
# so RLS is never set. We use AdminSessionLocal which bypasses RLS
# entirely; both target tables (hospitals, servicios) have no RLS
# policy anyway since they sit ABOVE the tenant boundary.
# ---------------------------------------------------------------------------


def _admin_db() -> Session:
    return AdminSessionLocal()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get(
    "/public/hospitals/search",
    response_model=list[PublicHospitalOut],
)
def search_hospitals(
    q: str = Query(..., min_length=2, max_length=80),
) -> list[PublicHospitalOut]:
    """Typeahead search over the CNH-seeded `hospitals` table.

    Matches on accent-stripped, lowercased name OR city. Limited
    to 20 rows so the dropdown stays usable. Hospitals without a
    public_code are excluded — those are legacy / demo rows that
    Phase D's signup deliberately won't accept.
    """
    # `unaccent` extension isn't installed by default in our
    # Postgres image, so we strip accents on both sides via
    # translate() — Spanish diacritics only, no Slavic / Asian
    # coverage but we're a Spain-only customer base. Good enough
    # for a 848-row catalog; if we ever scale up we'd add
    # pg_trgm + unaccent.
    accent_map = str.maketrans(
        "áéíóúàèìòùâêîôûäëïöüñç",
        "aeiouaeiouaeiouaeioonc",
    )
    pattern = f"%{q.lower().strip().translate(accent_map)}%"
    db = _admin_db()
    try:
        rows = db.execute(
            text(
                """
                SELECT id, name, city, province, autonomous_community
                FROM hospitals
                WHERE public_code IS NOT NULL
                  AND (
                    translate(lower(name),
                              'áéíóúàèìòùâêîôûäëïöüñç',
                              'aeiouaeiouaeiouaeioonc') LIKE :pattern
                    OR translate(lower(coalesce(city, '')),
                                'áéíóúàèìòùâêîôûäëïöüñç',
                                'aeiouaeiouaeiouaeioonc') LIKE :pattern
                  )
                ORDER BY name
                LIMIT 20
                """
            ),
            {"pattern": pattern},
        ).mappings().all()
        return [PublicHospitalOut(**dict(r)) for r in rows]
    finally:
        db.close()


@router.get(
    "/public/hospitals/{hospital_id}/servicios",
    response_model=list[PublicServicioOut],
)
def list_hospital_servicios(hospital_id: int) -> list[PublicServicioOut]:
    """Approved Servicios at the given hospital + the count of
    approved Equipos in each. Drives step 3 of the signup wizard.

    Excludes Servicios that have ZERO approved equipos — they
    exist in some abandoned state where every equipo is pending
    or there are no equipos at all. Joining one of those would
    be confusing ("I can't approve myself"); the user should
    create a fresh Servicio instead.
    """
    db = _admin_db()
    try:
        rows = db.execute(
            text(
                """
                SELECT s.id, s.name, s.slug,
                       COUNT(t.id) FILTER (WHERE t.approval_state = 'approved')
                         AS approved_equipo_count
                FROM servicios s
                LEFT JOIN tenants t ON t.servicio_id = s.id
                WHERE s.hospital_id = :hid
                GROUP BY s.id, s.name, s.slug
                HAVING COUNT(t.id) FILTER (WHERE t.approval_state = 'approved') > 0
                ORDER BY s.name
                """
            ),
            {"hid": hospital_id},
        ).mappings().all()
        return [PublicServicioOut(**dict(r)) for r in rows]
    finally:
        db.close()
