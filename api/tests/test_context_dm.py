"""Reproduction: 'Comentar' (in-context DM) on a bloqueo does nothing.

Exercises POST /api/dms/context from both the requester side (member
commenting the reviewer) and the reviewer side (admin commenting the
requester). If either 4xx/5xx, we've reproduced the live bug.
"""
from __future__ import annotations


def _onboard(client, headers, email, name="Miembro"):
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": email, "person_name": name, "roles": ["member"]},
    )
    assert r.status_code in (200, 201), r.text
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"accept_terms": True, "password": "memberpass"},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["person"]["id"], r.json()["access_token"]


def test_context_dm_bloqueo_both_sides(auth_client, client):
    _client, admin_h, info = auth_client
    admin_person_id = info["person_id"]
    admin_membership_id = info["membership_id"]

    member_pid, member_token = _onboard(client, admin_h, "m@example.com")
    member_h = {"Authorization": f"Bearer {member_token}"}

    # Member files a bloqueo routed to the admin as reviewer.
    r = client.post(
        "/api/me/availability-requests",
        headers=member_h,
        json={
            "start_date": "2026-07-10",
            "end_date": "2026-07-15",
            "block_type": "vacation",
            "reviewer_membership_id": admin_membership_id,
        },
    )
    assert r.status_code == 201, r.text
    block_id = r.json()["id"]

    # 1) Requester (member) → reviewer (admin).
    r = client.post(
        "/api/dms/context",
        headers=member_h,
        json={
            "peer_person_id": admin_person_id,
            "context_kind": "bloqueo",
            "context_id": block_id,
        },
    )
    assert r.status_code == 201, f"requester->reviewer FAILED: {r.status_code} {r.text}"

    # 2) Reviewer (admin) → requester (member).
    r = client.post(
        "/api/dms/context",
        headers=admin_h,
        json={
            "peer_person_id": member_pid,
            "context_kind": "bloqueo",
            "context_id": block_id,
        },
    )
    assert r.status_code == 201, f"reviewer->requester FAILED: {r.status_code} {r.text}"


def test_context_dm_when_peer_hidden_from_directory(auth_client, client):
    """The suspected live cause: a party to the bloqueo who has hidden
    themselves from the hospital directory cannot be reached via
    'Comentar' — even though both sides are parties to the same
    bloqueo. _peer_is_in_my_hospital requires directory_visible=TRUE."""
    _client, admin_h, info = auth_client
    admin_person_id = info["person_id"]
    admin_membership_id = info["membership_id"]

    member_pid, member_token = _onboard(client, admin_h, "hidden@example.com")
    member_h = {"Authorization": f"Bearer {member_token}"}

    # Member hides from the directory.
    r = client.patch(
        "/api/me/directory-visibility",
        headers=member_h,
        json={"directory_visible": False},
    )
    assert r.status_code == 200, r.text

    r = client.post(
        "/api/me/availability-requests",
        headers=member_h,
        json={
            "start_date": "2026-07-10",
            "end_date": "2026-07-15",
            "block_type": "vacation",
            "reviewer_membership_id": admin_membership_id,
        },
    )
    assert r.status_code == 201, r.text
    block_id = r.json()["id"]

    # Admin tries to "Comentar" on the hidden member's bloqueo.
    r = client.post(
        "/api/dms/context",
        headers=admin_h,
        json={
            "peer_person_id": member_pid,
            "context_kind": "bloqueo",
            "context_id": block_id,
        },
    )
    assert r.status_code == 201, (
        f"reviewer->hidden requester FAILED: {r.status_code} {r.text}"
    )


def test_context_dm_cannot_reach_hidden_unrelated_third_party(
    auth_client, client
):
    """Security boundary: the directory opt-out is only ignored for a
    *party* to the entity. A hidden person who is NOT the bloqueo's
    requester/reviewer must stay unreachable — the relaxation must not
    become a backdoor to cold-message anyone who hid themselves."""
    _client, admin_h, info = auth_client
    admin_membership_id = info["membership_id"]

    member_pid, member_token = _onboard(client, admin_h, "party@example.com", "Party")
    member_h = {"Authorization": f"Bearer {member_token}"}

    third_pid, third_token = _onboard(
        client, admin_h, "stranger@example.com", "Stranger"
    )
    third_h = {"Authorization": f"Bearer {third_token}"}
    # The unrelated third party hides from the directory.
    r = client.patch(
        "/api/me/directory-visibility",
        headers=third_h,
        json={"directory_visible": False},
    )
    assert r.status_code == 200, r.text

    # Member files a bloqueo reviewed by the admin (third party uninvolved).
    r = client.post(
        "/api/me/availability-requests",
        headers=member_h,
        json={
            "start_date": "2026-08-01",
            "end_date": "2026-08-03",
            "block_type": "vacation",
            "reviewer_membership_id": admin_membership_id,
        },
    )
    assert r.status_code == 201, r.text
    block_id = r.json()["id"]

    # Admin can see the bloqueo, but names the HIDDEN stranger as peer.
    r = client.post(
        "/api/dms/context",
        headers=admin_h,
        json={
            "peer_person_id": third_pid,
            "context_kind": "bloqueo",
            "context_id": block_id,
        },
    )
    assert r.status_code == 404, (
        f"hidden unrelated third party should stay unreachable, got "
        f"{r.status_code} {r.text}"
    )
