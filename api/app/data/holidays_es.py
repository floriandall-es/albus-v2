"""Static catalog of Spanish holidays for 2025 and 2026.

Sources: BOE national calendar + autonomous community official labour
calendars. We hardcode the dates rather than computing them so admins get
the same answer every time without depending on third-party APIs.

Coverage:
- National (region_code=None): full coverage 2025 + 2026.
- Regional: Madrid (ES-MD), Cataluña (ES-CT), Valencia (ES-VC), Andalucía
  (ES-AN). The remaining 13 autonomous communities are TODO and currently
  return only the national block — admins in those regions will need to add
  their regional holidays manually until we extend the catalog.

Each entry is a dict with: date (ISO YYYY-MM-DD), name, source, region_code.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# National holidays — apply to every Spanish tenant regardless of region.
# Note: a few national holidays move to the nearest weekday (or are dropped)
# when they fall on Sunday; the BOE list is the source of truth, we just
# transcribe it.
# ---------------------------------------------------------------------------
NATIONAL: list[dict] = [
    # 2025
    {"date": "2025-01-01", "name": "Año Nuevo", "source": "national", "region_code": None},
    {"date": "2025-01-06", "name": "Epifanía del Señor", "source": "national", "region_code": None},
    {"date": "2025-04-18", "name": "Viernes Santo", "source": "national", "region_code": None},
    {"date": "2025-05-01", "name": "Fiesta del Trabajo", "source": "national", "region_code": None},
    {"date": "2025-08-15", "name": "Asunción de la Virgen", "source": "national", "region_code": None},
    {"date": "2025-11-01", "name": "Todos los Santos", "source": "national", "region_code": None},
    {"date": "2025-12-06", "name": "Día de la Constitución", "source": "national", "region_code": None},
    {"date": "2025-12-08", "name": "Inmaculada Concepción", "source": "national", "region_code": None},
    {"date": "2025-12-25", "name": "Natividad del Señor", "source": "national", "region_code": None},
    # 2026
    {"date": "2026-01-01", "name": "Año Nuevo", "source": "national", "region_code": None},
    {"date": "2026-01-06", "name": "Epifanía del Señor", "source": "national", "region_code": None},
    {"date": "2026-04-03", "name": "Viernes Santo", "source": "national", "region_code": None},
    {"date": "2026-05-01", "name": "Fiesta del Trabajo", "source": "national", "region_code": None},
    {"date": "2026-08-15", "name": "Asunción de la Virgen", "source": "national", "region_code": None},
    {"date": "2026-10-12", "name": "Fiesta Nacional de España", "source": "national", "region_code": None},
    {"date": "2026-12-08", "name": "Inmaculada Concepción", "source": "national", "region_code": None},
    {"date": "2026-12-25", "name": "Natividad del Señor", "source": "national", "region_code": None},
]


# ---------------------------------------------------------------------------
# Regional holidays. Keyed by ISO 3166-2 region code.
# ---------------------------------------------------------------------------
REGIONAL: dict[str, list[dict]] = {
    "ES-MD": [  # Madrid
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-MD"},
        {"date": "2025-05-02", "name": "Día de la Comunidad de Madrid", "source": "regional", "region_code": "ES-MD"},
        {"date": "2025-07-25", "name": "Santiago Apóstol", "source": "regional", "region_code": "ES-MD"},
        {"date": "2025-11-10", "name": "Lunes siguiente a la Almudena", "source": "regional", "region_code": "ES-MD"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-MD"},
        {"date": "2026-05-02", "name": "Día de la Comunidad de Madrid", "source": "regional", "region_code": "ES-MD"},
        {"date": "2026-11-09", "name": "Almudena (trasladada)", "source": "regional", "region_code": "ES-MD"},
    ],
    "ES-CT": [  # Cataluña
        # 2025
        {"date": "2025-04-21", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-CT"},
        {"date": "2025-06-24", "name": "San Juan", "source": "regional", "region_code": "ES-CT"},
        {"date": "2025-09-11", "name": "Diada Nacional de Cataluña", "source": "regional", "region_code": "ES-CT"},
        {"date": "2025-12-26", "name": "San Esteban", "source": "regional", "region_code": "ES-CT"},
        # 2026
        {"date": "2026-04-06", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-CT"},
        {"date": "2026-06-24", "name": "San Juan", "source": "regional", "region_code": "ES-CT"},
        {"date": "2026-09-11", "name": "Diada Nacional de Cataluña", "source": "regional", "region_code": "ES-CT"},
        {"date": "2026-12-26", "name": "San Esteban", "source": "regional", "region_code": "ES-CT"},
    ],
    "ES-VC": [  # Comunidad Valenciana
        # 2025
        {"date": "2025-03-19", "name": "San José", "source": "regional", "region_code": "ES-VC"},
        {"date": "2025-04-21", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-VC"},
        {"date": "2025-06-24", "name": "San Juan", "source": "regional", "region_code": "ES-VC"},
        {"date": "2025-10-09", "name": "Día de la Comunidad Valenciana", "source": "regional", "region_code": "ES-VC"},
        # 2026
        {"date": "2026-03-19", "name": "San José", "source": "regional", "region_code": "ES-VC"},
        {"date": "2026-04-06", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-VC"},
        {"date": "2026-10-09", "name": "Día de la Comunidad Valenciana", "source": "regional", "region_code": "ES-VC"},
    ],
    "ES-AN": [  # Andalucía
        # 2025
        {"date": "2025-02-28", "name": "Día de Andalucía", "source": "regional", "region_code": "ES-AN"},
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-AN"},
        # 2026
        {"date": "2026-02-27", "name": "Día de Andalucía (trasladado)", "source": "regional", "region_code": "ES-AN"},
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-AN"},
    ],
    # TODO: ES-AS (Asturias), ES-CB (Cantabria), ES-CL (Castilla y León),
    # ES-CM (Castilla-La Mancha), ES-CN (Canarias), ES-EX (Extremadura),
    # ES-GA (Galicia), ES-IB (Baleares), ES-LO (La Rioja), ES-MC (Murcia),
    # ES-NC (Navarra), ES-PV (País Vasco), ES-AR (Aragón). Admin can add via
    # the custom-holiday endpoint until we extend the catalog.
}


# ISO 3166-2 region codes Spain uses, plus a "no region" marker.
SPANISH_REGIONS: list[tuple[str, str]] = [
    ("ES-AN", "Andalucía"),
    ("ES-AR", "Aragón"),
    ("ES-AS", "Asturias"),
    ("ES-CB", "Cantabria"),
    ("ES-CE", "Ceuta"),
    ("ES-CL", "Castilla y León"),
    ("ES-CM", "Castilla-La Mancha"),
    ("ES-CN", "Canarias"),
    ("ES-CT", "Cataluña"),
    ("ES-EX", "Extremadura"),
    ("ES-GA", "Galicia"),
    ("ES-IB", "Islas Baleares"),
    ("ES-LO", "La Rioja"),
    ("ES-MC", "Murcia"),
    ("ES-MD", "Madrid"),
    ("ES-ML", "Melilla"),
    ("ES-NC", "Navarra"),
    ("ES-PV", "País Vasco"),
    ("ES-VC", "Comunidad Valenciana"),
]


def lookup(country_code: str, region_code: str | None, year: int) -> list[dict]:
    """Return the hardcoded holidays for (country, region, year). Unknown
    country/region returns []. National holidays are always included when
    country matches; regional are added on top when region_code is set."""
    if country_code.upper() != "ES":
        return []
    out: list[dict] = []
    for h in NATIONAL:
        if h["date"].startswith(f"{year}-"):
            out.append(h)
    if region_code:
        for h in REGIONAL.get(region_code.upper(), []):
            if h["date"].startswith(f"{year}-"):
                out.append(h)
    return out
