"""CNH autonomous-community label → ISO 3166-2 region code mapping.

The CNH (Catálogo Nacional de Hospitales) seeds hospitals.autonomous_community
with the Spanish gov display string — variants like "C. Foral de Navarra",
"Cataluña", "Comunitat Valenciana", "Principado de Asturias". The holiday
import API and the rest of Trivu speak ISO 3166-2 ("ES-NC", "ES-CT", …).

This module bridges the two so signup can implicitly derive the region
from the picked hospital instead of forcing the user to pick it again
on the onboarding wizard.

If a CNH variant slips through that isn't in the map, the function
returns None — the user can still set the region manually from
/admin/holidays. Add the variant here when that happens.
"""

from __future__ import annotations


# Normalised (lowercase + accent-stripped + collapsed whitespace) form
# → ISO 3166-2 code. Covers the variants observed in the CNH CSV
# (`api/data/cnh_2025_directorio.csv`) plus common bilingual / short
# forms that the gov uses interchangeably.
_CNH_AAC_MAP: dict[str, str] = {
    # Andalucía
    "andalucia": "ES-AN",
    # Aragón
    "aragon": "ES-AR",
    # Asturias
    "asturias": "ES-AS",
    "principado de asturias": "ES-AS",
    # Baleares
    "baleares": "ES-IB",
    "islas baleares": "ES-IB",
    "illes balears": "ES-IB",
    # Canarias
    "canarias": "ES-CN",
    # Cantabria
    "cantabria": "ES-CB",
    # Castilla y León
    "castilla y leon": "ES-CL",
    # Castilla-La Mancha
    "castilla-la mancha": "ES-CM",
    "castilla la mancha": "ES-CM",
    # Cataluña
    "cataluna": "ES-CT",
    "catalunya": "ES-CT",
    # Ceuta
    "ceuta": "ES-CE",
    "ciudad de ceuta": "ES-CE",
    # Comunitat Valenciana
    "comunitat valenciana": "ES-VC",
    "comunidad valenciana": "ES-VC",
    "c. valenciana": "ES-VC",
    # Extremadura
    "extremadura": "ES-EX",
    # Galicia
    "galicia": "ES-GA",
    # La Rioja
    "la rioja": "ES-RI",
    "rioja": "ES-RI",
    # Madrid
    "madrid": "ES-MD",
    "comunidad de madrid": "ES-MD",
    "c. de madrid": "ES-MD",
    # Melilla
    "melilla": "ES-ML",
    "ciudad de melilla": "ES-ML",
    # Murcia
    "murcia": "ES-MC",
    "region de murcia": "ES-MC",
    # Navarra
    "navarra": "ES-NC",
    "c. foral de navarra": "ES-NC",
    "comunidad foral de navarra": "ES-NC",
    # País Vasco
    "pais vasco": "ES-PV",
    "euskadi": "ES-PV",
}


# Same Spanish-diacritic translation we use in public_catalog.py for the
# hospital search — unaccent isn't installed in our Postgres image and
# we apply the same hand-rolled map at the Python layer here.
_ACCENT_MAP = str.maketrans(
    "áéíóúàèìòùâêîôûäëïöüñç",
    "aeiouaeiouaeiouaeioonc",
)


def cnh_aac_to_iso(aac: str | None) -> str | None:
    """Map a CNH autonomous_community display label to an ISO 3166-2
    region code. Returns None for empty/unknown input.

    >>> cnh_aac_to_iso("C. Foral de Navarra")
    'ES-NC'
    >>> cnh_aac_to_iso("Cataluña")
    'ES-CT'
    >>> cnh_aac_to_iso("Comunitat Valenciana")
    'ES-VC'
    >>> cnh_aac_to_iso(None)
    >>> cnh_aac_to_iso("Marte")
    """
    if not aac:
        return None
    s = aac.strip().lower().translate(_ACCENT_MAP)
    # Collapse internal whitespace so "  c.   foral de navarra " matches.
    s = " ".join(s.split())
    return _CNH_AAC_MAP.get(s)
