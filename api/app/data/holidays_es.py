"""Static catalog of Spanish holidays for 2025 and 2026.

Sources (authoritative):
- 2025: BOE-A-2024-21316 — Resolución de 15 de octubre de 2024, Dirección
  General de Trabajo (https://www.boe.es/diario_boe/txt.php?id=BOE-A-2024-21316)
- 2026: BOE-A-2025-21667 — Resolución de 17 de octubre de 2025, Dirección
  General de Trabajo (https://www.boe.es/diario_boe/txt.php?id=BOE-A-2025-21667)

We hardcode the dates rather than computing them so admins get the same
answer every time without depending on third-party APIs. When BOE shifts a
holiday because the canonical date falls on a Sunday (e.g. Día de Andalucía
moved to Feb 27 in 2026 because Feb 28 is a Sunday), we record the shifted
date as it appears in the official table.

Coverage:
- National (region_code=None): full coverage 2025 + 2026.
- Regional: all 17 autonomous communities + Ceuta + Melilla.

Notes on "regional" entries:
- The BOE table for each CCAA lists a mixture of (a) the region's own
  autonomy day, (b) moved national holidays the region elevates, and
  (c) Catholic/civic days like Lunes de Pascua, Jueves Santo, Corpus,
  Santiago, San José, San Juan, San Esteban, etc. that are not nationally
  observed but the region elects to keep. We include all of these as
  "regional" so the schedule generator skips them in those tenants.
- Some CCAA additionally have province- or island-specific local holidays
  (Canarias islands, Galicia provinces, Cataluña Arán). Those are NOT in
  this catalog — admins add them via the custom-holiday endpoint.

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
# Source: BOE-A-2024-21316 (2025) and BOE-A-2025-21667 (2026).
# ---------------------------------------------------------------------------
REGIONAL: dict[str, list[dict]] = {
    "ES-AN": [  # Andalucía
        # 2025
        {"date": "2025-02-28", "name": "Día de Andalucía", "source": "regional", "region_code": "ES-AN"},
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-AN"},
        # 2026 — Día de Andalucía falls on Sunday 2026-02-28, BOE moves it to Friday 2026-02-27
        {"date": "2026-02-27", "name": "Día de Andalucía (trasladado)", "source": "regional", "region_code": "ES-AN"},
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-AN"},
        {"date": "2026-11-02", "name": "Lunes siguiente a Todos los Santos", "source": "regional", "region_code": "ES-AN"},
    ],
    "ES-AR": [  # Aragón
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-AR"},
        {"date": "2025-04-23", "name": "San Jorge / Día de Aragón", "source": "regional", "region_code": "ES-AR"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-AR"},
        {"date": "2026-04-23", "name": "San Jorge / Día de Aragón", "source": "regional", "region_code": "ES-AR"},
        {"date": "2026-11-02", "name": "Lunes siguiente a Todos los Santos", "source": "regional", "region_code": "ES-AR"},
    ],
    "ES-AS": [  # Asturias
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-AS"},
        {"date": "2025-09-08", "name": "Día de Asturias", "source": "regional", "region_code": "ES-AS"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-AS"},
        {"date": "2026-09-08", "name": "Día de Asturias", "source": "regional", "region_code": "ES-AS"},
        {"date": "2026-11-02", "name": "Lunes siguiente a Todos los Santos", "source": "regional", "region_code": "ES-AS"},
        {"date": "2026-12-07", "name": "Lunes siguiente a la Constitución", "source": "regional", "region_code": "ES-AS"},
    ],
    "ES-CB": [  # Cantabria
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CB"},
        {"date": "2025-07-28", "name": "Día de las Instituciones de Cantabria", "source": "regional", "region_code": "ES-CB"},
        {"date": "2025-09-15", "name": "Día de La Bien Aparecida", "source": "regional", "region_code": "ES-CB"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CB"},
        {"date": "2026-07-28", "name": "Día de las Instituciones de Cantabria", "source": "regional", "region_code": "ES-CB"},
        {"date": "2026-09-15", "name": "Día de La Bien Aparecida", "source": "regional", "region_code": "ES-CB"},
        {"date": "2026-12-07", "name": "Lunes siguiente a la Constitución", "source": "regional", "region_code": "ES-CB"},
    ],
    "ES-CE": [  # Ceuta
        # 2025
        {"date": "2025-03-31", "name": "Fiesta del Eid al-Fitr", "source": "regional", "region_code": "ES-CE"},
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CE"},
        {"date": "2025-08-05", "name": "Nuestra Señora de África", "source": "regional", "region_code": "ES-CE"},
        # 2026
        {"date": "2026-03-20", "name": "Fiesta del Eid al-Fitr", "source": "regional", "region_code": "ES-CE"},
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CE"},
        {"date": "2026-05-27", "name": "Fiesta del Sacrificio (Eid al-Adha)", "source": "regional", "region_code": "ES-CE"},
        {"date": "2026-09-02", "name": "Día de Ceuta", "source": "regional", "region_code": "ES-CE"},
    ],
    "ES-CL": [  # Castilla y León
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CL"},
        {"date": "2025-04-23", "name": "Fiesta de Castilla y León", "source": "regional", "region_code": "ES-CL"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CL"},
        {"date": "2026-04-23", "name": "Fiesta de Castilla y León", "source": "regional", "region_code": "ES-CL"},
        {"date": "2026-11-02", "name": "Lunes siguiente a Todos los Santos", "source": "regional", "region_code": "ES-CL"},
        {"date": "2026-12-07", "name": "Lunes siguiente a la Constitución", "source": "regional", "region_code": "ES-CL"},
    ],
    "ES-CM": [  # Castilla-La Mancha
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CM"},
        {"date": "2025-05-31", "name": "Día de Castilla-La Mancha", "source": "regional", "region_code": "ES-CM"},
        {"date": "2025-06-19", "name": "Corpus Christi", "source": "regional", "region_code": "ES-CM"},
        # 2026 — Día de Castilla-La Mancha (May 31) falls on Sunday and is not transferred per BOE
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CM"},
        {"date": "2026-04-06", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-CM"},
        {"date": "2026-06-04", "name": "Corpus Christi", "source": "regional", "region_code": "ES-CM"},
        {"date": "2026-11-02", "name": "Lunes siguiente a Todos los Santos", "source": "regional", "region_code": "ES-CM"},
    ],
    "ES-CN": [  # Canarias
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CN"},
        {"date": "2025-05-30", "name": "Día de Canarias", "source": "regional", "region_code": "ES-CN"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-CN"},
        {"date": "2026-05-30", "name": "Día de Canarias", "source": "regional", "region_code": "ES-CN"},
        # Note: each Canary island has additional local holidays (Decree 61/2025 for 2026)
        # — admins add those via the custom-holiday endpoint per their tenant location.
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
        # Note: in the Arán territory, Dec 26 is replaced by June 17 (Fiesta de Arán) per
        # Order EMT/66/2025. Admins in Arán adjust via custom-holiday endpoint.
    ],
    "ES-EX": [  # Extremadura
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-EX"},
        {"date": "2025-09-08", "name": "Día de Extremadura", "source": "regional", "region_code": "ES-EX"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-EX"},
        {"date": "2026-09-08", "name": "Día de Extremadura", "source": "regional", "region_code": "ES-EX"},
        {"date": "2026-11-02", "name": "Lunes siguiente a Todos los Santos", "source": "regional", "region_code": "ES-EX"},
        {"date": "2026-12-07", "name": "Lunes siguiente a la Constitución", "source": "regional", "region_code": "ES-EX"},
    ],
    "ES-GA": [  # Galicia
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-GA"},
        {"date": "2025-05-17", "name": "Día das Letras Galegas", "source": "regional", "region_code": "ES-GA"},
        {"date": "2025-07-25", "name": "Día Nacional de Galicia (Santiago Apóstol)", "source": "regional", "region_code": "ES-GA"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-GA"},
        {"date": "2026-05-17", "name": "Día das Letras Galegas", "source": "regional", "region_code": "ES-GA"},
        {"date": "2026-07-25", "name": "Día Nacional de Galicia (Santiago Apóstol)", "source": "regional", "region_code": "ES-GA"},
    ],
    "ES-IB": [  # Islas Baleares
        # 2025
        {"date": "2025-03-01", "name": "Día de les Illes Balears", "source": "regional", "region_code": "ES-IB"},
        {"date": "2025-04-21", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-IB"},
        {"date": "2025-12-26", "name": "San Esteban", "source": "regional", "region_code": "ES-IB"},
        # 2026 — Día de les Illes Balears (Mar 1) falls on Sunday, BOE moves it to Mar 2
        {"date": "2026-03-02", "name": "Día de les Illes Balears (trasladado)", "source": "regional", "region_code": "ES-IB"},
        {"date": "2026-04-06", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-IB"},
        {"date": "2026-12-26", "name": "San Esteban", "source": "regional", "region_code": "ES-IB"},
    ],
    "ES-LO": [  # La Rioja
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-LO"},
        {"date": "2025-06-09", "name": "Día de La Rioja", "source": "regional", "region_code": "ES-LO"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-LO"},
        {"date": "2026-06-09", "name": "Día de La Rioja", "source": "regional", "region_code": "ES-LO"},
        {"date": "2026-11-02", "name": "Lunes siguiente a Todos los Santos", "source": "regional", "region_code": "ES-LO"},
        {"date": "2026-12-07", "name": "Lunes siguiente a la Constitución", "source": "regional", "region_code": "ES-LO"},
    ],
    "ES-MC": [  # Murcia
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-MC"},
        {"date": "2025-06-09", "name": "Día de la Región de Murcia", "source": "regional", "region_code": "ES-MC"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-MC"},
        {"date": "2026-06-09", "name": "Día de la Región de Murcia", "source": "regional", "region_code": "ES-MC"},
        {"date": "2026-11-02", "name": "Lunes siguiente a Todos los Santos", "source": "regional", "region_code": "ES-MC"},
    ],
    "ES-MD": [  # Madrid
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-MD"},
        {"date": "2025-05-02", "name": "Día de la Comunidad de Madrid", "source": "regional", "region_code": "ES-MD"},
        {"date": "2025-07-25", "name": "Santiago Apóstol", "source": "regional", "region_code": "ES-MD"},
        {"date": "2025-11-10", "name": "Lunes siguiente a la Almudena", "source": "regional", "region_code": "ES-MD"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-MD"},
        {"date": "2026-05-02", "name": "Día de la Comunidad de Madrid", "source": "regional", "region_code": "ES-MD"},
        {"date": "2026-11-02", "name": "Lunes siguiente a Todos los Santos", "source": "regional", "region_code": "ES-MD"},
        {"date": "2026-11-09", "name": "Almudena (trasladada)", "source": "regional", "region_code": "ES-MD"},
        {"date": "2026-12-07", "name": "Lunes siguiente a la Constitución", "source": "regional", "region_code": "ES-MD"},
    ],
    "ES-ML": [  # Melilla
        # 2025
        {"date": "2025-03-31", "name": "Fiesta del Eid al-Fitr", "source": "regional", "region_code": "ES-ML"},
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-ML"},
        {"date": "2025-06-06", "name": "Fiesta del Sacrificio (Eid al-Adha)", "source": "regional", "region_code": "ES-ML"},
        # 2026
        {"date": "2026-03-20", "name": "Fiesta del Eid al-Fitr", "source": "regional", "region_code": "ES-ML"},
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-ML"},
        {"date": "2026-05-27", "name": "Fiesta del Sacrificio (Eid al-Adha)", "source": "regional", "region_code": "ES-ML"},
        {"date": "2026-08-05", "name": "Nuestra Señora de África", "source": "regional", "region_code": "ES-ML"},
    ],
    "ES-NC": [  # Navarra
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-NC"},
        {"date": "2025-04-21", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-NC"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-NC"},
        {"date": "2026-04-06", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-NC"},
        {"date": "2026-12-07", "name": "Lunes siguiente a la Constitución", "source": "regional", "region_code": "ES-NC"},
    ],
    "ES-PV": [  # País Vasco
        # 2025
        {"date": "2025-04-17", "name": "Jueves Santo", "source": "regional", "region_code": "ES-PV"},
        {"date": "2025-04-21", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-PV"},
        # 2026
        {"date": "2026-04-02", "name": "Jueves Santo", "source": "regional", "region_code": "ES-PV"},
        {"date": "2026-04-06", "name": "Lunes de Pascua", "source": "regional", "region_code": "ES-PV"},
        {"date": "2026-07-25", "name": "Santiago Apóstol", "source": "regional", "region_code": "ES-PV"},
        {"date": "2026-12-07", "name": "Lunes siguiente a la Constitución", "source": "regional", "region_code": "ES-PV"},
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
