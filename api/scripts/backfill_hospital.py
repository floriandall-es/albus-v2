"""Backfill a Hospital row + link an existing Tenant to it.

Used right after migration 0051 lands to attach the alpha customer
(Cirugía Torácica) to its parent hospital (Hospital La Fe) so the
data model has at least one non-NULL hospital_id from day one.

Usage (from `api/`):

    python -m scripts.backfill_hospital \\
        --tenant-slug cirugia-toracica-hospital-la-fe \\
        --hospital-name "Hospital La Fe" \\
        --country-code ES \\
        --region-code VC \\
        --commit

Default is dry-run. Add --commit to actually write.

Behaviour:
  - If a Hospital with the given name + country_code already exists,
    re-uses it (idempotent).
  - Otherwise creates a new Hospital row with a slug derived from
    the name.
  - Sets tenants.hospital_id on the target tenant. Refuses to
    overwrite a non-NULL value unless --force is also passed
    (defensive: avoids accidentally re-parenting a department).
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models import Hospital, Tenant


def _slugify(name: str) -> str:
    nfkd = unicodedata.normalize("NFD", name)
    no_accents = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    lowered = no_accents.lower()
    dashed = re.sub(r"[^a-z0-9]+", "-", lowered)
    return dashed.strip("-")[:64] or "hospital"


def run(
    db: Session,
    *,
    tenant_slug: str,
    hospital_name: str,
    country_code: str,
    region_code: str | None,
    commit: bool,
    force: bool,
) -> dict:
    report: dict = {
        "tenant_slug": tenant_slug,
        "hospital_name": hospital_name,
        "country_code": country_code,
        "region_code": region_code,
        "commit": commit,
        "created_hospital": False,
        "reused_hospital": False,
        "linked_tenant": False,
        "skipped_already_linked": False,
    }

    tenant = db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if tenant is None:
        raise SystemExit(f"No tenant found with slug={tenant_slug!r}")

    hospital = (
        db.query(Hospital)
        .filter(
            Hospital.name == hospital_name,
            Hospital.country_code == country_code,
        )
        .first()
    )
    if hospital is None:
        slug = _slugify(hospital_name)
        # Slug collision: append random hex (rare case).
        if db.query(Hospital).filter(Hospital.slug == slug).first():
            import secrets
            slug = f"{slug[:55]}-{secrets.token_hex(3)}"
        hospital = Hospital(
            slug=slug,
            name=hospital_name,
            country_code=country_code,
            region_code=region_code,
        )
        db.add(hospital)
        db.flush()
        report["created_hospital"] = True
    else:
        report["reused_hospital"] = True

    report["hospital_id"] = hospital.id
    report["hospital_slug"] = hospital.slug

    if tenant.hospital_id is None:
        tenant.hospital_id = hospital.id
        report["linked_tenant"] = True
    elif tenant.hospital_id == hospital.id:
        report["skipped_already_linked"] = True
    else:
        if not force:
            raise SystemExit(
                f"Tenant {tenant_slug!r} is already linked to hospital_id="
                f"{tenant.hospital_id}. Re-run with --force to overwrite."
            )
        tenant.hospital_id = hospital.id
        report["linked_tenant"] = True

    if commit:
        db.commit()
    else:
        db.rollback()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-slug", required=True)
    parser.add_argument("--hospital-name", required=True)
    parser.add_argument("--country-code", default="ES")
    parser.add_argument("--region-code", default=None)
    parser.add_argument("--commit", action="store_true")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite tenant.hospital_id even when it's already set.",
    )
    args = parser.parse_args()

    with SessionLocal() as db:
        report = run(
            db,
            tenant_slug=args.tenant_slug,
            hospital_name=args.hospital_name,
            country_code=args.country_code,
            region_code=args.region_code,
            commit=args.commit,
            force=args.force,
        )

    mode = "COMMITTED" if args.commit else "DRY-RUN (no changes saved)"
    print(f"=== Hospital backfill — {mode} ===")
    print(f"tenant: {report['tenant_slug']}")
    print(
        f"hospital: id={report['hospital_id']} slug={report['hospital_slug']} "
        f"name={report['hospital_name']!r} "
        f"({'created' if report['created_hospital'] else 'reused existing'})"
    )
    if report["linked_tenant"]:
        print("→ linked tenant to hospital.")
    elif report["skipped_already_linked"]:
        print("→ tenant was already linked to this hospital — no change.")
    if not args.commit:
        print("\nRe-run with --commit to persist.")


if __name__ == "__main__":
    sys.exit(main() or 0)
