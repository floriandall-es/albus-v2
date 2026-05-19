"""Onboarding preset definitions.

The admin picks one of three presets on the first onboarding step;
the choice is stored on `tenants.preset_kind` and the matching
default categories are seeded so subsequent wizard steps show them
pre-populated.

Adding a new preset = adding a new entry to PRESETS plus a new
literal in PRESET_KINDS (and the CHECK constraint in migration
0029). Do NOT add a preset that hasn't been validated against a
real customer in that vertical — wrong defaults look authoritative
and tempt admins to keep templates that don't fit.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Keep in sync with the CHECK constraint in migration 0029 and the
# frontend `PresetKind` union.
PRESET_KINDS = ("quirurgico", "medico", "otro")
PresetKind = str  # validated at the FastAPI schema layer


@dataclass(frozen=True)
class PresetDef:
    kind: str
    label: str  # short Spanish label, shown on the card
    sublabel: str  # one-liner describing the typical service
    # Default `Category` rows (professional levels) to seed on first
    # selection. Order matters — we persist them in this order so the
    # categories step renders them top-to-bottom in seniority order.
    default_categories: list[str] = field(default_factory=list)


PRESETS: dict[str, PresetDef] = {
    "quirurgico": PresetDef(
        kind="quirurgico",
        label="Servicio quirúrgico",
        sublabel="Hospital, con quirófano + consulta + guardia",
        default_categories=[
            "Jefe de servicio",
            "Jefe clínico",
            "Adjunto",
            "Residente R5",
            "Residente R4",
            "Residente R3",
            "Residente R2",
            "Residente R1",
        ],
    ),
    "medico": PresetDef(
        kind="medico",
        label="Servicio médico",
        sublabel="Hospital, sin quirófano (planta, consulta, guardia)",
        default_categories=[
            "Jefe de servicio",
            "Jefe clínico",
            "Adjunto",
            "Residente R5",
            "Residente R4",
            "Residente R3",
            "Residente R2",
            "Residente R1",
        ],
    ),
    "otro": PresetDef(
        kind="otro",
        label="Otro — empezar en blanco",
        sublabel="Configuro mis categorías y turnos desde cero",
        default_categories=[],
    ),
}


def get_preset(kind: str) -> PresetDef:
    """Lookup; raises KeyError on unknown kind. Routes should
    pre-validate via the Pydantic schema."""
    return PRESETS[kind]
