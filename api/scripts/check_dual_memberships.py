"""Diagnostic: find persons with multiple Memberships in one tenant.

In the intended data model, each Person has exactly ONE Membership
per Tenant — either main team (group_id IS NULL) or a sub-equipo
(group_id IS NOT NULL), not both. The /admin/team UI assumes this
when surfacing "is this person main or sub-equipo?".

This script prints every Person in the target tenant that has more
than one Membership, plus a one-line summary. Useful when a residents
or sub-equipo member is leaking into a main-team-only view (e.g.
the Libre row on /admin/schedule).

Usage (from `api/`):

    python -m scripts.check_dual_memberships \\
        --tenant-slug cirugia-toracica-hospital-la-fe

Read-only — never writes anything.
"""

from __future__ import annotations

import argparse
import sys

from sqlalchemy.orm import Session

from app.db.session import SessionLocal, set_tenant
from app.models import Group, Membership, Person, Tenant


def _resolve_tenant(db: Session, slug: str) -> Tenant:
    t = db.query(Tenant).filter(Tenant.slug == slug).first()
    if t is None:
        raise SystemExit(f"No tenant found with slug={slug!r}")
    return t


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-slug", required=True)
    args = parser.parse_args()

    with SessionLocal() as db:
        tenant = _resolve_tenant(db, args.tenant_slug)
        set_tenant(db, tenant.id)

        # All memberships in this tenant + their Person + Group.
        rows = (
            db.query(Membership, Person, Group)
            .join(Person, Person.id == Membership.person_id)
            .outerjoin(Group, Group.id == Membership.group_id)
            .filter(Membership.tenant_id == tenant.id)
            .order_by(Person.name)
            .all()
        )
        by_person: dict[int, list[tuple[Membership, Person, Group | None]]] = {}
        for m, p, g in rows:
            by_person.setdefault(p.id, []).append((m, p, g))

        offenders = {pid: rows for pid, rows in by_person.items() if len(rows) > 1}

        print(f"=== Dual-membership scan — tenant {tenant.slug} (id={tenant.id}) ===")
        print(f"persons with >1 Membership: {len(offenders)}")
        if not offenders:
            print("All clean. No person has more than one membership.")
        # Also dump a full roster so we can see where each person sits.
        # This catches the OTHER possible drift: a person who should be
        # in a sub-equipo but whose only membership is on the main team
        # (or vice versa). The dual-membership scan can't find this
        # because there's only one row per person.
        print()
        print("=== Full roster (one line per Membership) ===")
        from app.models import Category
        cats_by_id = {c.id: c.name for c in db.query(Category).all()}
        for pid, rows in sorted(by_person.items(), key=lambda kv: kv[1][0][1].name):
            for m, p, g in rows:
                scope = "MAIN TEAM" if g is None else f"sub-equipo {g.name!r}"
                cat = cats_by_id.get(m.category_id, "—") if m.category_id else "—"
                roles = ",".join(m.roles or [])
                disabled = " (disabled)" if m.disabled_at else ""
                print(
                    f"  {p.name!s:30}  cat={cat!s:14}  "
                    f"roles=[{roles}]  -> {scope}{disabled}"
                )
        if not offenders:
            return
        print()
        for pid, rows in offenders.items():
            p = rows[0][1]
            print(f"Person id={p.id} name={p.name!r} email={p.email!r}")
            for m, _p, g in rows:
                scope = "MAIN TEAM" if g is None else f"sub-equipo {g.name!r}"
                roles = ", ".join(m.roles or [])
                disabled = (
                    f" disabled_at={m.disabled_at.isoformat()}"
                    if m.disabled_at
                    else ""
                )
                print(
                    f"  - membership_id={m.id} {scope} roles=[{roles}]"
                    f" category_id={m.category_id}{disabled}"
                )
            print()
        print(
            "If a person should clearly belong to only ONE team, "
            "delete the unwanted Membership row(s) directly:\n"
            "  docker compose -f infra/docker-compose.prod.yml exec db psql"
            " -U $POSTGRES_USER $POSTGRES_DB \\\n"
            "    -c \"DELETE FROM memberships WHERE id = <membership_id>;\""
        )


if __name__ == "__main__":
    sys.exit(main() or 0)
