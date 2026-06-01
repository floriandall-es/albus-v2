"""Per-rule slot assignment strategies: PUT /api/slots/{id}/rules.

Covers validation, default-rule creation on POST, cascade on slot delete,
and tenant isolation of the new tables.
"""
from __future__ import annotations

from sqlalchemy import create_engine, text

from app.core.config import settings


def _onboard(client, headers, email, name="P"):
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": email, "person_name": name, "roles": ["member"]},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"accept_terms": True, "password": "memberpass"},
    )
    return r.json()["person"]["id"]


def _create_slot(client, headers, **overrides):
    body = {
        "name": "Guardia",
        "days_applied": "all",
        "staffing_mode": "single",
        "headcount": 1,
        "post_slot_rest": False,
        "counts_for_equity": True,
        "team_roles": [],
        "skills_required": [],
    }
    body.update(overrides)
    r = client.post("/api/slots", headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_default_rule_created_on_post(auth_client):
    client, headers, _ = auth_client
    s = _create_slot(client, headers, name="Guardia 24h")
    assert len(s["rules"]) == 1
    rule = s["rules"][0]
    assert rule["strategy"] == "solver"
    assert rule["days_bitmap"] == 0b1111111
    assert rule["anchor_date"] is None


def test_put_solver_only_replace(auth_client):
    client, headers, _ = auth_client
    s = _create_slot(client, headers, name="X")
    body = {
        "rules": [
            {"days_bitmap": 0b1111111, "strategy": "solver"},
        ]
    }
    r = client.put(f"/api/slots/{s['id']}/rules", headers=headers, json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert len(out["rules"]) == 1
    assert out["rules"][0]["strategy"] == "solver"


def test_put_two_non_overlapping_rules(auth_client):
    client, headers, _ = auth_client
    pid_a = _onboard(client, headers, "a@example.com", "A")
    pid_b = _onboard(client, headers, "b@example.com", "B")
    s = _create_slot(client, headers, name="Mixed")
    body = {
        "rules": [
            {"days_bitmap": 0b0011111, "strategy": "solver"},  # Mon-Fri
            {
                "days_bitmap": 0b1100000,  # Sat+Sun
                "strategy": "rotation",
                "anchor_date": "2026-05-02",  # a Saturday
                "rotation_blocks": [{"position": 0, "days_bitmap": 0b1100000}],
                "rotation_members": [
                    {"position": 0, "person_id": pid_a},
                    {"position": 1, "person_id": pid_b},
                ],
            },
        ]
    }
    r = client.put(f"/api/slots/{s['id']}/rules", headers=headers, json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert len(out["rules"]) == 2
    assert out["rules"][1]["strategy"] == "rotation"
    assert out["rules"][1]["anchor_date"] == "2026-05-02"
    assert len(out["rules"][1]["rotation_members"]) == 2


def test_put_overlapping_rules_400(auth_client):
    client, headers, _ = auth_client
    s = _create_slot(client, headers, name="Bad")
    r = client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {"days_bitmap": 0b0011111, "strategy": "solver"},
                {"days_bitmap": 0b0001100, "strategy": "solver"},  # overlaps
            ]
        },
    )
    assert r.status_code == 400
    assert "solapa" in r.json()["detail"].lower()


def test_put_rotation_without_anchor_400(auth_client):
    client, headers, _ = auth_client
    pid = _onboard(client, headers, "x@example.com", "X")
    s = _create_slot(client, headers, name="Rot")
    r = client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b1111111,
                    "strategy": "rotation",
                    "rotation_blocks": [
                        {"position": 0, "days_bitmap": 0b1111111}
                    ],
                    "rotation_members": [{"position": 0, "person_id": pid}],
                }
            ]
        },
    )
    assert r.status_code == 400
    assert "ancla" in r.json()["detail"].lower()


def test_put_rotation_blocks_dont_partition_400(auth_client):
    client, headers, _ = auth_client
    pid = _onboard(client, headers, "x@example.com", "X")
    s = _create_slot(client, headers, name="Rot")
    r = client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b0011111,  # Mon-Fri
                    "strategy": "rotation",
                    "anchor_date": "2026-05-04",
                    "rotation_blocks": [
                        # Only Mon-Wed; misses Thu+Fri
                        {"position": 0, "days_bitmap": 0b0000111}
                    ],
                    "rotation_members": [{"position": 0, "person_id": pid}],
                }
            ]
        },
    )
    assert r.status_code == 400


def test_put_fixed_weekly_pin_outside_bitmap_400(auth_client):
    client, headers, _ = auth_client
    pid = _onboard(client, headers, "x@example.com", "X")
    s = _create_slot(client, headers, name="FW")
    r = client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b0011111,  # Mon-Fri
                    "strategy": "fixed_weekly",
                    "weekly_pins": [{"weekday": 5, "person_id": pid}],  # Saturday
                }
            ]
        },
    )
    assert r.status_code == 400


def test_slot_cascade_deletes_rules_and_children(auth_client):
    client, headers, info = auth_client
    pid_a = _onboard(client, headers, "a@example.com", "A")
    pid_b = _onboard(client, headers, "b@example.com", "B")
    s = _create_slot(client, headers, name="Y")
    client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b1111111,
                    "strategy": "rotation",
                    "anchor_date": "2026-05-04",
                    "rotation_blocks": [
                        {"position": 0, "days_bitmap": 0b1111111}
                    ],
                    "rotation_members": [
                        {"position": 0, "person_id": pid_a},
                        {"position": 1, "person_id": pid_b},
                    ],
                }
            ]
        },
    )
    sid = s["id"]
    r = client.delete(f"/api/slots/{sid}", headers=headers)
    assert r.status_code == 204
    engine = create_engine(settings.runtime_db_url, future=True)
    with engine.begin() as conn:
        conn.execute(
            text("SET LOCAL app.tenant_id = :t"), {"t": str(info["tenant_id"])}
        )
        n_rules = conn.execute(
            text("SELECT count(*) FROM slot_rules WHERE slot_id = :s"),
            {"s": sid},
        ).scalar_one()
        n_blocks = conn.execute(
            text(
                "SELECT count(*) FROM slot_rule_rotation_blocks b JOIN slot_rules r"
                " ON r.id = b.rule_id WHERE r.slot_id = :s"
            ),
            {"s": sid},
        ).scalar_one()
        n_members = conn.execute(
            text(
                "SELECT count(*) FROM slot_rule_rotation_members m JOIN slot_rules r"
                " ON r.id = m.rule_id WHERE r.slot_id = :s"
            ),
            {"s": sid},
        ).scalar_one()
    engine.dispose()
    assert n_rules == 0
    assert n_blocks == 0
    assert n_members == 0


def test_rules_tenant_isolation(auth_client, second_tenant):
    client, headers_a, info_a = auth_client
    headers_b, _info_b = second_tenant
    s = _create_slot(client, headers_a, name="A_only")
    sid = s["id"]

    # Tenant B can't replace tenant A's rules.
    r = client.put(
        f"/api/slots/{sid}/rules",
        headers=headers_b,
        json={"rules": [{"days_bitmap": 0b1111111, "strategy": "solver"}]},
    )
    assert r.status_code == 404

    # Raw probe: as albus_app with B's tenant scope, A's rules invisible.
    engine = create_engine(settings.runtime_db_url, future=True)
    with engine.begin() as conn:
        conn.execute(
            text("SET LOCAL app.tenant_id = :t"), {"t": str(info_a["tenant_id"])}
        )
        a_count = conn.execute(
            text("SELECT count(*) FROM slot_rules WHERE slot_id = :s"),
            {"s": sid},
        ).scalar_one()
    engine.dispose()
    assert a_count == 1  # the default rule


def test_put_rules_replaces_atomically(auth_client):
    client, headers, _ = auth_client
    s = _create_slot(client, headers, name="R")
    # Replace with two rules.
    r = client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {"days_bitmap": 0b0011111, "strategy": "solver"},
                {"days_bitmap": 0b1100000, "strategy": "manual"},
            ]
        },
    )
    assert r.status_code == 200
    assert [rl["strategy"] for rl in r.json()["rules"]] == ["solver", "manual"]
    # Replace with a single rule again.
    r = client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={"rules": [{"days_bitmap": 0b1111111, "strategy": "solver"}]},
    )
    assert r.status_code == 200
    assert len(r.json()["rules"]) == 1
