"""One-shot CNH ingestion: seed `hospitals` from the official catalog.

Reads `api/data/cnh_2025_directorio.csv` (trimmed projection of the
Ministerio de Sanidad's Catálogo Nacional de Hospitales) and
upserts one Hospital row per CNH entry, keyed on `public_code`.

Run inside the API container (so SessionLocal/AdminSessionLocal +
the SQLAlchemy models work out of the box):

    docker compose -f infra/docker-compose.prod.yml exec api \\
        python -m scripts.seed_hospitals_cnh

Three operations, in order:

1. Upsert by public_code. For every CSV row, INSERT … ON CONFLICT
   (public_code) DO UPDATE — sets name, city, province,
   autonomous_community, even on existing rows so subsequent
   re-runs propagate name changes (hospital rename, address fix,
   etc.) from a newer catalog edition.

2. Reconcile pre-CNH rows: any existing hospital with
   `public_code IS NULL` is matched against the catalog by
   (normalized name, city). Exact normalized match → stamp its
   public_code from the catalog row, leave its slug + id alone
   (so existing FK references in `tenants` keep working).
   Ambiguous or no-match rows are listed at the end for the
   operator to handle by hand.

3. Print a summary: # inserted / # updated / # reconciled /
   # left without public_code. Operator decides whether to drop
   the leftover rows or keep them as one-off / private hospitals.

Idempotent. Safe to re-run any time. Uses AdminSessionLocal so
RLS / per-tenant policies don't filter the cross-tenant hospital
read.
"""

from __future__ import annotations

import csv
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text

from app.db.session import AdminSessionLocal
from app.models import Hospital


CSV_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "cnh_2025_directorio.csv",
)


def normalize_name(s: str) -> str:
    """Strip accents, lowercase, collapse whitespace + drop common
    fluff so we can match "Hospital Universitario y Politécnico La
    Fe" against "Hospital La Fe" with some chance of success.

    Heuristic — used only for the one-shot reconciliation pass.
    The day-to-day matching at signup is by public_code, where
    exact equality applies.
    """
    if not s:
        return ""
    # NFD + strip combining marks → accent-free
    nfkd = unicodedata.normalize("NFKD", s)
    ascii_only = "".join(c for c in nfkd if not unicodedata.combining(c))
    lower = ascii_only.lower()
    # Trim parenthesised qualifiers — "Hospital X (HX)" → "Hospital X"
    lower = re.sub(r"\([^)]*\)", " ", lower)
    # Collapse non-alnum to single spaces
    lower = re.sub(r"[^a-z0-9]+", " ", lower).strip()
    # Drop common Spanish stopwords that show up in long official
    # names but rarely match user-typed input.
    drop = {"hospital", "universitario", "universitaria", "general",
            "del", "de", "la", "el", "los", "las", "y", "san", "santa",
            "ntra", "sra"}
    return " ".join(w for w in lower.split() if w not in drop)


def slug_for(name: str, city: str) -> str:
    """Generate a globally-unique-ish slug for fresh hospital rows.
    Keep it short and predictable so the directory + signup URLs
    read well; uniqueness is enforced by the DB UNIQUE constraint
    so any collision raises and we deal with it manually."""
    nfkd = unicodedata.normalize("NFKD", f"{name} {city}".lower())
    ascii_only = "".join(c for c in nfkd if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-")[:64]


def main() -> None:
    if not os.path.exists(CSV_PATH):
        raise SystemExit(f"CNH CSV not found at {CSV_PATH}")

    db = AdminSessionLocal()
    inserted = 0
    updated = 0
    reconciled: list[tuple[int, str, str]] = []
    unmatched_existing: list[tuple[int, str | None, str | None]] = []

    try:
        # ------------------------------------------------------------
        # 1. Upsert every CNH row by public_code.
        # ------------------------------------------------------------
        with open(CSV_PATH, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        print(f"Read {len(rows)} hospitals from {CSV_PATH}")

        for r in rows:
            code = (r["public_code"] or "").strip()
            if not code:
                continue
            name = (r["name"] or "").strip()
            city = (r["city"] or "").strip()
            province = (r["province"] or "").strip()
            aac = (r["autonomous_community"] or "").strip()

            # Check if row exists by public_code.
            existing = (
                db.query(Hospital)
                .filter(Hospital.public_code == code)
                .first()
            )
            if existing is None:
                # Fresh insert. Slug is derived from name+city; if
                # that slug collides with a pre-existing un-coded
                # hospital (rare — same name, same city) we let the
                # DB raise so the operator notices.
                h = Hospital(
                    public_code=code,
                    name=name,
                    slug=slug_for(name, city),
                    city=city,
                    province=province,
                    autonomous_community=aac,
                    country_code="ES",
                )
                db.add(h)
                try:
                    db.flush()
                    inserted += 1
                except Exception as e:  # noqa: BLE001
                    db.rollback()
                    print(f"  SKIP {code} {name!r}: insert failed: {e}")
            else:
                # Refresh metadata in case the catalog updated it.
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

        # ------------------------------------------------------------
        # 2. Reconcile pre-CNH rows by normalized name + city.
        # ------------------------------------------------------------
        # Build the CNH lookup once: (normalized_name, normalized_city)
        # → public_code. We use city in the key because the same
        # hospital name appears in many cities (San Juan de Dios,
        # Hospital General, etc.).
        cnh_by_key: dict[tuple[str, str], str] = {}
        for r in rows:
            key = (
                normalize_name(r["name"]),
                normalize_name(r["city"]),
            )
            # If multiple CNH rows collide on the same normalized key
            # (rare), the last one wins — operator can clean up later.
            cnh_by_key[key] = (r["public_code"] or "").strip()

        unmatched_hospitals = (
            db.query(Hospital)
            .filter(Hospital.public_code.is_(None))
            .all()
        )
        for h in unmatched_hospitals:
            key = (normalize_name(h.name or ""), normalize_name(h.city or ""))
            code = cnh_by_key.get(key)
            if code:
                # Stamp the code. Keep id + slug + name unchanged so
                # tenant FKs and hospital_slug-keyed routes keep
                # working. Pull city/province from CSV if missing
                # locally.
                h.public_code = code
                # Fill in city/province/aac if our row was missing them
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
                reconciled.append((h.id, h.name or "", code))
            else:
                unmatched_existing.append((h.id, h.name, h.city))

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
    print(f"  Inserted (fresh from CNH):      {inserted}")
    print(f"  Updated  (existing public_code, refreshed metadata): {updated}")
    print(f"  Reconciled (was NULL, now stamped via name+city match): {len(reconciled)}")
    for hid, name, code in reconciled:
        print(f"    - id={hid}  '{name}'  → {code}")
    print(f"  Still without public_code:      {len(unmatched_existing)}")
    for hid, name, city in unmatched_existing:
        print(f"    - id={hid}  name={name!r}  city={city!r}")
    if unmatched_existing:
        print()
        print("  These rows weren't in the CNH (private/demo/typo). They keep")
        print("  working as legacy data, but Phase D's signup flow will refuse")
        print("  to create new tenants under them until they're either matched")
        print("  by hand or merged into a CNH-coded row.")


if __name__ == "__main__":
    main()
