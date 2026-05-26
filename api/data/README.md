# api/data/

Static reference data shipped with the API.

## `cnh_2025_directorio.csv`

The hospitals directory from the **Catálogo Nacional de Hospitales 2025**
(CNH 2025), published by the Spanish Ministerio de Sanidad. Source:

  https://www.sanidad.gob.es/estadEstudios/estadisticas/sisInfSanSNS/ofertaRecursos/hospitales/

Open data, no licensing restrictions on redistribution. The CSV is a
trimmed projection of the `DIRECTORIO DE HOSPITALES` sheet of the
original .xlsx file — only the columns we use for signup-time
hospital selection are kept (one row per active hospital, 848 rows in
the 2025 edition).

Columns:
  - `public_code`            CODCNH — stable 6-digit national hospital id
  - `name`                   "Hospital Universitario y Politécnico La Fe"
  - `address`                postal address
  - `city`                   municipality
  - `province`               province name (e.g. "Valencia")
  - `autonomous_community`   CCAA name (e.g. "Comunidad Valenciana")
  - `postal_code`            5-digit postal code
  - `hospital_class`         classification label (general, mental
                             health, day hospital, etc.)
  - `ownership`              functional dependency (regional health
                             service, private, military, etc.)
  - `active`                 'N' = pre-existing, 'S' = newly added in
                             the 2025 edition. All rows are currently
                             active — the BAJAS sheet (removed) is
                             not included.

### Refresh

The CNH is updated annually. To pull a newer edition:

```sh
curl -fsSL -o /tmp/cnh.xlsx \
  https://www.sanidad.gob.es/estadEstudios/estadisticas/sisInfSanSNS/ofertaRecursos/hospitales/docs/CNH_<YEAR>.xlsx

# Then convert the DIRECTORIO DE HOSPITALES sheet to CSV using the
# same column projection — see the original conversion in the
# commit that introduced this file.
```

After refreshing, re-run `scripts/seed_hospitals_cnh.py` against
prod: existing rows are upserted on `public_code`, so name /
address / category changes propagate. Hospitals dropped from the
catalog (BAJAS) need manual cleanup; we don't auto-deactivate to
avoid breaking the FK from `tenants.hospital_id`.
