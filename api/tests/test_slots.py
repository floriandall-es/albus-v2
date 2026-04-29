"""Slots CRUD with nested team_roles + skills_required, atomicity, cascade."""
from sqlalchemy import create_engine, text

from app.core.config import settings


def _make_categories(client, headers, names):
    out = {}
    for n in names:
        r = client.post("/api/categories", headers=headers, json={"name": n})
        assert r.status_code == 201
        out[n] = r.json()["id"]
    return out


def _make_skills(client, headers, names):
    out = {}
    for n in names:
        r = client.post("/api/skills", headers=headers, json={"name": n})
        assert r.status_code == 201
        out[n] = r.json()["id"]
    return out


def test_slot_create_with_nested(auth_client):
    client, headers, _ = auth_client
    cats = _make_categories(client, headers, ["Senior", "Medio", "Junior"])
    skills = _make_skills(client, headers, ["ECMO", "Anestesia"])

    payload = {
        "name": "Guardia REA",
        "start_time": "20:00:00",
        "end_time": "08:00:00",
        "days_applied": "all",
        "staffing_mode": "team_composition",
        "headcount": 3,
        "post_slot_rest": True,
        "team_roles": [
            {
                "role_label": "Senior",
                "headcount": 1,
                "category_ids": [cats["Senior"]],
            },
            {
                "role_label": "Junior",
                "headcount": 2,
                "category_ids": [cats["Medio"], cats["Junior"]],
            },
        ],
        "skills_required": [
            {"skill_id": skills["ECMO"], "strength": "hard"},
            {"skill_id": skills["Anestesia"], "strength": "soft"},
        ],
    }
    r = client.post("/api/slots", headers=headers, json=payload)
    assert r.status_code == 201, r.text
    slot = r.json()
    assert slot["name"] == "Guardia REA"
    assert slot["crosses_midnight"] is True
    assert len(slot["team_roles"]) == 2
    assert len(slot["skills_required"]) == 2

    # GET back the slot
    r = client.get(f"/api/slots/{slot['id']}", headers=headers)
    assert r.status_code == 200
    got = r.json()
    labels = {tr["role_label"] for tr in got["team_roles"]}
    assert labels == {"Senior", "Junior"}
    junior = next(tr for tr in got["team_roles"] if tr["role_label"] == "Junior")
    assert set(junior["category_ids"]) == {cats["Medio"], cats["Junior"]}


def test_slot_update_replaces_nested_atomically(auth_client):
    client, headers, _ = auth_client
    cats = _make_categories(client, headers, ["A", "B"])
    skills = _make_skills(client, headers, ["S1", "S2"])

    r = client.post(
        "/api/slots",
        headers=headers,
        json={
            "name": "X",
            "days_applied": "all",
            "staffing_mode": "team_composition",
            "team_roles": [
                {"role_label": "Lead", "headcount": 1, "category_ids": [cats["A"]]}
            ],
            "skills_required": [{"skill_id": skills["S1"], "strength": "hard"}],
        },
    )
    assert r.status_code == 201
    sid = r.json()["id"]

    # Replace team_roles + skills_required entirely
    r = client.put(
        f"/api/slots/{sid}",
        headers=headers,
        json={
            "team_roles": [
                {"role_label": "Backup", "headcount": 2, "category_ids": [cats["B"]]}
            ],
            "skills_required": [{"skill_id": skills["S2"], "strength": "soft"}],
        },
    )
    assert r.status_code == 200, r.text
    got = r.json()
    assert [tr["role_label"] for tr in got["team_roles"]] == ["Backup"]
    assert got["team_roles"][0]["category_ids"] == [cats["B"]]
    assert [s["skill_id"] for s in got["skills_required"]] == [skills["S2"]]


def test_slot_cascade_delete(auth_client):
    client, headers, info = auth_client
    cats = _make_categories(client, headers, ["A"])
    skills = _make_skills(client, headers, ["S1"])

    r = client.post(
        "/api/slots",
        headers=headers,
        json={
            "name": "Y",
            "days_applied": "weekdays",
            "staffing_mode": "team_composition",
            "team_roles": [
                {"role_label": "L", "headcount": 1, "category_ids": [cats["A"]]}
            ],
            "skills_required": [{"skill_id": skills["S1"], "strength": "hard"}],
        },
    )
    assert r.status_code == 201
    sid = r.json()["id"]

    r = client.delete(f"/api/slots/{sid}", headers=headers)
    assert r.status_code == 204

    # Verify nested rows gone via raw probe
    engine = create_engine(settings.runtime_db_url, future=True)
    with engine.begin() as conn:
        conn.execute(
            text("SET LOCAL app.tenant_id = :t"), {"t": str(info["tenant_id"])}
        )
        n_roles = conn.execute(
            text("SELECT count(*) FROM slot_team_roles WHERE slot_id = :s"),
            {"s": sid},
        ).scalar_one()
        n_skills = conn.execute(
            text("SELECT count(*) FROM slot_skills_required WHERE slot_id = :s"),
            {"s": sid},
        ).scalar_one()
        n_role_cats = conn.execute(
            text(
                """
                SELECT count(*) FROM slot_team_role_categories rc
                JOIN slot_team_roles tr ON tr.id = rc.slot_team_role_id
                WHERE tr.slot_id = :s
                """
            ),
            {"s": sid},
        ).scalar_one()
    engine.dispose()
    assert n_roles == 0
    assert n_skills == 0
    assert n_role_cats == 0


def test_slots_tenant_isolation(auth_client, second_tenant):
    client, headers_a, _ = auth_client
    headers_b, _ = second_tenant

    r = client.post(
        "/api/slots",
        headers=headers_a,
        json={"name": "AA", "days_applied": "all", "staffing_mode": "single"},
    )
    assert r.status_code == 201
    a_id = r.json()["id"]
    r = client.post(
        "/api/slots",
        headers=headers_b,
        json={"name": "BB", "days_applied": "all", "staffing_mode": "single"},
    )
    assert r.status_code == 201

    r = client.get("/api/slots", headers=headers_a)
    assert {s["name"] for s in r.json()} == {"AA"}
    r = client.get("/api/slots", headers=headers_b)
    assert {s["name"] for s in r.json()} == {"BB"}

    r = client.get(f"/api/slots/{a_id}", headers=headers_b)
    assert r.status_code == 404


def test_slot_invalid_staffing_mode_422(auth_client):
    client, headers, _ = auth_client
    r = client.post(
        "/api/slots",
        headers=headers,
        json={"name": "Z", "days_applied": "all", "staffing_mode": "garbage"},
    )
    assert r.status_code == 422


def test_slot_unknown_category_422(auth_client):
    client, headers, _ = auth_client
    r = client.post(
        "/api/slots",
        headers=headers,
        json={
            "name": "BadCats",
            "days_applied": "all",
            "staffing_mode": "team_composition",
            "team_roles": [
                {"role_label": "L", "headcount": 1, "category_ids": [99999]}
            ],
        },
    )
    assert r.status_code == 422
