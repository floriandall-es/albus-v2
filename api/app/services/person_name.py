"""Helpers for the split first_name / last_name + canonical name flow.

Sprint 18: persons gained `first_name` and `last_name`, but `name`
stays as the always-populated canonical display string. These
helpers keep the three fields in sync wherever a person is created
or updated (signup, invitation accept, profile update).
"""

from __future__ import annotations


def compose_name(
    *,
    name: str | None,
    first_name: str | None,
    last_name: str | None,
) -> tuple[str, str | None, str | None]:
    """Return a (name, first_name, last_name) triple that's safe to
    persist. The caller passes whatever the request provided (any
    field can be None or empty); this function chooses the
    canonical form:

    - If first_name OR last_name is provided, the canonical `name`
      is "first + last" (trimmed, single-space).
    - Otherwise the canonical `name` is the legacy `name` field —
      callers must guarantee one of the two is set or pre-validate
      themselves.
    - The split fields are returned untouched (None stays None) so
      we don't store invented strings.
    """
    fn = (first_name or "").strip() or None
    ln = (last_name or "").strip() or None
    legacy = (name or "").strip() or None

    if fn or ln:
        composed = " ".join(part for part in (fn, ln) if part).strip()
        return composed, fn, ln
    if legacy:
        return legacy, None, None
    # Caller should have validated. Return empty string + nones so
    # the DB integrity constraint (name NOT NULL) is the safety net.
    return "", None, None
