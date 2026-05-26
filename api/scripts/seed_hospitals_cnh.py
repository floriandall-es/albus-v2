"""One-shot CNH ingestion: seed `hospitals` from the official catalog.

Reads `api/data/cnh_2025_directorio.csv` (trimmed projection of the
Ministerio de Sanidad's Catálogo Nacional de Hospitales) and
upserts one Hospital row per CNH entry, keyed on `public_code`.

Run inside the API container (so SessionLocal/AdminSessionLocal +
the SQLAlchemy models work out of the box):

    docker compose -f infra/docker-compose.prod.yml exec api \\
        python -m scripts.seed_hospitals_cnh

Operations, in order:

1. UPSERT each CSV row, keyed on public_code:
      - if a row with that public_code exists → refresh
        name/city/province/AAC (catalog edition may have changed).
      - else if a row with the slug we'd assign exists (no
        public_code yet — pre-CNH manual data) → STAMP its
        public_code and refresh metadata. This handles the
        common case where someone created the hospital in the
        admin onboarding flow before CNH was wired up.
      - else INSERT fresh.

   Each row runs inside its own SAVEPOINT (db.begin_nested) so a
   single failure (e.g. slug collision we can't resolve) doesn't
   poison the rest of the batch.

2. Reconcile by normalized name + city. For any remaining
   `hospitals` row with public_code IS NULL, try to match
   against the CSV by accent-stripped, lowercase, stopword-
   filtered name + city. Stopword list covers BOTH Spanish AND
   Catalan terms (the alpha customer's La Fe is in Valencian).
   When the DB row has no city, fall back to name-only match.

3. Print a summary: inserted / updated / slug-reconciled /
   name-reconciled / still without public_code.

Idempotent. Safe to re-run any time.
"""

from __future__ import annotations

import csv
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy.exc import IntegrityError

from app.db.session import AdminSessionLocal
from app.models import Hospital


CSV_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "cnh_2025_directorio.csv",
)


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------


# Stopwords stripped from hospital names before comparison. Covers
# Spanish + Catalan/Valencian variants so the alpha customer's
# "Hospital Universitari i Politècnic La Fe" matches CNH's
# "Hospital Universitario y Politécnico La Fe".
_NAME_STOPWORDS = {
    # Spanish
    "hospital", "universitario", "universitaria", "general",
    "del", "de", "la", "el", "los", "las", "y",
    "san", "santa", "ntra", "sra", "nuestra", "senora",
    # Catalan / Valencian
    "universitari", "universitaria", "politecnic", "politecnica",
    "i", "el", "el", "dels",
    # Filler that varies between editions
    "complejo", "clinic", "clinico", "clinica",
}


def strip_accents(s: str) -> str:
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def normalize_name(s: str | None) -> str:
    """Accent-strip, lowercase, drop parenthesised qualifiers, drop
    stopwords. Returns empty string for None/empty input.

    Used both for the slug-collision reconciliation and the
    name+city pass. Heuristic — only the SECOND pass uses it; day-
    to-day matching at signup is by public_code (exact)."""
    if not s:
        return ""
    s = strip_accents(s).lower()
    # Drop parenthesised qualifiers — "Hospital X (HX)" → "Hospital X"
    s = re.sub(r"\([^)]*\)", " ", s)
    # Collapse non-alnum to single spaces
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return " ".join(w for w in s.split() if w not in _NAME_STOPWORDS)


def slug_for(name: str, city: str) -> str:
    """Globally-unique-ish slug for fresh hospital rows. Uniqueness
    enforced by the DB UNIQUE constraint; the upsert path detects
    collisions explicitly and falls back to adoption rather than
    erroring out."""
    base = strip_accents(f"{name} {city}".lower())
    return re.sub(r"[^a-z0-9]+", "-", base).strip("-")[:64]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    if not os.path.exists(CSV_PATH):
        raise SystemExit(f"CNH CSV not found at {CSV_PATH}")

    db = AdminSessionLocal()
    inserted = 0
    updated = 0
    slug_reconciled: list[tuple[int, str, str]] = []
    name_reconciled: list[tuple[int, str, str]] = []
    skipped: list[tuple[str, str, str]] = []  # (code, name, reason)

    try:
        with open(CSV_PATH, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        print(f"Read {len(rows)} hospitals from {CSV_PATH}")

        # ------------------------------------------------------------
        # 1. UPSERT each catalog row
        # ------------------------------------------------------------
        for r in rows:
            code = (r["public_code"] or "").strip()
            if not code:
                continue
            name = (r["name"] or "").strip()
            city = (r["city"] or "").strip()
            province = (r["province"] or "").strip()
            aac = (r["autonomous_community"] or "").strip()
            target_slug = slug_for(name, city)

            # Wrap each row in a SAVEPOINT so one failure doesn't
            # poison the rest of the batch. Without this, IntegrityError
            # bubbles up and the surrounding `try` rolls back the
            # entire run.
            sp = db.begin_nested()
            try:
                # First: do we already have a row at this public_code?
                existing = (
                    db.query(Hospital)
                    .filter(Hospital.public_code == code)
                    .first()
                )
                if existing is not None:
                    # Refresh metadata.
                    changed = False
                    if existing.name != name:
                        existing.name = name
                        changed = True
                    if existing.city != city:
                        existing.city = city
                        changed = True
                    if existing.province != province:
                        existing.province = province
                        changed = True
                    if existing.autonomous_community != aac:
                        existing.autonomous_community = aac
                        changed = True
                    if changed:
                        db.flush()
                        updated += 1
                    sp.commit()
                    continue

                # Second: does a row exist at the slug we'd insert?
                # Adopt it (stamp its public_code) rather than collide.
                slug_match = (
                    db.query(Hospital)
                    .filter(Hospital.slug == target_slug)
                    .first()
                )
                if slug_match is not None:
                    slug_match.public_code = code
                    slug_match.name = name
                    if not slug_match.city:
                        slug_match.city = city
                    if not slug_match.province:
                        slug_match.province = province
                    if not slug_match.autonomous_community:
                        slug_match.autonomous_community = aac
                    db.flush()
                    slug_reconciled.append((slug_match.id, name, code))
                    sp.commit()
                    continue

                # Otherwise: insert fresh.
                h = Hospital(
                    public_code=code,
                    name=name,
                    slug=target_slug,
                    city=city,
                    province=province,
                    autonomous_community=aac,
                    country_code="ES",
                )
                db.add(h)
                db.flush()
                inserted += 1
                sp.commit()
            except IntegrityError as e:
                sp.rollback()
                skipped.append((code, name, str(e.orig)[:100]))
            except Exception as e:  # noqa: BLE001
                sp.rollback()
                skipped.append((code, name, f"{type(e).__name__}: {e}"))

        # ------------------------------------------------------------
        # 2. Reconcile pre-CNH rows by normalised name (+ city when
        #    available). Build the catalog lookup once.
        # ------------------------------------------------------------
        # Two indexes: by (normalized_name, normalized_city) — strictest;
        # and by normalized_name alone — fallback when the DB row has
        # no city. The looser index loses precision on names that
        # repeat across cities (San Juan de Dios, Hospital Provincial,
        # etc.), so we only fall back when there's exactly one match.
        cnh_by_name_city: dict[tuple[str, str], str] = {}
        cnh_by_name: dict[str, list[str]] = {}
        for r in rows:
            nn = normalize_name(r["name"])
            nc = normalize_name(r["city"])
            code = (r["public_code"] or "").strip()
            if nn and code:
                cnh_by_name_city[(nn, nc)] = code
                cnh_by_name.setdefault(nn, []).append(code)

        unmatched = (
            db.query(Hospital)
            .filter(Hospital.public_code.is_(None))
            .all()
        )
        for h in unmatched:
            nn = normalize_name(h.name or "")
            nc = normalize_name(h.city or "")
            code: str | None = None
            if nn and nc:
                code = cnh_by_name_city.get((nn, nc))
            if not code and nn:
                candidates = cnh_by_name.get(nn) or []
                if len(candidates) == 1:
                    # Unambiguous name-only match — fine to adopt.
                    code = candidates[0]
            if code:
                h.public_code = code
                # Fill in metadata from the catalog row.
                csv_row = next(
                    (r for r in rows if (r["public_code"] or "").strip() == code),
                    None,
                )
                if csv_row is not None:
                    if not h.city:
                        h.city = (csv_row["city"] or "").strip()
                    if not h.province:
                        h.province = (csv_row["province"] or "").strip()
                    if not h.autonomous_community:
                        h.autonomous_community = (
                            csv_row["autonomous_community"] or ""
                        ).strip()
                db.flush()
                name_reconciled.append((h.id, h.name or "", code))

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    # ------------------------------------------------------------
    # 3. Summary
    # ------------------------------------------------------------
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Inserted (new from CNH):                    {inserted}")
    print(f"  Updated  (existing code, metadata refresh): {updated}")
    print(f"  Slug-adopted (collision on fresh insert):   {len(slug_reconciled)}")
    for hid, name, code in slug_reconciled:
        print(f"    - id={hid}  '{name}'  → {code}")
    print(f"  Name-reconciled (post-pass match):          {len(name_reconciled)}")
    for hid, name, code in name_reconciled:
        print(f"    - id={hid}  '{name}'  → {code}")
    print(f"  Skipped due to errors:                      {len(skipped)}")
    for code, name, reason in skipped:
        print(f"    - {code} '{name}': {reason}")

    # List remaining un-coded rows so the operator can decide.
    db = AdminSessionLocal()
    try:
        leftovers = (
            db.query(Hospital)
            .filter(Hospital.public_code.is_(None))
            .all()
        )
    finally:
        db.close()
    print(f"  Still without public_code:                  {len(leftovers)}")
    for h in leftovers:
        print(f"    - id={h.id}  name={h.name!r}  city={h.city!r}")


if __name__ == "__main__":
    main()
