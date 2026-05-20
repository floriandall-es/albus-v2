// ISO 3166-2 codes for Spain's autonomous communities and
// autonomous cities. Used by the onboarding region picker so the
// holidays import can pull regional festivos along with the
// national set.
//
// Order: alphabetical by Spanish display name. Keep this list
// flat — the picker turns it into a <Select> directly.

export type RegionOption = { code: string; label: string };

export const ES_REGIONS: RegionOption[] = [
  { code: "ES-AN", label: "Andalucía" },
  { code: "ES-AR", label: "Aragón" },
  { code: "ES-AS", label: "Asturias" },
  { code: "ES-IB", label: "Baleares" },
  { code: "ES-CN", label: "Canarias" },
  { code: "ES-CB", label: "Cantabria" },
  { code: "ES-CL", label: "Castilla y León" },
  { code: "ES-CM", label: "Castilla-La Mancha" },
  { code: "ES-CT", label: "Cataluña" },
  { code: "ES-CE", label: "Ceuta" },
  { code: "ES-VC", label: "Comunidad Valenciana" },
  { code: "ES-EX", label: "Extremadura" },
  { code: "ES-GA", label: "Galicia" },
  { code: "ES-RI", label: "La Rioja" },
  { code: "ES-MD", label: "Madrid" },
  { code: "ES-ML", label: "Melilla" },
  { code: "ES-MC", label: "Murcia" },
  { code: "ES-NC", label: "Navarra" },
  { code: "ES-PV", label: "País Vasco" },
];
