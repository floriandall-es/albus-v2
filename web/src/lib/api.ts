export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

// Turn a relative avatar_url ("/api/avatars/12-abc.jpg") into the
// browser-loadable absolute URL. Caller-side helper so every <img>
// usage doesn't repeat the prefix glue.
export function avatarSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${API_BASE_URL}${url}`;
}

const TOKEN_KEY = "albus_access_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  // Wipe any short-lived auth state too (pre-auth tokens during the
  // tenant picker, tenant stash from a previous session, etc.). Without
  // this, the next login can hit stale entries.
  window.sessionStorage.clear();
}

export type PresetKind = "quirurgico" | "medico" | "otro";

export type Tenant = {
  id: number;
  slug: string;
  name: string;
  country: string | null;
  locale: string | null;
  country_code: string | null;
  region_code: string | null;
  created_at: string;
  onboarding_completed_at: string | null;
  /** Onboarding template chosen on the new first wizard step.
   * Null on tenants created before the preset selector shipped. */
  preset_kind: PresetKind | null;
  /** Yes/No answer the admin gave at signup to "¿Vas a usar
   * sub-equipos?". Drives whether /admin Inicio surfaces a
   * sub-equipos setup card. False by default. */
  has_subteams: boolean;
  /** Per-area "I'm done configuring" timestamps. Null = pending
   * (Inicio shows the card, subpage shows the first-visit banner);
   * non-null = admin marked it done. Toggled via
   * POST /api/tenants/me/setup. */
  setup_activities_completed_at: string | null;
  setup_rules_completed_at: string | null;
  setup_team_completed_at: string | null;
  setup_subteams_completed_at: string | null;
};

export type SetupArea = "activities" | "rules" | "team" | "subteams";

export type HolidaySource = "national" | "regional" | "custom";
export type Holiday = {
  id: number;
  tenant_id: number;
  date: string;
  name: string;
  source: HolidaySource;
  region_code: string | null;
  created_at: string;
};

export type HolidayImportResult = { inserted: number; skipped: number };

export type AvailabilityBlockType =
  | "vacation"
  | "sick"
  | "training"
  | "personal"
  | "other";

export type AvailabilityBlockStatus = "pending" | "approved" | "denied";

export type AvailabilityBlock = {
  id: number;
  tenant_id: number;
  person_id: number;
  person_name: string;
  start_date: string;
  end_date: string;
  block_type: AvailabilityBlockType;
  notes: string | null;
  status: AvailabilityBlockStatus;
  requested_by_membership_id: number | null;
  reviewed_by_membership_id: number | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
};

// Aggregated stats — one row per (person, slot, team_role, year-month)
// for the admin charts page. team_role_id/label are null for single /
// multiple_same slots, in which case each slot renders as one chart;
// team_composition slots have a row per role and render one chart per
// (slot, role) pair.
export type StatsRow = {
  person_id: number;
  person_name: string;
  person_avatar_url: string | null;
  slot_id: number;
  slot_name: string;
  slot_color: string | null;
  team_role_id: number | null;
  team_role_label: string | null;
  year_month: string; // "YYYY-MM"
  count: number;
  weekend_or_holiday_count: number;
};

export type StatsResponse = {
  from_date: string;
  to_date: string;
  rows: StatsRow[];
};

// Sanitized public read-only absence row used by the planning grid's
// Libre row. Backed by /api/availability/team-absences.
export type TeamAbsence = {
  person_id: number;
  person_name: string;
  person_first_name: string | null;
  person_last_name: string | null;
  person_avatar_url: string | null;
  start_date: string;
  end_date: string;
  block_type: AvailabilityBlockType;
};

export type ScheduleStatus = "draft" | "published" | "archived";
export type SolverUsed = "cpsat" | "greedy";

export type Schedule = {
  id: number;
  tenant_id: number;
  period: string;
  status: ScheduleStatus;
  generated_at: string | null;
  published_at: string | null;
  reopened_at: string | null;
  solver_used: SolverUsed | null;
  /** Ids of groups whose lead has published the group's plan for
   * this schedule. Empty when no group has published. Drives the
   * Publicar/Despublicar button on /lead/planificacion and the
   * member-visibility filter in /me/turnos. */
  published_group_ids: number[];
  created_at: string;
};

export type Assignment = {
  id: number;
  schedule_id: number;
  slot_id: number;
  slot_name: string;
  slot_color: string | null;
  /** Mirror of Slot.position, set on the server-side serializer
   * so the planning grid can sort rows without a second roundtrip. */
  slot_position: number;
  /** Set when the slot belongs to a sub-team group. Lets the
   * planning grid render a "Sub-equipo: Foo" pill on the row so
   * admins/members can see at a glance which rows are managed
   * by a group lead. */
  slot_group_id: number | null;
  slot_group_name: string | null;
  /** Slot hours (HH:MM:SS). Null on on-call / all-day slots. Used by
   * the personal "Mis turnos" list to show "08:00 – 15:00" inline. */
  slot_start_time: string | null;
  slot_end_time: string | null;
  date: string;
  person_id: number | null;
  person_name: string | null;
  person_first_name: string | null;
  person_last_name: string | null;
  person_avatar_url: string | null;
  team_role_id: number | null;
  team_role_label: string | null;
  notes: string | null;
  locked_at: string | null;
  locked_by_membership_id: number | null;
  swap_offer_id: number | null;
};

export type EligiblePerson = {
  person_id: number;
  person_name: string;
};

export type ScheduleDetail = Schedule & {
  assignments: Assignment[];
};

export type Person = {
  id: number;
  email: string;
  /** Canonical display string. Always populated on the server; the
   * split fields below are nullable on rows from before the split. */
  name: string;
  first_name: string | null;
  last_name: string | null;
  locale: string | null;
  avatar_url: string | null;
  /** ISO timestamp the user clicked the signup verification link.
   * Null = not yet verified; UI shows the "verifica tu correo"
   * banner with a resend button until cleared. */
  email_verified_at: string | null;
  created_at: string;
};

/** Friendly first-name for salutations ("Hola, Gabriel"). Falls back
 * to the first whitespace-separated token of `name` for rows that
 * haven't been re-saved with the split fields. */
export function personFirstName(p: {
  name: string;
  first_name?: string | null;
}): string {
  if (p.first_name && p.first_name.trim()) return p.first_name.trim();
  const head = p.name.trim().split(/\s+/)[0];
  return head ?? p.name;
}

/** Last name(s) for tight columns (planning grid, BalanceStats). Falls
 * back to everything-after-the-first-word of `name`; if `name` is a
 * single word, returns it (typical legacy "last name only" tenants). */
export function personLastName(p: {
  name: string;
  last_name?: string | null;
}): string {
  if (p.last_name && p.last_name.trim()) return p.last_name.trim();
  const parts = p.name.trim().split(/\s+/);
  if (parts.length <= 1) return p.name;
  return parts.slice(1).join(" ");
}

// ---- Shift swaps ----------------------------------------------------------
export type SwapOfferStatus = "open" | "fulfilled" | "cancelled";
export type SwapResponseKind = "cover" | "swap";
export type SwapResponseStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "withdrawn";

export type SwapAssignmentSummary = {
  id: number;
  schedule_id: number;
  date: string;
  slot_id: number;
  slot_name: string;
  person_id: number | null;
  person_name: string | null;
  team_role_label: string | null;
};

export type SwapResponse = {
  id: number;
  offer_id: number;
  responder_membership_id: number;
  responder_person_id: number;
  responder_person_name: string;
  kind: SwapResponseKind;
  swap_assignment: SwapAssignmentSummary | null;
  status: SwapResponseStatus;
  notes: string | null;
  created_at: string;
  decided_at: string | null;
};

export type SwapOffer = {
  id: number;
  tenant_id: number;
  assignment: SwapAssignmentSummary;
  requested_by_membership_id: number;
  requested_by_person_id: number;
  requested_by_person_name: string;
  status: SwapOfferStatus;
  notes: string | null;
  created_at: string;
  closed_at: string | null;
  responses: SwapResponse[];
};

export type Membership = {
  id: number;
  tenant_id: number;
  person_id: number;
  roles: string[];
  category_id: number | null;
  fte_pct: number;
  /** ISO timestamp; non-null = membership is paused (solver
   * skips them, admin UI shows "Desactivado"). Null = active. */
  disabled_at: string | null;
  /** Set when the person belongs to a sub-team group. Used by
   * /me/turnos to filter the schedule list to the right context
   * (a residente sees the residentes' plan, an Adjunto sees the
   * main team's). */
  group_id: number | null;
  created_at: string;
};

export type Department = {
  id: number;
  tenant_id: number;
  name: string;
  created_at: string;
};

export type RoleType = {
  id: number;
  tenant_id: number;
  department_id: number | null;
  name: string;
  color: string | null;
  defaults_jsonb: Record<string, unknown>;
  created_at: string;
};

export type Category = {
  id: number;
  tenant_id: number;
  name: string;
  level: number | null;
  description: string | null;
  created_at: string;
};

export type Group = {
  id: number;
  tenant_id: number;
  name: string;
  /** Membership id of the designated lead. Null when no lead set. */
  lead_membership_id: number | null;
  /** Display name of the lead (joined Person.name). */
  lead_name: string | null;
  member_count: number;
  slot_count: number;
  created_at: string;
};

export type MeetingKind = "regular" | "ad_hoc";

export type MeetingAudience = {
  include_main_team: boolean;
  group_ids: number[];
  person_ids: number[];
  /** Aligned with `group_ids` by index. */
  group_names: string[];
  /** Aligned with `person_ids` by index. */
  person_names: string[];
};

export type Meeting = {
  id: number;
  tenant_id: number;
  kind: MeetingKind;
  title: string;
  description: string | null;
  location: string | null;
  /** Set for ad-hoc only. */
  date: string | null;
  /** 0=Monday..6=Sunday. Set for regular only. */
  weekday: number | null;
  /** "HH:MM:SS" */
  start_time: string;
  end_time: string;
  organizer_membership_id: number | null;
  organizer_name: string | null;
  audience: MeetingAudience;
  created_at: string;
};

export type MeetingInstance = {
  meeting_id: number;
  kind: MeetingKind;
  title: string;
  description: string | null;
  location: string | null;
  /** ISO date YYYY-MM-DD. */
  date: string;
  start_time: string;
  end_time: string;
  organizer_name: string | null;
  can_edit: boolean;
};

export type Incident = {
  id: number;
  tenant_id: number;
  occurred_at: string; // ISO date YYYY-MM-DD
  title: string;
  body: string | null;
  /** Display name of the admin who logged it; null if the
   * membership was deleted after creation. */
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export type DaysApplied = "all" | "weekdays" | "weekends_holidays" | "custom";
export type StaffingMode = "single" | "multiple_same" | "team_composition";

export type SlotTeamRole = {
  id: number;
  role_label: string;
  headcount: number;
  category_ids: number[];
};

export type SlotRuleStrategy = "solver" | "fixed_weekly" | "rotation" | "manual";

export type SlotRuleWeeklyPin = {
  id: number;
  weekday: number;
  person_id: number;
};

export type SlotRuleRotationBlock = {
  id: number;
  position: number;
  days_bitmap: number;
};

export type SlotRuleRotationMember = {
  id: number;
  position: number;
  person_id: number;
};

export type SlotRule = {
  id: number;
  tenant_id: number;
  position: number;
  days_bitmap: number;
  strategy: SlotRuleStrategy;
  anchor_date: string | null;
  weekly_pins: SlotRuleWeeklyPin[];
  rotation_blocks: SlotRuleRotationBlock[];
  rotation_members: SlotRuleRotationMember[];
};

export type SlotRuleInput = {
  days_bitmap: number;
  strategy: SlotRuleStrategy;
  anchor_date?: string | null;
  weekly_pins?: { weekday: number; person_id: number }[];
  rotation_blocks?: { position: number; days_bitmap: number }[];
  rotation_members?: { position: number; person_id: number }[];
};

export type Slot = {
  id: number;
  tenant_id: number;
  department_id: number | null;
  /** Sub-team that owns this activity. Null = main team. */
  group_id: number | null;
  name: string;
  start_time: string | null;
  end_time: string | null;
  days_applied: DaysApplied;
  custom_days_bitmap: number | null;
  staffing_mode: StaffingMode;
  headcount: number;
  post_slot_rest: boolean;
  counts_for_equity: boolean;
  guardia_type: string | null;
  color: string | null;
  /** Admin-controlled display order. Lower = earlier in the
   * planning grid and the slot list. */
  position: number;
  crosses_midnight: boolean;
  team_roles: SlotTeamRole[];
  /** Person ids in the slot's allow-list. Empty = "Todo el equipo"
   * (no restriction). Non-empty = ONLY these persons can be
   * assigned to this slot. Replaces the pre-0030 pool_id +
   * skills_required mechanisms. */
  allowed_person_ids: number[];
  rules: SlotRule[];
  created_at: string;
};

export type SlotInput = {
  name: string;
  department_id?: number | null;
  group_id?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  days_applied: DaysApplied;
  custom_days_bitmap?: number | null;
  staffing_mode: StaffingMode;
  headcount: number;
  /** Deprecated. Kept optional so older callers don't break; the
   * UI no longer exposes it and new slots leave it unset (server
   * defaults to false). Post-shift rest constraints are admin-
   * configurable via rules. */
  post_slot_rest?: boolean;
  counts_for_equity: boolean;
  guardia_type?: string | null;
  color?: string | null;
  team_roles: { role_label: string; headcount: number; category_ids: number[] }[];
  /** Empty = no restriction; non-empty = only these persons may be
   * assigned to this slot. */
  allowed_person_ids: number[];
};

export type TeamMember = {
  id: number;
  tenant_id: number;
  person_id: number;
  person_name: string;
  person_email: string;
  person_locale: string | null;
  person_avatar_url: string | null;
  roles: string[];
  category_id: number | null;
  category_name: string | null;
  fte_pct: number;
  /** ISO timestamp. Non-null = membership is paused; solver
   * skips them and admin UI shows "Desactivado". Null = active. */
  disabled_at: string | null;
  /** Sub-team this person belongs to. Null = main team. */
  group_id: number | null;
  group_name: string | null;
  /** True when the admin has invited them but they haven't yet
   * opened the activation link to set a password. The solver
   * schedules pendientes like any other member; this flag just
   * drives the "Pendiente" badge in the admin team list. */
  is_pending: boolean;
  created_at: string;
};

export type TeamMemberUpdate = {
  category_id?: number | null;
  fte_pct?: number;
  roles?: string[];
  /** True = disable now (server stamps disabled_at). False =
   * re-enable. Omit to leave state unchanged. */
  disabled?: boolean;
  /** Inverse view of slot_allowed_persons: the activity ids
   * this person should be authorized on. Server reconciles
   * only restricted slots — unrestricted slots stay untouched. */
  allowed_slot_ids?: number[];
  /** Tenant-admin only: move this member to a different group
   * (or clear with `clear_group: true`). */
  group_id?: number | null;
  clear_group?: boolean;
};

export type TenantSummaryCounts = {
  categories: number;
  slots: number;
};

export type AuthResponse = {
  access_token: string;
  token_type: string;
  tenant: Tenant;
  person: Person;
  memberships: Membership[];
  /** Set when this person is the designated lead of a group in
   * the selected tenant. Drives the post-login redirect (group
   * leads land on /admin instead of /me). */
  lead_group_id: number | null;
};

// Returned by /api/login when the person has 2+ memberships and must pick a
// tenant before getting a real access token. The caller stores the
// pre_auth_token (sessionStorage) and POSTs it back via /login/select-tenant.
export type TenantPickerOption = {
  id: number;
  slug: string;
  name: string;
};

export type TenantSelectionResponse = {
  requires_tenant_selection: true;
  pre_auth_token: string;
  person: { id: number; email: string; name: string };
  available_tenants: TenantPickerOption[];
};

export function isTenantSelectionResponse(
  res: AuthResponse | TenantSelectionResponse,
): res is TenantSelectionResponse {
  return (res as TenantSelectionResponse).requires_tenant_selection === true;
}

export type MeResponse = {
  person: Person;
  current_tenant: Tenant;
  memberships: Membership[];
  role_types: RoleType[];
  departments: Department[];
  counts: TenantSummaryCounts;
  /** Set when this person is the designated lead of a group.
   * Frontend uses it to let leads into the scoped admin UI even
   * though their role is plain "member". Null otherwise. */
  lead_group_id: number | null;
};

// Pydantic v2 error item we expect inside FastAPI's `detail` array for
// 422 validation responses. We only consume a handful of keys — the
// rest is ignored.
type PydanticErrorItem = {
  type?: string;
  loc?: unknown[];
  msg?: string;
  ctx?: Record<string, unknown>;
};

// Map a single Pydantic v2 error item to a human-readable Spanish
// sentence. The fallback (`item.msg`) handles anything we haven't
// special-cased — better to surface SOMETHING legible than the raw
// JSON blob we used to throw.
function formatPydanticError(item: PydanticErrorItem): string {
  const field = Array.isArray(item.loc)
    // FastAPI prefixes locations with "body" / "query" / "path"; the
    // user only cares about the leaf field name (e.g. "new_password").
    ? String(item.loc[item.loc.length - 1] ?? "")
    : "";
  const fieldLabel: Record<string, string> = {
    new_password: "La contraseña",
    current_password: "La contraseña actual",
    password: "La contraseña",
    email: "El email",
    name: "El nombre",
  };
  const subject = fieldLabel[field] ?? "Este campo";

  switch (item.type) {
    case "string_too_short": {
      const min = Number(item.ctx?.min_length ?? 0) || 0;
      return min
        ? `${subject} debe tener al menos ${min} caracteres.`
        : `${subject} es demasiado corto.`;
    }
    case "string_too_long": {
      const max = Number(item.ctx?.max_length ?? 0) || 0;
      return max
        ? `${subject} no puede tener más de ${max} caracteres.`
        : `${subject} es demasiado largo.`;
    }
    case "value_error":
    case "value_error.email":
      return `${subject} no es válido.`;
    case "missing":
      return `${subject} es obligatorio.`;
    default:
      return item.msg || "Datos inválidos.";
  }
}

// Convert the raw `detail` field returned by the API into something
// safe to drop into a UI error label. Strings pass through; arrays of
// Pydantic items (FastAPI 422) are joined; anything else falls back to
// JSON.stringify so we don't accidentally render `[object Object]`.
function formatErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => formatPydanticError(d as PydanticErrorItem));
    return msgs.length ? msgs.join(" ") : fallback;
  }
  if (detail && typeof detail === "object") {
    return JSON.stringify(detail);
  }
  return fallback;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* ignore */
    }
    // 401 on an authenticated request means the access token has
    // expired or been invalidated. Clear it and bounce to /login
    // so the user gets a clean re-auth instead of a stale tab
    // showing cached data while every mutation fails. We only do
    // this in the browser (typeof window) and only when a token
    // was actually sent — public endpoints that 401 (forgot-
    // password edge cases, etc.) don't trigger the redirect.
    if (res.status === 401 && token && typeof window !== "undefined") {
      clearToken();
      const here = window.location.pathname + window.location.search;
      if (!here.startsWith("/login")) {
        window.location.replace("/login");
      }
    }
    throw new Error(formatErrorDetail(detail, res.statusText));
  }
  return (await res.json()) as T;
}

/**
 * Shared "fetch a PDF + trigger browser download" helper.
 * Used by every schedule PDF download (main schedule + each
 * sub-team's). Auth via Bearer header, hence the fetch+blob
 * dance rather than a plain window.open.
 */
async function _downloadPdfFromUrl(
  url: string,
  fallbackFilename: string,
): Promise<void> {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) (headers as Record<string, string>).Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* binary response, no JSON */
    }
    throw new Error(typeof detail === "string" ? detail : "Error generando PDF");
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition");
  const match = cd?.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? fallbackFilename;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export const api = {
  signup: (body: {
    tenant_name: string;
    /** Legacy single-field name. Sprint 18+ clients should send
     * first_name + last_name; server composes `person_name` from
     * the parts. Kept here so older / scripted callers don't break. */
    person_name?: string;
    first_name?: string;
    last_name?: string;
    email: string;
    password: string;
    /** Affirmative ToS + Privacy acceptance. Server rejects with
     * 422 if missing or false. */
    accept_terms: boolean;
    /** Yes/No answer to "¿Vas a usar sub-equipos?". Stored on the
     * tenant; later drives whether /admin Inicio surfaces a
     * sub-equipos setup card. */
    has_subteams: boolean;
  }) => request<AuthResponse>("/api/signup", { method: "POST", body: JSON.stringify(body) }),

  // Login is conditional on how many memberships the person has:
  // - 1 membership → AuthResponse with access_token (existing flow)
  // - 2+ memberships → TenantSelectionResponse; caller must redirect to the
  //   picker page and exchange the pre_auth_token via selectTenant().
  login: (body: { email: string; password: string }) =>
    request<AuthResponse | TenantSelectionResponse>("/api/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  selectTenant: (body: { pre_auth_token: string; tenant_id: number }) =>
    request<AuthResponse>("/api/login/select-tenant", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  me: () => request<MeResponse>("/api/me"),
  updateProfile: (body: {
    /** Legacy single-field name. Sprint 18+ clients should send
     * first_name + last_name instead; the server composes `name`
     * from them. */
    name?: string;
    first_name?: string;
    last_name?: string;
  }) =>
    request<Person>("/api/me/profile", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  changePassword: (body: { current_password: string; new_password: string }) =>
    request<void>("/api/me/password", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Kicks off the email-change flow. The actual swap doesn't
   * happen here — the server emails a confirmation link to the new
   * address. Response includes which address received the link. */
  changeEmail: (body: { current_password: string; new_email: string }) =>
    request<{ new_email: string; sent_to: string }>("/api/me/email", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Apply the email change after the user clicks the confirmation
   * link. Requires both the active session AND the token from the
   * link — the session ensures the original account holder is the
   * one finishing the flow even if the link gets forwarded. */
  confirmEmailChange: (token: string) =>
    request<Person>(
      `/api/me/email/confirm?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    ),

  /** Mark the caller's address as verified using the token sent on
   * signup. Public — no bearer required, since the user may be
   * clicking from a different device than the one they signed up on. */
  verifyEmail: (token: string) =>
    request<Person>(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    ),
  /** Re-send the signup verification email to the caller's address.
   * Auth-required (bearer); silently no-op if already verified. */
  resendVerification: () =>
    request<void>("/api/auth/resend-verification", { method: "POST" }),

  /** Request a password-reset email. Always succeeds — even for
   * addresses with no account — to avoid enumeration. */
  forgotPassword: (email: string) =>
    request<void>("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  /** Set a new password using the token from the reset email.
   * Public; doesn't require an active session. */
  resetPassword: (token: string, new_password: string) =>
    request<void>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, new_password }),
    }),
  uploadAvatar: async (file: File): Promise<Person> => {
    const fd = new FormData();
    fd.append("file", file);
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${API_BASE_URL}/api/me/avatar`, {
      method: "POST",
      headers, // do NOT set Content-Type — browser fills it with boundary
      body: fd,
    });
    if (!res.ok) {
      let detail: unknown = res.statusText;
      try {
        const body = await res.json();
        detail = body.detail ?? detail;
      } catch {
        /* ignore */
      }
      throw new Error(formatErrorDetail(detail, res.statusText));
    }
    return res.json();
  },
  deleteAvatar: () =>
    request<void>("/api/me/avatar", { method: "DELETE" }),

  // Categories
  listCategories: () => request<Category[]>("/api/categories"),
  createCategory: (body: { name: string; level?: number | null; description?: string | null }) =>
    request<Category>("/api/categories", { method: "POST", body: JSON.stringify(body) }),
  updateCategory: (
    id: number,
    body: { name?: string; level?: number | null; description?: string | null },
  ) => request<Category>(`/api/categories/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteCategory: (id: number) =>
    request<void>(`/api/categories/${id}`, { method: "DELETE" }),

  // Slots
  listSlots: () => request<Slot[]>("/api/slots"),
  getSlot: (id: number) => request<Slot>(`/api/slots/${id}`),
  createSlot: (body: SlotInput) =>
    request<Slot>("/api/slots", { method: "POST", body: JSON.stringify(body) }),
  updateSlot: (id: number, body: Partial<SlotInput>) =>
    request<Slot>(`/api/slots/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSlot: (id: number) => request<void>(`/api/slots/${id}`, { method: "DELETE" }),
  moveSlot: (id: number, direction: "up" | "down") =>
    request<Slot[]>(`/api/slots/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ direction }),
    }),
  replaceSlotRules: (id: number, rules: SlotRuleInput[]) =>
    request<Slot>(`/api/slots/${id}/rules`, {
      method: "PUT",
      body: JSON.stringify({ rules }),
    }),

  // Team
  listTeam: () => request<TeamMember[]>("/api/team"),
  updateTeamMember: (id: number, body: TeamMemberUpdate) =>
    request<TeamMember>(`/api/team/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  inviteTeamMember: (body: {
    email: string;
    person_name: string;
    category_id?: number | null;
    roles?: string[];
  }) =>
    request<InviteCreateResponse>("/api/team/invite", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Invitations (admin)
  listInvitations: () => request<Invitation[]>("/api/invitations"),
  revokeInvitation: (id: number) =>
    request<Invitation>(`/api/invitations/${id}/revoke`, { method: "POST" }),
  reissueInvitation: (id: number) =>
    request<InviteCreateResponse>(`/api/invitations/${id}/reissue`, {
      method: "POST",
    }),
  /** Rotate the token on a pending invitation and re-send the
   * email. Old accept URL becomes invalid. Returns the refreshed
   * Invitation row so the caller can update the delivery-status
   * pill without a follow-up list call. */
  resendInvitation: (id: number) =>
    request<Invitation>(`/api/invitations/${id}/resend`, { method: "POST" }),

  // Public invite acceptance (no auth)
  getInvitationByToken: (token: string) =>
    request<InvitationPublicView>(`/api/invitations/by-token/${encodeURIComponent(token)}`),
  acceptInvitation: (
    token: string,
    body: {
      password: string;
      /** Legacy single-field name. Sprint 18+ invitees should send
       * first_name + last_name; server composes the legacy field. */
      person_name?: string;
      first_name?: string;
      last_name?: string;
      /** Affirmative ToS + Privacy acceptance. Server rejects
       * with 422 if missing or false. */
      accept_terms: boolean;
    },
  ) =>
    request<AuthResponse>(
      `/api/invitations/by-token/${encodeURIComponent(token)}/accept`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  // Onboarding
  completeOnboarding: () =>
    request<Tenant>("/api/onboarding/complete", { method: "POST" }),
  setOnboardingPreset: (kind: PresetKind) =>
    request<Tenant>("/api/onboarding/preset", {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),

  // Incidents (operational log)
  listIncidents: () => request<Incident[]>("/api/incidents"),
  createIncident: (body: {
    occurred_at: string;
    title: string;
    body?: string | null;
  }) =>
    request<Incident>("/api/incidents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateIncident: (
    id: number,
    body: { occurred_at?: string; title?: string; body?: string | null },
  ) =>
    request<Incident>(`/api/incidents/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteIncident: (id: number) =>
    request<void>(`/api/incidents/${id}`, { method: "DELETE" }),

  // Sub-team groups
  listGroups: () => request<Group[]>("/api/groups"),
  createGroup: (body: { name: string; lead_membership_id?: number | null }) =>
    request<Group>("/api/groups", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateGroup: (
    id: number,
    body: {
      name?: string;
      lead_membership_id?: number | null;
      clear_lead?: boolean;
    },
  ) =>
    request<Group>(`/api/groups/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteGroup: (id: number) =>
    request<void>(`/api/groups/${id}`, { method: "DELETE" }),
  replaceGroupMembers: (id: number, membership_ids: number[]) =>
    request<Group>(`/api/groups/${id}/members`, {
      method: "PUT",
      body: JSON.stringify({ membership_ids }),
    }),

  // Meetings (reuniones). Plain members see only meetings they're
  // in the audience of; admins see everything.
  listMeetings: () => request<Meeting[]>("/api/meetings"),
  listMeetingInstances: (from: string, to: string) =>
    request<MeetingInstance[]>(
      `/api/meetings/instances?from=${from}&to=${to}`,
    ),
  createRegularMeeting: (body: {
    title: string;
    description?: string | null;
    location?: string | null;
    weekday: number;
    start_time: string;
    end_time: string;
    include_main_team: boolean;
    group_ids: number[];
    person_ids: number[];
  }) =>
    request<Meeting>("/api/meetings/regular", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateRegularMeeting: (
    id: number,
    body: {
      title: string;
      description?: string | null;
      location?: string | null;
      weekday: number;
      start_time: string;
      end_time: string;
      include_main_team: boolean;
      group_ids: number[];
      person_ids: number[];
    },
  ) =>
    request<Meeting>(`/api/meetings/${id}/regular`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  createAdHocMeeting: (body: {
    title: string;
    description?: string | null;
    location?: string | null;
    date: string;
    start_time: string;
    end_time: string;
    include_main_team: boolean;
    group_ids: number[];
    person_ids: number[];
  }) =>
    request<Meeting>("/api/meetings/ad-hoc", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAdHocMeeting: (
    id: number,
    body: {
      title: string;
      description?: string | null;
      location?: string | null;
      date: string;
      start_time: string;
      end_time: string;
      include_main_team: boolean;
      group_ids: number[];
      person_ids: number[];
    },
  ) =>
    request<Meeting>(`/api/meetings/${id}/ad-hoc`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteMeeting: (id: number) =>
    request<void>(`/api/meetings/${id}`, { method: "DELETE" }),

  // Tenant defaults
  updateTenantDefaults: (body: {
    country_code?: string | null;
    region_code?: string | null;
  }) => request<Tenant>("/api/tenants/me", { method: "PATCH", body: JSON.stringify(body) }),
  /** Mark one of the four post-signup areas as completed (or undo
   * it). Server writes/clears the corresponding
   * tenant.setup_*_completed_at column. */
  setSetupArea: (area: SetupArea, completed: boolean) =>
    request<Tenant>("/api/tenants/me/setup", {
      method: "POST",
      body: JSON.stringify({ area, completed }),
    }),

  // Holidays
  listHolidays: (year?: number) =>
    request<Holiday[]>(`/api/holidays${year ? `?year=${year}` : ""}`),
  createHoliday: (body: {
    date: string;
    name: string;
    source?: HolidaySource;
    region_code?: string | null;
  }) => request<Holiday>("/api/holidays", { method: "POST", body: JSON.stringify(body) }),
  deleteHoliday: (id: number) =>
    request<void>(`/api/holidays/${id}`, { method: "DELETE" }),
  importHolidays: (body: {
    country_code: string;
    region_code?: string | null;
    year: number;
  }) =>
    request<HolidayImportResult>("/api/holidays/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Admin stats — aggregated assignment counts per (person, slot, ym).
  statsAssignments: (params: { from: string; to: string }) => {
    const qs = new URLSearchParams();
    qs.set("from", params.from);
    qs.set("to", params.to);
    return request<StatsResponse>(
      `/api/stats/assignments?${qs.toString()}`,
    );
  },

  // Team absences (public, read-only). Used by the Libre row in the
  // planning grid; visible to any authenticated user.
  listTeamAbsences: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const q = qs.toString();
    return request<TeamAbsence[]>(
      `/api/availability/team-absences${q ? `?${q}` : ""}`,
    );
  },

  // Availability blocks
  listAvailabilityBlocks: (params?: {
    person_id?: number;
    from?: string;
    to?: string;
    status?: AvailabilityBlockStatus;
  }) => {
    const qs = new URLSearchParams();
    if (params?.person_id !== undefined) qs.set("person_id", String(params.person_id));
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (params?.status) qs.set("status", params.status);
    const s = qs.toString();
    return request<AvailabilityBlock[]>(
      `/api/availability-blocks${s ? `?${s}` : ""}`,
    );
  },
  approveAvailabilityBlock: (id: number) =>
    request<AvailabilityBlock>(`/api/availability-blocks/${id}/approve`, {
      method: "POST",
    }),
  denyAvailabilityBlock: (id: number, review_notes?: string | null) =>
    request<AvailabilityBlock>(`/api/availability-blocks/${id}/deny`, {
      method: "POST",
      body: JSON.stringify({ review_notes: review_notes ?? null }),
    }),
  // Self-service availability requests (any member of tenant)
  listMyAvailabilityRequests: () =>
    request<AvailabilityBlock[]>("/api/me/availability-requests"),
  createMyAvailabilityRequest: (body: {
    start_date: string;
    end_date: string;
    block_type: AvailabilityBlockType;
    notes?: string | null;
  }) =>
    request<AvailabilityBlock>("/api/me/availability-requests", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteMyAvailabilityRequest: (id: number) =>
    request<void>(`/api/me/availability-requests/${id}`, { method: "DELETE" }),
  createAvailabilityBlock: (body: {
    person_id: number;
    start_date: string;
    end_date: string;
    block_type: AvailabilityBlockType;
    notes?: string | null;
  }) =>
    request<AvailabilityBlock>("/api/availability-blocks", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAvailabilityBlock: (
    id: number,
    body: {
      person_id: number;
      start_date: string;
      end_date: string;
      block_type: AvailabilityBlockType;
      notes?: string | null;
    },
  ) =>
    request<AvailabilityBlock>(`/api/availability-blocks/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteAvailabilityBlock: (id: number) =>
    request<void>(`/api/availability-blocks/${id}`, { method: "DELETE" }),

  // Schedules
  listSchedules: () => request<Schedule[]>("/api/schedules"),
  getSchedule: (id: number, opts?: { groupId?: number }) => {
    const qs = opts?.groupId !== undefined ? `?group_id=${opts.groupId}` : "";
    return request<ScheduleDetail>(`/api/schedules/${id}${qs}`);
  },
  generateSchedule: (period: string) =>
    request<ScheduleDetail>("/api/schedules/generate", {
      method: "POST",
      body: JSON.stringify({ period }),
    }),
  publishSchedule: (id: number, notifyMembers: boolean = true) =>
    request<Schedule>(
      `/api/schedules/${id}/publish?notify_members=${notifyMembers}`,
      { method: "POST" },
    ),
  archiveSchedule: (id: number) =>
    request<Schedule>(`/api/schedules/${id}/archive`, { method: "POST" }),
  unarchiveSchedule: (id: number) =>
    request<Schedule>(`/api/schedules/${id}/unarchive`, { method: "POST" }),
  reopenSchedule: (id: number, notifyMembers: boolean = true) =>
    request<Schedule>(
      `/api/schedules/${id}/reopen?notify_members=${notifyMembers}`,
      { method: "POST" },
    ),
  deleteSchedule: (id: number) =>
    request<void>(`/api/schedules/${id}`, { method: "DELETE" }),
  /** Publish a group's plan for a schedule. Idempotent — calling
   * with an already-published (schedule, group) just refreshes
   * the timestamp. Authorized for the group's lead or the
   * tenant admin. */
  publishGroupSchedule: (scheduleId: number, groupId: number) =>
    request<Schedule>(
      `/api/schedules/${scheduleId}/groups/${groupId}/publish`,
      { method: "POST" },
    ),
  unpublishGroupSchedule: (scheduleId: number, groupId: number) =>
    request<Schedule>(
      `/api/schedules/${scheduleId}/groups/${groupId}/publish`,
      { method: "DELETE" },
    ),

  // Shift swaps
  listSwapOffers: (opts?: { mine?: boolean; status?: SwapOfferStatus }) => {
    const qs = new URLSearchParams();
    if (opts?.mine) qs.set("mine", "true");
    if (opts?.status) qs.set("status_", opts.status);
    const q = qs.toString();
    return request<SwapOffer[]>(`/api/swap-offers${q ? `?${q}` : ""}`);
  },
  createSwapOffer: (body: { assignment_id: number; notes?: string | null }) =>
    request<SwapOffer>("/api/swap-offers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  cancelSwapOffer: (id: number) =>
    request<SwapOffer>(`/api/swap-offers/${id}/cancel`, { method: "POST" }),
  respondToSwapOffer: (
    id: number,
    body: {
      kind: SwapResponseKind;
      swap_assignment_id?: number | null;
      notes?: string | null;
    },
  ) =>
    request<SwapResponse>(`/api/swap-offers/${id}/respond`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  acceptSwapResponse: (offerId: number, responseId: number) =>
    request<SwapOffer>(
      `/api/swap-offers/${offerId}/responses/${responseId}/accept`,
      { method: "POST" },
    ),
  declineSwapResponse: (offerId: number, responseId: number) =>
    request<SwapResponse>(
      `/api/swap-offers/${offerId}/responses/${responseId}/decline`,
      { method: "POST" },
    ),
  withdrawSwapResponse: (offerId: number, responseId: number) =>
    request<SwapResponse>(
      `/api/swap-offers/${offerId}/responses/${responseId}/withdraw`,
      { method: "POST" },
    ),
  adminListSwaps: () => request<SwapOffer[]>("/api/admin/swaps"),
  patchAssignment: (
    scheduleId: number,
    assignmentId: number,
    body: { person_id?: number | null; clear_person?: boolean; team_role_id?: number | null },
  ) =>
    request<Assignment>(
      `/api/schedules/${scheduleId}/assignments/${assignmentId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  /** Used by group leads to add a brand-new assignment row to a
   * schedule for one of their group's slots on a given date.
   * Tenant admins can use this too but typically don't need to —
   * the solver pre-creates rows for main-team slots. */
  createAssignment: (
    scheduleId: number,
    body: {
      slot_id: number;
      date: string;
      person_id?: number | null;
      team_role_id?: number | null;
    },
  ) =>
    request<Assignment>(`/api/schedules/${scheduleId}/assignments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteAssignment: (scheduleId: number, assignmentId: number) =>
    request<void>(
      `/api/schedules/${scheduleId}/assignments/${assignmentId}`,
      { method: "DELETE" },
    ),
  lockAssignment: (scheduleId: number, assignmentId: number) =>
    request<Assignment>(
      `/api/schedules/${scheduleId}/assignments/${assignmentId}/lock`,
      { method: "POST" },
    ),
  unlockAssignment: (scheduleId: number, assignmentId: number) =>
    request<Assignment>(
      `/api/schedules/${scheduleId}/assignments/${assignmentId}/lock`,
      { method: "DELETE" },
    ),
  listEligiblePersons: (scheduleId: number, assignmentId: number) =>
    request<EligiblePerson[]>(
      `/api/schedules/${scheduleId}/assignments/${assignmentId}/eligible-persons`,
    ),
  /** Download the member's own shifts as an iCalendar (.ics) file.
   * Range is inclusive on both ends; optional slot_ids narrows the
   * export to a subset of slot types. Auth via Bearer header, so we
   * fetch + blob + trigger a synthetic <a download> click instead of
   * window.open-ing the URL. */
  downloadMyShiftsIcs: async (params: {
    from: string;
    to: string;
    slotIds?: number[];
  }) => {
    const token = getToken();
    const headers: HeadersInit = {};
    if (token) (headers as Record<string, string>).Authorization = `Bearer ${token}`;
    const q = new URLSearchParams({ from: params.from, to: params.to });
    if (params.slotIds && params.slotIds.length > 0) {
      q.set("slot_ids", params.slotIds.join(","));
    }
    const res = await fetch(
      `${API_BASE_URL}/api/me/shifts.ics?${q.toString()}`,
      { headers },
    );
    if (!res.ok) {
      let detail: unknown = res.statusText;
      try {
        const body = await res.json();
        detail = body.detail ?? detail;
      } catch {
        /* binary response, no JSON */
      }
      throw new Error(
        typeof detail === "string" ? detail : "Error generando calendario",
      );
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition");
    const match = cd?.match(/filename="([^"]+)"/);
    const filename = match?.[1] ?? `turnos.ics`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** Fetch the schedule PDF (full month, same for admin and members),
   * then trigger a browser download with the server-suggested
   * filename. Auth via Bearer header, so we can't just window.open
   * the URL. */
  downloadSchedulePdf: async (scheduleId: number) =>
    _downloadPdfFromUrl(
      `${API_BASE_URL}/api/schedules/${scheduleId}/pdf`,
      "planificacion.pdf",
    ),
  /** Sub-team PDF — same shape but filtered to one group's slots.
   * Access matches the read-only group views: admin always, lead
   * for own group always, plain member only when published. */
  downloadGroupSchedulePdf: async (scheduleId: number, groupId: number) =>
    _downloadPdfFromUrl(
      `${API_BASE_URL}/api/schedules/${scheduleId}/groups/${groupId}/pdf`,
      "planificacion-sub-equipo.pdf",
    ),

  // Bulk invite (CSV)
  bulkInvitePreview: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const token = getToken();
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${API_BASE_URL}/api/team/invite/bulk/preview`, {
      method: "POST",
      body: fd,
      headers,
    });
    if (!res.ok) {
      let detail: unknown = res.statusText;
      try {
        const body = await res.json();
        detail = body.detail ?? detail;
      } catch {
        /* ignore */
      }
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return (await res.json()) as BulkPreviewResponse;
  },
  bulkInviteCommit: (rows: BulkCommitRow[]) =>
    request<BulkCommitResponse>("/api/team/invite/bulk/commit", {
      method: "POST",
      body: JSON.stringify({ rows }),
    }),

  // Slot succession rules (sprint 14)
  listSuccessionRules: () =>
    request<SlotSuccessionRule[]>("/api/slot-succession-rules"),
  createSuccessionRule: (body: SlotSuccessionRuleInput) =>
    request<SlotSuccessionRule>("/api/slot-succession-rules", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSuccessionRule: (id: number, body: SlotSuccessionRuleUpdate) =>
    request<SlotSuccessionRule>(`/api/slot-succession-rules/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteSuccessionRule: (id: number) =>
    request<void>(`/api/slot-succession-rules/${id}`, { method: "DELETE" }),

  // Slot frequency caps (sprint 14)
  listFrequencyCaps: () =>
    request<SlotFrequencyCap[]>("/api/slot-frequency-caps"),
  createFrequencyCap: (body: SlotFrequencyCapInput) =>
    request<SlotFrequencyCap>("/api/slot-frequency-caps", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateFrequencyCap: (id: number, body: SlotFrequencyCapUpdate) =>
    request<SlotFrequencyCap>(`/api/slot-frequency-caps/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteFrequencyCap: (id: number) =>
    request<void>(`/api/slot-frequency-caps/${id}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// Sprint 14: cross-slot dependency types
// ---------------------------------------------------------------------------

export type SuccessionAppliesTo = "same_person" | "whole_team";
export type DependencySeverity = "hard" | "soft";
export type FrequencyPeriod =
  | "rolling_7"
  | "rolling_14"
  | "rolling_28"
  | "iso_week"
  | "calendar_month";

export type SlotSuccessionRule = {
  id: number;
  tenant_id: number;
  after_slot_id: number;
  forbid_slot_id: number;
  /** Sprint 17: optional sub-role filter. NULL = the rule fires
   * regardless of which role of the named slot was assigned. */
  after_team_role_id: number | null;
  forbid_team_role_id: number | null;
  days_after: number;
  applies_to: SuccessionAppliesTo;
  severity: DependencySeverity;
  weight: number;
  created_at: string;
};

export type SlotSuccessionRuleInput = {
  after_slot_id: number;
  forbid_slot_id: number;
  after_team_role_id?: number | null;
  forbid_team_role_id?: number | null;
  days_after: number;
  applies_to?: SuccessionAppliesTo;
  severity?: DependencySeverity;
  weight?: number;
};

export type SlotSuccessionRuleUpdate = {
  days_after?: number;
  severity?: DependencySeverity;
  weight?: number;
};

export type SlotFrequencyCap = {
  id: number;
  tenant_id: number;
  slot_id: number;
  /** Sprint 17: optional sub-role filter. NULL = the cap counts
   * every assignment to the slot regardless of role. */
  team_role_id: number | null;
  period: FrequencyPeriod;
  max_count: number;
  severity: DependencySeverity;
  weight: number;
  created_at: string;
};

export type SlotFrequencyCapInput = {
  slot_id: number;
  team_role_id?: number | null;
  period: FrequencyPeriod;
  max_count: number;
  severity?: DependencySeverity;
  weight?: number;
};

export type SlotFrequencyCapUpdate = {
  max_count?: number;
  severity?: DependencySeverity;
  weight?: number;
};


export type BulkPreviewRow = {
  row_number: number;
  email: string;
  name: string;
  category: string | null;
  category_id: number | null;
  status: "ok" | "warning" | "error";
  error: string | null;
  warning: string | null;
};

export type BulkPreviewResponse = {
  rows: BulkPreviewRow[];
  summary: {
    total_rows: number;
    valid_rows: number;
    warning_rows: number;
    error_rows: number;
  };
};

export type BulkCommitRow = {
  row_number: number;
  email: string;
  name: string;
  category_id: number | null;
};

export type BulkCommitResultRow = {
  row_number: number;
  email: string;
  status: "ok" | "skipped" | "error";
  reason: string | null;
  invitation: {
    id: number;
    email: string;
    expires_at: string;
    accept_url: string;
  } | null;
};

export type BulkCommitResponse = {
  results: BulkCommitResultRow[];
  summary: { committed: number; skipped: number; errored: number };
};

export type InviteCreateResponse = {
  invitation_id: number;
  email: string;
  expires_at: string;
  accept_url: string;
};

export type Invitation = {
  id: number;
  tenant_id: number;
  email: string;
  person_name: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  category_id: number | null;
  roles: string[];
  /** ISO timestamp of the last successful SMTP send, or null when
   * the row has never been delivered. */
  last_email_sent_at: string | null;
  /** Error string from the last failed send, or null when the
   * most recent attempt succeeded (or none attempted). */
  last_email_error: string | null;
  created_at: string;
};

export type InvitationPublicView = {
  tenant_name: string;
  tenant_slug: string;
  email: string;
  person_name: string;
  expires_at: string;
};
