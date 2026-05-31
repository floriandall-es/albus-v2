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

/** Equipos redesign: per-equipo control over what siblings see in
 * the Servicio timeline. 'none' = invisible, 'selected' = only
 * slots marked shared_with_servicio, 'full' = everything published. */
export type SharePolicy = "none" | "selected" | "full";

/** Equipos redesign: tenant approval state. 'pending' on equipos
 * that joined an existing servicio and are awaiting a sibling
 * admin's nod; 'approved' otherwise. Pending equipos don't show
 * up in the servicio timeline or cross-tenant meeting audiences. */
export type ApprovalState = "pending" | "approved";

export type Tenant = {
  id: number;
  slug: string;
  name: string;
  country: string | null;
  locale: string | null;
  country_code: string | null;
  region_code: string | null;
  /** Sprint 28 / migration 0051: parent hospital this tenant rolls
   * up under. Null for standalone tenants (the default). When set,
   * hospital_name is the convenience name pulled server-side so
   * the frontend can render "Department · Hospital" labels without
   * an extra fetch. */
  hospital_id: number | null;
  hospital_name: string | null;
  /** Equipos redesign: the Servicio this Equipo belongs to. Null
   * only for legacy tenants (pre-Phase-A). Drives the "Servicio"
   * sidebar entry and the /admin/servicio page. */
  servicio_id: number | null;
  /** Servicio name pulled server-side via the joined relationship,
   * so the frontend can render "Servicio · Equipo" labels without
   * a second fetch. Null whenever servicio_id is null. */
  servicio_name: string | null;
  /** What this equipo exposes to other equipos in its servicio.
   * Default 'none' for new signups; 'full' both ways for the
   * alpha customer's existing equipos. */
  share_policy: SharePolicy;
  /** 'pending' when an equipo signs up against an existing
   * servicio and is waiting for a sibling admin's nod. Existing
   * data is grandfathered to 'approved'. */
  approval_state: ApprovalState;
  created_at: string;
  onboarding_completed_at: string | null;
  /** Onboarding template chosen on the new first wizard step.
   * Null on tenants created before the preset selector shipped. */
  preset_kind: PresetKind | null;
  /** Opt-in module: trasplantes (case log + stats). False for
   * most tenants; the customer flips it on at signup if their
   * service runs a transplant program. When false, the
   * "Trasplantes" sidebar entry hides and /api/transplants 404s. */
  transplants_enabled: boolean;
  /** Per-tenant cap on cambios de turno per member per monthly
   * schedule. Null = unlimited (default). Only the requester is
   * charged a cambio at fulfilment — covering for a colleague no
   * longer burns the responder's quota. Editable on /admin/swaps. */
  max_swaps_per_member_per_month: number | null;
  /** Migration 0084. When true, a requester clicking Aceptar on a
   * response parks the offer in pending_admin until an admin
   * approves or vetoes; only then does the assignment swap fire.
   * Default false preserves the legacy "requester decides" flow.
   * Toggled on /admin/swaps. */
  swap_requires_admin_approval: boolean;
  /** Per-area "I'm done configuring" timestamps. Null = pending
   * (Inicio shows the card, subpage shows the first-visit banner);
   * non-null = admin marked it done. Toggled via
   * POST /api/tenants/me/setup. */
  setup_activities_completed_at: string | null;
  setup_rules_completed_at: string | null;
  setup_team_completed_at: string | null;
  setup_subteams_completed_at: string | null;
  // Migration 0080 / docs/billing-plan.md. Defaults to 'members_pay'
  // for tenants created pre-billing. `subscription_status` is null
  // until the tenant goes through signup post-billing OR the
  // grandfather migration flips them to 'active'.
  billing_model: "members_pay" | "team_pays";
  subscription_status:
    | "trialing"
    | "active"
    | "past_due"
    | "unpaid"
    | "canceled"
    | null;
  trial_end_at: string | null;
};

/** Migration 0080. Returned by GET /api/billing/summary — drives
 * the /admin/billing page (plan card, seat breakdown, status,
 * Portal button). */
export type BillingSummary = {
  billing_model: "members_pay" | "team_pays";
  subscription_status:
    | "trialing"
    | "active"
    | "past_due"
    | "unpaid"
    | "canceled"
    | null;
  trial_end_at: string | null;
  /** True when the tenant has a Stripe Customer row. Frontend
   * uses this to decide whether to render the "Gestionar
   * facturación" button (no customer → grandfathered / never-
   * checked-out tenant, nothing for the Portal to manage). */
  has_stripe_customer: boolean;
  /** Active (non-disabled) memberships. Under team_pays this
   * drives the "1 admin × 29,90 € + N members × 4,90 €"
   * breakdown. */
  seats_total: number;
  seats_subscribed: number;
  seats_trialing: number;
  /** never_subscribed + canceled — they exist on the team but
   * don't have app access (still get printed schedules). */
  seats_paper: number;
};

/** Migration 0080. Returned by GET /api/billing/me — drives the
 * /me/billing page. Under team_pays the personal flow is
 * disabled; the page just shows "Tu equipo paga tu suscripción". */
export type MyBilling = {
  tenant_billing_model: "members_pay" | "team_pays";
  subscription_status:
    | "never_subscribed"
    | "trialing"
    | "active"
    | "past_due"
    | "canceled";
  trial_end_at: string | null;
  has_stripe_customer: boolean;
};

export type SetupArea = "activities" | "rules" | "team" | "subteams";

/** Phase D.2: one row of the public hospital typeahead at signup.
 * Returned by /api/public/hospitals/search. */
export type PublicHospital = {
  id: number;
  name: string;
  city: string | null;
  province: string | null;
  autonomous_community: string | null;
};

/** Phase D.2: one approved Servicio at a hospital, with the count of
 * approved Equipos (so the user knows what they're joining).
 * Returned by /api/public/hospitals/{id}/servicios. */
export type PublicServicio = {
  id: number;
  name: string;
  slug: string;
  approved_equipo_count: number;
};

/** Phase C.2: one peer Equipo within a Servicio. Returned as part
 * of the Servicio response so the /admin/servicio page can list
 * every equipo + render its share_policy badge. */
export type Equipo = {
  tenant_id: number;
  tenant_name: string;
  tenant_slug: string;
  share_policy: SharePolicy;
  approval_state: ApprovalState;
  created_at: string;
};

/** Phase C.2: top-level Servicio info + its peer equipos. */
export type Servicio = {
  id: number;
  name: string;
  slug: string;
  hospital_id: number;
  hospital_name: string;
  equipos: Equipo[];
};

/** Phase C.2: one visible assignment in the cross-equipo timeline. */
export type ServicioTimelineCell = {
  assignment_id: number;
  date: string;
  tenant_id: number;
  tenant_name: string;
  slot_id: number;
  slot_name: string;
  slot_color: string | null;
  slot_start_time: string | null;
  slot_end_time: string | null;
  person_id: number | null;
  person_name: string | null;
  person_last_name: string | null;
  schedule_id: number;
};

/** Phase C.2: wrapper returned by GET /api/servicios/{id}/timeline.
 * The cells array is flat; the page groups by date / equipo / slot
 * client-side so we don't lock the wire shape to one view. */
export type ServicioTimeline = {
  servicio_id: number;
  from_date: string;
  to_date: string;
  cells: ServicioTimelineCell[];
};

/** Phase D.3: one pending-approval Equipo in the caller's Servicio.
 * Returned by GET /api/equipos/pendientes. Carries enough metadata
 * for the admin to decide (who created it, when, with what email)
 * without a second fetch. */
export type PendingEquipo = {
  tenant_id: number;
  tenant_name: string;
  tenant_slug: string;
  created_at: string;
  admin_name: string;
  admin_first_name: string | null;
  admin_last_name: string | null;
  admin_email: string;
};

/** Phase C.2: one person reachable from the caller's Servicio.
 * Returned by GET /api/servicios/{id}/persons. Consumed by the
 * cross-equipo meeting invitee picker — `is_caller_tenant` tells
 * the UI whether to bucket the person under "Tu equipo" or
 * "Otros equipos del servicio". */
export type ServicioPerson = {
  person_id: number;
  person_name: string;
  person_first_name: string | null;
  person_last_name: string | null;
  person_avatar_url: string | null;
  tenant_id: number;
  tenant_name: string;
  category_name: string | null;
  is_caller_tenant: boolean;
};

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
  /** Migration 0083. When set, the block is locked to this
   * membership — only they can approve/deny. May reference an
   * admin in a sibling equipo within the same servicio. NULL on
   * legacy rows (any admin in the block's own tenant). */
  reviewer_membership_id: number | null;
  /** Denormalised at read time so the frontend can render
   * "Solicitada a: Dr. Pérez (Cardiología)" without a second
   * fetch. NULL whenever reviewer_membership_id is NULL. */
  reviewer_person_name: string | null;
  reviewer_tenant_name: string | null;
  /** Shifts the requester already has on days inside this block's
   * range — what the admin would be asking the solver to
   * re-assign if they approve. Populated ONLY for status='pending'
   * rows (other statuses get []). Capped at 20 entries per block
   * — see conflicting_shifts_truncated. */
  conflicting_shifts: {
    date: string;
    slot_name: string;
    role_label: string | null;
  }[];
  /** True when the conflict list was clipped at the 20-entry cap. */
  conflicting_shifts_truncated: boolean;
  created_at: string;
};

/** One row of the servicio-wide admin picker shown when a member
 * raises a bloqueo on /me/bloqueos. Carried inside
 * `ServicioAdminPicker.admins`. */
export type ServicioAdminOption = {
  membership_id: number;
  person_id: number;
  person_name: string;
  tenant_id: number;
  tenant_name: string;
  /** True for admins in the caller's own equipo. The picker
   * uses this to group "Tu equipo" vs "Otros equipos del
   * servicio". */
  is_own_tenant: boolean;
};

/** Migration 0085. Servicio bloqueo routing mode + the picker
 * candidates. When `mode === "centralised"` AND a Jefe de
 * Servicio is resolved, `admins` collapses to that single
 * membership and /me/bloqueos hides the dropdown. When the
 * servicio is centralised but no Jefe is currently in place,
 * the server returns `mode === "delegated"` (and the full
 * picker) so the member can still raise a bloqueo. Returned by
 * GET /api/me/servicio/admins. */
export type ServicioAdminPicker = {
  mode: "delegated" | "centralised";
  admins: ServicioAdminOption[];
};

/** Migration 0085. Snapshot of how bloqueos route in the caller's
 * servicio. Read by the Jefe de Servicio on /admin/compartir;
 * other admins get 403. */
export type BloqueoRouting = {
  mode: "delegated" | "centralised";
  /** The deterministically-resolved Jefe de Servicio, or null
   * when nobody currently carries the cargo. */
  jefe: {
    membership_id: number;
    person_id: number;
    person_name: string;
    tenant_id: number;
    tenant_name: string;
  } | null;
  /** True when the caller themselves is the resolved jefe — the
   * toggle copy switches from "Centralizar en {Name}" to
   * "Centralizar en mí". */
  caller_is_jefe: boolean;
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

/** Privacy-safe team aggregate on the /me/stats response — means
 *  only, no per-person data. Drives the "vs media del equipo" card
 *  on /me/estadisticas. Null on the admin /stats endpoint. */
/** Team mean per (slot, team_role), keyed to line up with the
 *  caller's per-actividad bars. */
export type ActivityAverage = {
  slot_id: number;
  team_role_id: number | null;
  avg_count: number;
};

export type TeamComparison = {
  team_member_count: number;
  avg_total_shifts: number;
  avg_weekend_or_holiday_shifts: number;
  /** Swap offers the caller created, + team mean. */
  my_swaps_requested: number;
  avg_swaps_requested: number;
  /** Times the caller accepted to cover a colleague, + team mean. */
  my_swaps_covered: number;
  avg_swaps_covered: number;
  /** Per-activity team means for the "Por actividad" comparison. */
  by_activity: ActivityAverage[];
};

export type StatsResponse = {
  from_date: string;
  to_date: string;
  rows: StatsRow[];
  team_comparison: TeamComparison | null;
};

// --- /api/stats/overview — Commit 1 of the stats dashboard overhaul ---
// One-shot payload that powers the redesigned /admin/stats top half:
// the 8-tile KPI strip, the equity histogram + outlier callout, the
// coverage trend, and the four monthly mini-charts. The existing
// per-(person, slot, month) StatsResponse still drives the "Detalle
// por actividad" section underneath.

export type StatsKpis = {
  total_assignments: number;
  uncovered_count: number;
  /** 0–100, server-rounded to 1 decimal. */
  uncovered_pct: number;
  swap_offers_open: number;
  swap_offers_fulfilled: number;
  swap_offers_cancelled: number;
  bloqueos_days_total: number;
  /** Per block_type breakdown (vacation / sick / training / personal /
   * other). Keys are whichever block_types appeared in the range —
   * absent keys mean zero. */
  bloqueos_days_by_type: Record<string, number>;
  reopened_schedules_count: number;
  incidents_count: number;
  /** Snapshot of the team RIGHT NOW (not range-scoped). */
  active_members: number;
  /** Sum of fte_pct/100 across non-disabled memberships. */
  total_fte: number;
};

export type StatsWorkloadRow = {
  person_id: number;
  person_name: string;
  person_avatar_url: string | null;
  category_id: number | null;
  category_name: string | null;
  fte_pct: number;
  total_shifts: number;
  weekend_or_holiday_shifts: number;
  /** total_shifts × 100 / fte_pct — what the person WOULD do if they
   * were full-time. Lets the equity histogram compare part-timers
   * apples-to-apples with full-timers. */
  normalized_total: number;
};

export type StatsMonthlyRow = {
  year_month: string;
  total_assignments: number;
  uncovered_count: number;
  swap_offers_created: number;
  swap_offers_fulfilled: number;
  /** Closed-as-cancelled this month. With swap_offers_fulfilled,
   *  this lets the Eficiencia tab plot the coverage rate over time. */
  swap_offers_cancelled: number;
  bloqueos_days: number;
  /** block_type → days within this month. Drives the multi-line
   *  "Libranzas por mes" chart on the Carga tab. Empty for months
   *  with no bloqueos. */
  bloqueos_days_by_type: Record<string, number>;
  incidents_count: number;
  /** Schedules reopened-after-publish this month. */
  reopened_count: number;
};

export type StatsOverviewResponse = {
  from_date: string;
  to_date: string;
  kpis: StatsKpis;
  workload: StatsWorkloadRow[];
  monthly: StatsMonthlyRow[];
};

// --- /api/stats/calendar — Commit 3 of the stats overhaul ---
// Per-(person, day) shift counts + bloqueo overlay for the GitHub-
// style heat map. Sparse: only days with non-zero activity OR an
// active bloqueo show up as entries.

export type CalendarPersonOut = {
  id: number;
  name: string;
  avatar_url: string | null;
  category_name: string | null;
};

export type CalendarEntry = {
  person_id: number;
  date: string;  // YYYY-MM-DD
  shifts: number;
  /** One of vacation / sick / training / personal / other when the
   * day overlaps an approved availability_block; null otherwise. */
  bloqueo_type: string | null;
};

export type StatsCalendarResponse = {
  from_date: string;
  to_date: string;
  /** Holiday dates in the range. Frontend uses these to overlay
   * a subtle background tint on holiday cells regardless of
   * shifts or bloqueos. */
  holidays: string[];
  persons: CalendarPersonOut[];
  entries: CalendarEntry[];
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
  /** Set when admin marked this (slot, date) as "No aplica" — the
   * cell is intentionally not staffed today. Distinct from
   * person_id=null + locked_at=null (= empty/pending). Dismissed
   * rows are also auto-locked so they survive regeneration. */
  dismissed_at: string | null;
  swap_offer_id: number | null;
  /** Client-side decoration ONLY — never set by the backend. The
   * /me/turnos Servicio scope tags sibling-tenant assignments with
   * the equipo name so a small chip can render in the Lista view,
   * and so the eye can disambiguate the same surgeon name appearing
   * across teams. Leave undefined for own-team rows + every non-
   * Servicio caller. */
  tenant_name?: string | null;
};

export type EligiblePerson = {
  person_id: number;
  person_name: string;
  /** Split name fields used by the Reasignar dropdown to render
   * last-name-only. Both fall back to whitespace-splitting
   * `person_name` via the personLastName helper if null. */
  person_first_name?: string | null;
  person_last_name?: string | null;
};

export type ScheduleDetail = Schedule & {
  assignments: Assignment[];
};

/**
 * One rule breach detected in a schedule's current assignments.
 * Surfaced by GET /api/schedules/{id}/violations and inside
 * AssignmentSaveResponse.warnings after a PATCH or POST. Warning
 * only — the backend never blocks a save.
 */
export type ViolationKind =
  | "incompatibility"
  | "succession"
  | "frequency"
  | "time_overlap"
  | "post_rest";

export type ViolationCell = {
  assignment_id: number;
  date: string;
  slot_id: number;
  person_id: number;
};

export type Violation = {
  kind: ViolationKind;
  message: string;
  cells: ViolationCell[];
  /** Tenant-rule row id when the violation comes from a configured
   * rule; null for implicit checks (time_overlap, post_rest). */
  rule_id: number | null;
  /** Hard / soft from the rule definition. Null for implicit
   * checks. UI uses this for banner colour, not for blocking. */
  severity: "hard" | "soft" | null;
  /** Stable identity hash (sha256 hex over kind + sorted cells +
   * rule_id). Echo back when calling suppress/unsuppress — the
   * backend uses this as the key in violation_suppressions. */
  signature: string;
  /** Timestamp when an admin overruled this conflict via the
   * "Ocultar" button. Null when still actively flagged. The
   * frontend hides suppressed entries behind a "Mostrar N ocultos"
   * toggle but receives them so it can offer an un-hide affordance. */
  suppressed_at: string | null;
};

/** Wrapper returned by PATCH and POST /assignments. Same as the
 * old AssignmentOut on the `assignment` field, plus `warnings`
 * carrying every rule breach in the schedule (whole-schedule
 * snapshot — frontend can diff against the previous list to
 * highlight just the new ones in a toast). */
export type AssignmentSaveResponse = {
  assignment: Assignment;
  warnings: Violation[];
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
  /** Migration 0057: two free-format phones per person. work_phone =
   * corporate / institutional line (switchboard, on-call); personal_phone
   * = private cell. Both are shared across all the person's tenants;
   * per-membership share_work_phone / share_personal_phone / share_whatsapp
   * decide what shows in each hospital directory. WhatsApp is always
   * linked to personal_phone. */
  work_phone: string | null;
  personal_phone: string | null;
  /** Migration 0061: list of free-text job titles for the directory
   * card. A clinician can wear more than one hat ("Adjunto" +
   * "Tutor de Residentes"). Always an array — empty when unset.
   * Distinct from membership.category — cargos are presentational,
   * category drives the scheduler. */
  cargos: string[];
  /** ISO timestamp the user clicked the signup verification link.
   * Null = not yet verified; UI shows the "verifica tu correo"
   * banner with a resend button until cleared. */
  email_verified_at: string | null;
  /** Migration 0065: per-user accent colour key (one of
   * AccentName in @/lib/accent). Default 'teal'. */
  preferred_accent: string;
  /** Migration 0079: gates the /founder dashboard. False for every
   * Person by default; flipped manually for Florian's account.
   * Frontend uses it to decide whether to render the founder route
   * or redirect away. */
  is_founder: boolean;
  /** Migration 0080: personal subscription state, used under
   * `members_pay` billing. Default 'never_subscribed' for fresh
   * rows; alpha pilots were flipped to 'active' by 0081. The
   * billing banner reads this for non-admin users on members_pay
   * tenants. */
  subscription_status:
    | "never_subscribed"
    | "trialing"
    | "active"
    | "past_due"
    | "canceled";
  /** ISO timestamp. Null when no trial has been started.
   * Drives the trial-countdown banner. */
  trial_end_at: string | null;
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
 * single word, returns it (typical legacy "last name only" tenants).
 *
 * Strips parenthetical suffixes like "(inactivo)" before the split —
 * otherwise the migrated disabled-surgeon Pastor ("Pastor (inactivo)"
 * in trasplantes case rows) would render as just "(inactivo)" when
 * we don't have a `last_name` field on the data. */
export function personLastName(p: {
  name: string;
  last_name?: string | null;
}): string {
  if (p.last_name && p.last_name.trim()) return p.last_name.trim();
  const parts = p.name
    .trim()
    .split(/\s+/)
    .filter((t) => !(t.startsWith("(") && t.endsWith(")")));
  if (parts.length === 0) return p.name;
  if (parts.length === 1) return parts[0];
  return parts.slice(1).join(" ");
}

/** Full "first last" name for surfaces where horizontal space is
 * generous and recognition matters more than density — e.g. the
 * hospital directory card. Prefers the split fields when both are
 * populated; falls back to the legacy single `name` column for
 * persons that pre-date the split (or migrated rows that only have
 * one or the other). Never returns "Gabriel Gabriel" when both
 * sides collapse to the same token. */
export function personFullName(p: {
  name: string;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  const first = p.first_name?.trim() ?? "";
  const last = p.last_name?.trim() ?? "";
  if (first && last) return `${first} ${last}`;
  return p.name.trim();
}

// ---- Shift swaps ----------------------------------------------------------
/** Migration 0084: added `pending_admin` (requester accepted but
 * tenant has admin-approval on so it's waiting) and `vetoed`
 * (admin killed the whole offer). */
export type SwapOfferStatus =
  | "open"
  | "pending_admin"
  | "fulfilled"
  | "cancelled"
  | "vetoed";
export type SwapResponseKind = "cover" | "swap";
/** Migration 0064: which response kinds the requester will accept. */
export type SwapOfferAccepts = "cover_only" | "swap_only" | "either";
/** Migration 0084: `pending_admin` is the response the requester
 * picked while the admin is still reviewing. */
export type SwapResponseStatus =
  | "pending"
  | "pending_admin"
  | "accepted"
  | "declined"
  | "withdrawn";
/** Migration 0084. Veto scope picked by the admin at decision time:
 * "response_only" reopens the offer for another colleague to step in,
 * "entire_offer" closes the cambio for good. */
export type SwapVetoScope = "response_only" | "entire_offer";

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
  /** Migration 0063: who the request went to. NULL means "everyone
   * in the tenant" (legacy or wide-cast); a list means only those
   * memberships are notified / can respond. */
  audience_membership_ids: number[] | null;
  /** Migration 0064: which response kinds the requester will
   * accept. "either" preserves legacy behaviour. */
  accepts: SwapOfferAccepts;
  /** Migration 0084. Admin approval audit trail. All four are
   * non-null only when the offer went through the admin-approval
   * flow; null for legacy / direct-path offers. */
  admin_decided_at: string | null;
  admin_decided_by_membership_id: number | null;
  admin_decided_by_person_name: string | null;
  admin_decision_notes: string | null;
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
  /** Sprint 28 / migration 0052: appears in the cross-tenant
   * hospital directory? True by default. Settings page lets the
   * clinician flip it off. */
  directory_visible: boolean;
  /** Per-channel opt-in. share_email defaults true (institutional —
   * migration 0054); the rest default false. Migration 0057 split
   * the single share_phone into work + personal variants;
   * share_whatsapp targets personal_phone only. The directory
   * renders the corresponding button (tel:/mailto:/wa.me) when
   * the flag is true AND the underlying datum exists. */
  share_work_phone: boolean;
  share_personal_phone: boolean;
  share_email: boolean;
  share_whatsapp: boolean;
  created_at: string;
};

/** Other end of a DM. Identifies the non-caller member with
 * the same display fields the directory uses. No contact channels
 * here — the DM itself is the contact channel. */
export type DMPeer = {
  person_id: number;
  name: string;
  /** Split-name fields. The chat list + conversation header render
   * "First Last" so the counterpart is recognisable at a glance —
   * last-name-only was too curt for a chat surface, where you may
   * be DM-ing someone you haven't met. Falls back to `name` for
   * legacy single-token persons (migrated rows). */
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  category_name: string | null;
  tenant_name: string | null;
};

/** Migration 0088. One row of the avatar stack on a group
 * conversation entry. Three are surfaced; the rest are summarised
 * as "+N más" in the UI. */
export type ConversationMemberPreview = {
  person_id: number;
  name: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
};

/** Migration 0088. Unified DM + group conversation type. `peer`
 * is non-null only for DMs (kind="dm"); group fields (`title`,
 * `member_count`, `member_previews`, `created_by_person_id`) are
 * populated only for groups. UI branches on `kind`. */
export type Conversation = {
  id: number;
  hospital_id: number;
  kind: "dm" | "group";
  created_at: string;
  last_message_at: string;
  peer: DMPeer | null;
  title: string | null;
  member_count: number;
  member_previews: ConversationMemberPreview[];
  /** Migration 0088. The person who created the group; null on
   * DMs and on groups whose creator was deleted (`ON DELETE SET
   * NULL`). When the caller IS this person, the UI lets them
   * remove other members. */
  created_by_person_id: number | null;
  unread_count: number;
  last_message_preview: string | null;
};

/** @deprecated Use `Conversation` instead. Kept as an alias so
 * existing call sites still compile during the migration to
 * group chats. */
export type DMConversation = Conversation;

/** Single message in a conversation. `body` is null when the
 * message has been soft-deleted (deleted_at non-null); UI
 * renders "mensaje borrado". */
export type DMMessage = {
  id: number;
  conversation_id: number;
  author_person_id: number | null;
  author_name: string | null;
  body: string | null;
  deleted_at: string | null;
  created_at: string;
};

/** Migration 0090. One question in this week's pulse survey.
 * `scale_type` distinguishes pure numeric scales (render N
 * buttons 1..scale_max) from labelled choice questions (render
 * scale_max labelled buttons from `labels`). */
export type PulseQuestion = {
  key: string;
  prompt: string;
  scale_type: "scale" | "choice";
  scale_max: number;
  labels: string[];
};

/** Migration 0090. The user's view of this week's pulse. When
 * `enabled` is false the tenant hasn't opted in — frontend shows
 * a disabled state, no submission allowed. `my_answers` is the
 * resume-state so a user who answered 2/5 then closed the tab
 * comes back to a partially-filled form. */
export type PulseCurrentWeek = {
  week_iso: string;
  enabled: boolean;
  questions: PulseQuestion[];
  my_answers: Record<string, number>;
};

/** Migration 0090. One row of self-history. */
export type PulseHistoryItem = {
  week_iso: string;
  question_key: string;
  score: number;
};

/** Migration 0090. Admin-side settings for the tenant's pulse
 * cadence. `last_notified_week_iso` is informational — drives
 * the "última notificación enviada" hint in the admin panel. */
export type PulseAdminSettings = {
  enabled: boolean;
  last_notified_week_iso: string | null;
};

/** Migration 0090. One row of the aggregated admin stats —
 * always week × question. Never exposes individual responses.
 * `distribution` is sorted (score, count) pairs so the frontend
 * can draw a histogram without recomputing. */
export type PulseQuestionStat = {
  week_iso: string;
  question_key: string;
  mean: number;
  response_count: number;
  distribution: [number, number][];
};

export type PulseAdminStats = {
  eligible_count: number;
  weekly: PulseQuestionStat[];
};

/** Migration 0090 + 0091. Admin view of one question with
 * tenant-override state. `prompt` is the effective text members
 * see; `default_prompt` is the in-code default so the admin UI
 * can show "restablecer" affordance. `enabled` is the post-
 * override on/off; `is_customized` is true iff prompt was rewritten
 * OR the question was disabled. `is_this_week` is false for
 * disabled rotating questions even when their key would have been
 * picked. */
export type PulseCatalogueQuestion = {
  key: string;
  prompt: string;
  default_prompt: string;
  scale_type: "scale" | "choice";
  scale_max: number;
  labels: string[];
  is_core: boolean;
  is_this_week: boolean;
  enabled: boolean;
  is_customized: boolean;
};

export type PulseCatalogue = {
  current_week_iso: string;
  core: PulseCatalogueQuestion[];
  rotating: PulseCatalogueQuestion[];
};

/** Admin-only view of the caller's tenant settings. `name` is
 * editable; `slug` is the URL-stable identifier and stays
 * frozen; `hospital_name` is the parent hospital (read-only,
 * Phase D — admins don't reparent from here). */
export type AdminTenantSettings = {
  id: number;
  name: string;
  slug: string;
  hospital_name: string | null;
};

/** Migration 0089. One row of the caller's push subscription list.
 * Endpoint / encryption keys deliberately omitted — the panel only
 * needs to identify each device for revoke purposes. The "this
 * device" row is matched by id (stored in localStorage at subscribe
 * time), not by snooping the endpoint. */
export type PushSubscriptionItem = {
  id: number;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
};

/** One row of the cross-tenant hospital directory. Returned by
 * `GET /api/hospital/directory` — joins membership + person +
 * tenant + category + group for the listing UI. No emails or
 * phones exposed in P1. */
export type HospitalDirectoryEntry = {
  person_id: number;
  person_name: string;
  person_first_name: string | null;
  person_last_name: string | null;
  person_avatar_url: string | null;
  membership_id: number;
  tenant_id: number;
  tenant_name: string;
  tenant_slug: string;
  category_id: number | null;
  category_name: string | null;
  /** Free-text job titles (migration 0061). Rendered as pills on
   * the directory card. Falls back to category_name when empty. */
  cargos: string[];
  roles: string[];
  /** Contact methods. Each field is populated only when the
   * corresponding share_* flag is true on the membership AND the
   * underlying datum exists. Migration 0057 split the single
   * phone into work + personal; WhatsApp is always tied to the
   * personal phone. UI renders one button per non-null value. */
  email: string | null;
  work_phone: string | null;
  personal_phone: string | null;
  whatsapp_phone: string | null;
  /** True when the caller has starred this person via the
   * directory favorites table (migration 0058). Drives the
   * "Favoritos" section + filled-star icon on the card. */
  is_favorite: boolean;
  /** Slot name when this person is on a guardia-named slot today
   * in any of the hospital's published schedules (migration 0062
   * SECURITY DEFINER function). Carries the slot verbatim
   * ("Guardia presencial", "Guardia localizada"…) so the pill
   * on the card matches what they're actually doing. Null when
   * not on guardia today or when the source schedule is still a
   * draft. */
  on_guardia_today: string | null;
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

export type MeetingKind = "regular" | "ad_hoc";

export type MeetingAudience = {
  include_main_team: boolean;
  person_ids: number[];
  /** Aligned with `person_ids` by index. */
  person_names: string[];
};

/** Migration 0066: allowed reminder offsets (minutes before the
 * meeting starts). Mirrors the Literal in api/app/schemas/meeting.py
 * and the CHECK constraint on meetings.reminder_minutes_before. */
export type ReminderMinutesBefore = 15 | 60 | 180 | 1440 | 10080;

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
  /** Migration 0066: NULL = no reminder configured. */
  reminder_minutes_before: ReminderMinutesBefore | null;
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
  /** Multi-week rotation: each position holds the slot for this
   * many weeks before advancing. Default 1 (one position per
   * week step). Only meaningful for strategy='rotation'. */
  weeks_per_position: number;
  weekly_pins: SlotRuleWeeklyPin[];
  rotation_blocks: SlotRuleRotationBlock[];
  rotation_members: SlotRuleRotationMember[];
};

export type SlotRuleInput = {
  days_bitmap: number;
  strategy: SlotRuleStrategy;
  anchor_date?: string | null;
  weeks_per_position?: number;
  weekly_pins?: { weekday: number; person_id: number }[];
  rotation_blocks?: { position: number; days_bitmap: number }[];
  rotation_members?: { position: number; person_id: number }[];
};

export type Slot = {
  id: number;
  tenant_id: number;
  department_id: number | null;
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
  /** Per-slot categoría restriction. Empty = any categoría;
   * non-empty = only members whose categoría is in this list may
   * cover the slot. For team_composition slots this filter applies
   * in addition to each team_role's category list (intersection). */
  allowed_category_ids: number[];
  rules: SlotRule[];
  /** Phase C.2: per-slot opt-in for the Servicio timeline. Only
   * consulted when the owning tenant's share_policy='selected'.
   * Editable via PATCH /api/slots/{id}; the /admin/slots page
   * surfaces a toggle when the policy is in that mode. */
  shared_with_servicio: boolean;
  created_at: string;
};

export type SlotInput = {
  name: string;
  department_id?: number | null;
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
  /** Empty = any categoría; non-empty = only members whose categoría
   * is in this list may cover the slot. */
  allowed_category_ids?: number[];
  /** Phase C.2: per-slot Servicio timeline opt-in. Send true/false
   * to toggle; omit to leave unchanged on a PATCH. */
  shared_with_servicio?: boolean;
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
  /** True when the admin has invited them but they haven't yet
   * opened the activation link to set a password. The solver
   * schedules pendientes like any other member; this flag just
   * drives the "Pendiente" badge in the admin team list. */
  is_pending: boolean;
  /** Migration 0080. Mirrors `persons.subscription_status`. Under
   * `team_pays` the per-person value is informational (admin pays
   * for everyone via the tenant sub). Under `members_pay` it
   * decides whether the member can open the app at all. The
   * /admin/team chip column reads this. */
  subscription_status:
    | "never_subscribed"
    | "trialing"
    | "active"
    | "past_due"
    | "canceled";
  /** ISO timestamp. Null when no trial has ever started. Surfaces
   * in the chip tooltip while trialing. */
  trial_end_at: string | null;
  created_at: string;
};

/** Migration 0087. Status of an admin promotion request — the
 * consent handshake that runs before we change a member's
 * Stripe price under members_pay. */
export type AdminPromotionStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired";

export type AdminPromotionRequestData = {
  id: number;
  target_membership_id: number;
  target_person_name: string;
  requested_by_membership_id: number | null;
  requested_by_person_name: string | null;
  status: AdminPromotionStatus;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
};

export type AdminPromotionPreviewData = {
  tenant_name: string;
  target_person_name: string;
  inviter_person_name: string | null;
  status: AdminPromotionStatus;
  expires_at: string;
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
  /** Admin override for a PENDIENTE member's email. Backend
   * rejects with 400 if the member already activated (they
   * change their own email via /me/email's confirmation flow).
   * Rejects with 409 on email collisions. Common use: replace
   * placeholder *.invalid emails left by a CSV migration with
   * the real addresses before sending invitations. */
  email?: string;
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
  /** Phase D.2 signup. Hospital → Servicio → Equipo, all anchored
   * on the CNH catalog. hospital_id MUST reference a CNH-coded row
   * (use api.searchHospitals to get one). Servicio is either an
   * existing one in that hospital (servicio_id → equipo starts
   * pending) or a fresh one (servicio_name → equipo auto-approved
   * as the first in the new servicio). */
  signup: (body: {
    first_name: string;
    last_name?: string;
    email: string;
    password: string;
    accept_terms: boolean;
    hospital_id: number;
    servicio_id?: number;
    servicio_name?: string;
    equipo_name: string;
    transplants_enabled?: boolean;
  }) => request<AuthResponse>("/api/signup", { method: "POST", body: JSON.stringify(body) }),

  /** Public typeahead over the CNH-seeded hospitals catalog.
   * Min 2 chars, max 80; up to 20 rows back. Used during signup. */
  searchHospitals: (q: string) => {
    const qs = new URLSearchParams({ q });
    return request<PublicHospital[]>(
      `/api/public/hospitals/search?${qs.toString()}`,
    );
  },

  /** Public: approved servicios at a hospital + the count of
   * approved equipos in each. Step 3 of the signup wizard. */
  listHospitalServicios: (hospitalId: number) =>
    request<PublicServicio[]>(`/api/public/hospitals/${hospitalId}/servicios`),

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
  /** Cross-tenant hospital directory. Returns [] when the caller's
   * tenant has no parent hospital (standalone tenants). Optional
   * filters: q (substring against name + last name), category_id,
   * tenant_id. */
  listHospitalDirectory: (params?: {
    q?: string;
    category_id?: number;
    tenant_id?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.category_id != null)
      qs.set("category_id", String(params.category_id));
    if (params?.tenant_id != null)
      qs.set("tenant_id", String(params.tenant_id));
    const q = qs.toString();
    return request<HospitalDirectoryEntry[]>(
      `/api/hospital/directory${q ? `?${q}` : ""}`,
    );
  },
  /** Toggle the caller's own membership opt-out from the hospital
   * directory. Scoped to the current tenant's membership — if the
   * caller has multiple memberships, they switch tenants to set
   * this per employment. */
  setMyDirectoryVisibility: (visible: boolean) =>
    request<{ directory_visible: boolean }>(
      "/api/me/directory-visibility",
      {
        method: "PATCH",
        body: JSON.stringify({ directory_visible: visible }),
      },
    ),
  /** Per-channel directory opt-ins on the caller's current
   * tenant's membership. Pass only the fields you want to
   * change. The data itself (phone, email) lives on Person; these
   * flags govern visibility only. */
  setMyContactPreferences: (body: {
    share_work_phone?: boolean;
    share_personal_phone?: boolean;
    share_email?: boolean;
    share_whatsapp?: boolean;
  }) =>
    request<{
      share_work_phone: boolean;
      share_personal_phone: boolean;
      share_email: boolean;
      share_whatsapp: boolean;
    }>("/api/me/contact-preferences", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Star a directory peer. Idempotent. The /api/hospital/directory
   * listing carries an `is_favorite` flag per entry, so callers
   * typically invalidate that query after a mutation rather than
   * holding the favorites set client-side. */
  addDirectoryFavorite: (peer_person_id: number) =>
    request<{ peer_person_id: number; is_favorite: boolean }>(
      "/api/me/directory-favorites",
      {
        method: "POST",
        body: JSON.stringify({ peer_person_id }),
      },
    ),
  /** Unstar a directory peer. Idempotent — deleting a non-existent
   * favorite is fine. */
  removeDirectoryFavorite: (peer_person_id: number) =>
    request<{ peer_person_id: number; is_favorite: boolean }>(
      `/api/me/directory-favorites/${peer_person_id}`,
      { method: "DELETE" },
    ),
  /** DMs (Phase 2A). Find-or-create a 1:1 conversation with
   * `peer_person_id`. Idempotent — server-side dedupes on the
   * sorted pair. Returns the conversation (existing or new). */
  createOrGetDM: (peer_person_id: number) =>
    request<DMConversation>("/api/dms", {
      method: "POST",
      body: JSON.stringify({ peer_person_id }),
    }),
  /** My conversations across all my hospitals, sorted by
   * last_message_at desc. Includes peer + unread_count +
   * last_message_preview. */
  listMyConversations: () =>
    request<DMConversation[]>("/api/conversations"),
  /** Phase 2B: total unread messages across all my conversations,
   * capped at 99. Single SQL query so the 60s sidebar poll cost
   * stays flat. */
  getMyUnreadCount: () =>
    request<{ total: number }>("/api/me/unread-count"),
  /** Five roll-ups feeding the admin Pendientes inbox:
   * bloqueos pending approval, invitations still live, open swap
   * offers (informational only — requester action), swap offers
   * parked in pending_admin (migration 0084, admin DOES action),
   * and (Phase D.3) sibling equipos waiting for approval in the
   * servicio. Polled every 60 s by the admin sidebar — mirror of
   * the DM unread badge. */
  getAdminPendientes: () =>
    request<{
      bloqueos_pending: number;
      invitations_open: number;
      swap_offers_open: number;
      swap_offers_pending_admin: number;
      equipos_pending: number;
    }>("/api/admin/pendientes"),
  /** Founder-only: cross-tenant rollup of every signed-up equipo.
   * Backend is gated on Person.is_founder — non-founders get 403.
   * Used by /founder. Not polled; user refreshes manually. */
  listFounderTenants: () =>
    request<FounderTenantSummary[]>("/api/founder/tenants"),
  /** Phase D.3: pending sibling equipos awaiting approval in the
   * caller's servicio. Admin-only. */
  listPendingEquipos: () =>
    request<PendingEquipo[]>("/api/equipos/pendientes"),
  /** Phase D.3: approve a pending sibling equipo. 204. */
  approveEquipo: (tenantId: number) =>
    request<void>(`/api/equipos/${tenantId}/approve`, { method: "POST" }),
  /** Phase D.3: decline (hard-delete) a pending sibling equipo.
   * The just-signed-up admin's Person row survives + gets emailed
   * the decline notice. 204. */
  declineEquipo: (tenantId: number) =>
    request<void>(`/api/equipos/${tenantId}/decline`, { method: "POST" }),
  /** Paginated messages of a conversation. `before` is the
   * cursor — pass the smallest id you have to load older. */
  listMessages: (conversationId: number, before?: number, limit = 50) => {
    const qs = new URLSearchParams();
    if (before !== undefined) qs.set("before", String(before));
    qs.set("limit", String(limit));
    return request<DMMessage[]>(
      `/api/conversations/${conversationId}/messages?${qs.toString()}`,
    );
  },
  /** Send a message. body is plain text 1–4000 chars. Returns
   * the inserted message. */
  sendMessage: (conversationId: number, body: string) =>
    request<DMMessage>(
      `/api/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ body }) },
    ),
  /** Mark a conversation as read up to `last_message_id`. The
   * server only ever moves the high-water mark forward; sending
   * a smaller id is a no-op. 204. */
  markConversationRead: (
    conversationId: number,
    last_message_id: number,
  ) =>
    request<void>(`/api/conversations/${conversationId}/read`, {
      method: "POST",
      body: JSON.stringify({ last_message_id }),
    }),
  /** Phase 2C: per-user "delete conversation". Hides the chat
   * from the caller's list (sets hidden_at on their member row).
   * The peer is unaffected and their copy of the history is
   * intact. If the peer sends a new message later, the
   * conversation re-appears for the caller — WhatsApp behaviour.
   * 204. */
  deleteConversation: (conversationId: number) =>
    request<void>(`/api/conversations/${conversationId}`, {
      method: "DELETE",
    }),
  /** Phase 2C: soft-delete a single message. Author-only — the
   * server returns 404 if the caller isn't the author (we don't
   * differentiate from "message doesn't exist" to avoid leaking
   * existence). Sets deleted_at AND empties body in the DB; the
   * peer sees "(mensaje borrado)" in the bubble. 204. */
  deleteMessage: (conversationId: number, messageId: number) =>
    request<void>(
      `/api/conversations/${conversationId}/messages/${messageId}`,
      { method: "DELETE" },
    ),
  /** Migration 0088. Create a group conversation. Caller is
   * implicitly added; `member_person_ids` is at least 1 other
   * person from the caller's hospital. Returns the new
   * conversation (kind="group"). */
  createGroupChat: (body: { title: string; member_person_ids: number[] }) =>
    request<Conversation>("/api/group-chats", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Migration 0088. Rename a group. Any member can do it. 400 on
   * DMs (they don't have a title). */
  renameGroupChat: (conversationId: number, title: string) =>
    request<Conversation>(
      `/api/conversations/${conversationId}`,
      { method: "PATCH", body: JSON.stringify({ title }) },
    ),
  /** Migration 0088. Add members to a group. Any member can add.
   * Idempotent on already-members. New members start with the
   * unread counter at zero — they see history but no badge spike. */
  addGroupMembers: (conversationId: number, personIds: number[]) =>
    request<Conversation>(
      `/api/conversations/${conversationId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ person_ids: personIds }),
      },
    ),
  /** Migration 0088. Remove a member from a group. Self-removal
   * always allowed; removing someone else is creator-only. 204. */
  removeGroupMember: (conversationId: number, personId: number) =>
    request<void>(
      `/api/conversations/${conversationId}/members/${personId}`,
      { method: "DELETE" },
    ),
  /** Migration 0088. Sugar for self-removal. 204. */
  leaveGroupChat: (conversationId: number) =>
    request<void>(`/api/conversations/${conversationId}/leave`, {
      method: "POST",
    }),
  /** Migration 0089. VAPID public key for the service worker to
   * subscribe with. 503 if push isn't configured server-side; the
   * frontend treats that as "feature disabled in this environment". */
  getVapidPublicKey: () =>
    request<{ public_key: string }>("/api/push/vapid-public-key"),
  /** Migration 0089. List the caller's push subscriptions for the
   * Notificaciones panel. Endpoint values intentionally omitted —
   * the frontend matches "this device" by id stored in
   * localStorage at subscribe time. */
  listMyPushSubscriptions: () =>
    request<PushSubscriptionItem[]>("/api/push/subscriptions"),
  /** Migration 0089. Upsert one device subscription (idempotent on
   * endpoint). Returns the row id so the caller can store it
   * locally as the "this device" marker. */
  createPushSubscription: (body: {
    endpoint: string;
    p256dh: string;
    auth: string;
    user_agent: string | null;
  }) =>
    request<{ id: number }>("/api/push/subscriptions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Migration 0089. Caller revokes one of their own
   * subscriptions. 204 even on a missing/foreign id. */
  deletePushSubscription: (subscriptionId: number) =>
    request<void>(`/api/push/subscriptions/${subscriptionId}`, {
      method: "DELETE",
    }),
  /** Migration 0090. Current ISO week's pulse questions + my
   * partial answers. Always returns a question set even when
   * pulse is disabled — the frontend uses `enabled` to gate the
   * form. */
  getPulseCurrentWeek: () =>
    request<PulseCurrentWeek>("/api/pulse/current-week"),
  /** Migration 0090. Upsert one or more answers for the current
   * week. Server validates each (key, score) pair against the
   * week's question catalogue. 410 if pulse is disabled. */
  postPulseResponses: (
    answers: { question_key: string; score: number }[],
  ) =>
    request<void>("/api/pulse/responses", {
      method: "POST",
      body: JSON.stringify({ answers }),
    }),
  /** Migration 0090. My historical responses for the self-history
   * line chart at the bottom of /me/pulso. Default 12 weeks,
   * capped at 52 server-side. */
  getPulseHistory: (weeks: number = 12) =>
    request<PulseHistoryItem[]>(
      `/api/pulse/my-history?weeks=${weeks}`,
    ),
  /** Migration 0090. Admin reads the tenant's pulse on/off state
   * + last fan-out week. 403 if caller isn't an admin. */
  getAdminPulseSettings: () =>
    request<PulseAdminSettings>("/api/admin/pulse/settings"),
  /** Migration 0090. Admin flips the toggle. Returns the same
   * shape as GET. */
  patchAdminPulseSettings: (body: { enabled: boolean }) =>
    request<PulseAdminSettings>("/api/admin/pulse/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Migration 0090. Full question catalogue — every core + every
   * rotating question, with flags marking which ones land in the
   * current ISO week and the per-tenant override state (custom
   * prompt + enabled/disabled). */
  getAdminPulseCatalogue: () =>
    request<PulseCatalogue>("/api/admin/pulse/catalogue"),
  /** Migration 0091. Apply a per-question override. `prompt=null`
   * (or empty string) clears the rewording. `enabled=false`
   * disables the question. Returns the fresh catalogue. 422 if
   * the change would leave this week with zero questions. */
  patchAdminPulseQuestion: (
    questionKey: string,
    body: { prompt?: string | null; enabled?: boolean },
  ) =>
    request<PulseCatalogue>(
      `/api/admin/pulse/catalogue/${encodeURIComponent(questionKey)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  /** Admin-only: read the tenant's editable settings (display name,
   * read-only slug + hospital name). */
  getAdminTenantSettings: () =>
    request<AdminTenantSettings>("/api/admin/tenant"),
  /** Admin-only: rename the tenant. Slug stays frozen — URLs and
   * the tenant picker keep working unchanged. */
  patchAdminTenantSettings: (body: { name: string }) =>
    request<AdminTenantSettings>("/api/admin/tenant", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Migration 0090. Aggregated stats for the admin dashboard.
   * Server defaults to a trailing 26-week window when neither
   * from/to is supplied. */
  getAdminPulseStats: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from_week", params.from);
    if (params?.to) qs.set("to_week", params.to);
    const q = qs.toString();
    return request<PulseAdminStats>(
      `/api/admin/pulse/stats${q ? `?${q}` : ""}`,
    );
  },
  updateProfile: (body: {
    /** Legacy single-field name. Sprint 18+ clients should send
     * first_name + last_name instead; the server composes `name`
     * from them. */
    name?: string;
    first_name?: string;
    last_name?: string;
    /** Migration 0057: two free-format phones (up to 50 chars). Pass
     * an empty string to clear a field; omit the key to leave it
     * unchanged. Patch one or both per call. */
    work_phone?: string;
    personal_phone?: string;
    /** Migration 0061: replace the entire list of cargos shown on
     * the directory card. Pass an empty array to clear all; omit
     * the key to leave them alone. Max 10 entries; each capped
     * server-side at 120 chars. */
    cargos?: string[];
  }) =>
    request<Person>("/api/me/profile", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  /** Migration 0065: persist the caller's accent colour preference.
   * Returns the updated Person so the /me query cache can be primed
   * without a round-trip. The frontend also writes the new value to
   * the trivu_accent cookie + sets CSS variables on documentElement
   * so the change is immediately visible. */
  updateAppearance: (body: { preferred_accent: string }) =>
    request<Person>("/api/me/appearance", {
      method: "PATCH",
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
  /** Migration 0087. Start the admin-promotion consent flow for
   * a member. Under members_pay this is required instead of a
   * direct PUT roles change because their Stripe price moves.
   * Server creates a pending request and emails the target
   * accept / decline links. 409 if there's already a pending
   * request for this person. */
  createAdminPromotion: (membershipId: number) =>
    request<AdminPromotionRequestData>(
      `/api/team/${membershipId}/admin-promotion`,
      { method: "POST" },
    ),
  /** List pending + recently-decided promotions in the tenant.
   * Drives the modal hint when there's already a pending request
   * for the member being edited. */
  listAdminPromotions: () =>
    request<AdminPromotionRequestData[]>("/api/admin-promotions"),
  /** Admin withdraws a pending request. 204 on success; idempotent
   * on already-decided rows. */
  cancelAdminPromotion: (id: number) =>
    request<void>(`/api/admin-promotions/${id}`, { method: "DELETE" }),
  /** Public — token-only. What the /confirm-admin-promotion
   * landing page reads to render the "X wants to promote you"
   * card before the target accepts / declines. */
  previewAdminPromotion: (token: string) =>
    request<AdminPromotionPreviewData>(
      `/api/admin-promotion/preview?token=${encodeURIComponent(token)}`,
    ),
  /** Public — token-only. Accept the promotion: grants the role
   * AND triggers Stripe item swap under members_pay. Idempotent
   * on already-accepted. */
  acceptAdminPromotion: (token: string) =>
    request<AdminPromotionPreviewData>(
      `/api/admin-promotion/accept?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    ),
  /** Public — token-only. Decline: just flips status, no role
   * change, no Stripe call. Idempotent. */
  declineAdminPromotion: (token: string) =>
    request<AdminPromotionPreviewData>(
      `/api/admin-promotion/decline?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    ),
  /** Issue a fresh invitation for an EXISTING pendiente Membership.
   * Used by the per-row "Enviar invitación" button on /admin/team.
   * Server revokes any prior live invites for this email, creates a
   * new one, emails it, and returns the accept_url so the admin can
   * copy it manually if SMTP fails. Rejects 400 if the member has
   * already activated their account. */
  issueMembershipInvitation: (membershipId: number) =>
    request<InviteCreateResponse>(
      `/api/team/${membershipId}/invitation`,
      { method: "POST" },
    ),
  /** Admin tool: flip an activated member back to "pendiente"
   * by clearing their password. Used during onboarding when the
   * admin signed up the test account with their own email and
   * needs to hand it over to the real clinician — after this
   * the email field becomes editable again and "Enviar
   * invitación" works as for a fresh row. */
  resetMembershipToPendiente: (membershipId: number) =>
    request<TeamMember>(
      `/api/team/${membershipId}/reset-to-pendiente`,
      { method: "POST" },
    ),
  inviteTeamMember: (body: {
    email: string;
    person_name: string;
    category_id?: number | null;
    roles?: string[];
    /** When false, the server creates the Person + Membership +
     * Invitation row but does NOT send the activation email. Used
     * by the onboarding /team step so the admin can capture the
     * roster up-front and trigger the email blast later from
     * /admin/team. Default true (preserves the previous behaviour
     * for /admin/team/invite). */
    send_email?: boolean;
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
      /** Optional cargos (migration 0061). Applied only on first-
       * time activation; cross-tenant accepts ignore this field
       * since they don't touch existing person data. Omit the key
       * to leave cargos unchanged. */
      cargos?: string[];
      /** Affirmative ToS + Privacy acceptance. Server rejects
       * with 422 if missing or false. */
      accept_terms: boolean;
      /** Migration 0080 / billing chunk 8. Only consulted under
       * `members_pay`: true = start a 30-day personal trial,
       * false = stay on paper. Under `team_pays` ignored — the
       * server flips the invitee straight to 'active'. Omit
       * entirely for old clients (server treats as false). */
      start_trial?: boolean;
    },
  ) =>
    request<AuthResponse>(
      `/api/invitations/by-token/${encodeURIComponent(token)}/accept`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  // Billing (migration 0080 / docs/billing-plan.md).
  // Called from /onboarding/done (initial pick) and /admin/billing
  // (post-signup switch). Admin-only on the backend.
  updateBillingModel: (billing_model: "members_pay" | "team_pays") =>
    request<{ billing_model: "members_pay" | "team_pays" }>(
      "/api/billing/model",
      {
        method: "PATCH",
        body: JSON.stringify({ billing_model }),
      },
    ),
  // /admin/billing summary. Admin-only — drives the plan card,
  // seat breakdown, status banner, and Customer Portal button.
  getBillingSummary: () =>
    request<BillingSummary>("/api/billing/summary"),
  // Opens a one-shot Stripe Customer Portal session for the
  // tenant. Returns the URL the frontend redirects to; Stripe
  // sends the user back to /admin/billing afterwards. 409 if the
  // tenant has no Stripe Customer yet (grandfathered / never-
  // checked-out trial).
  openBillingPortal: () =>
    request<{ url: string }>("/api/billing/portal", { method: "POST" }),
  /** Activate the tenant subscription for the first time. Returns
   * the Stripe Checkout URL the frontend redirects to; Stripe
   * collects the card, creates Customer + Subscription, then
   * sends the admin back to /admin/billing?activated=1. */
  activateBilling: () =>
    request<{ url: string }>("/api/billing/activate", { method: "POST" }),
  // /me/billing payload. Any role; reports the person's own
  // subscription state in the current tenant context.
  getMyBilling: () => request<MyBilling>("/api/billing/me"),
  openMyBillingPortal: () =>
    request<{ url: string }>("/api/billing/me/portal", { method: "POST" }),
  /** Member's first activation under members_pay. Returns the
   * Stripe Checkout URL to redirect to; Stripe handles the card +
   * Customer + Subscription and sends the member back to
   * /me/billing?activated=1. */
  activateMyBilling: () =>
    request<{ url: string }>("/api/billing/me/activate", { method: "POST" }),

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
    person_ids: number[];
    /** Migration 0066: optional email reminder offset. Pass null
     * (or omit) to disable. */
    reminder_minutes_before?: ReminderMinutesBefore | null;
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
      person_ids: number[];
      reminder_minutes_before?: ReminderMinutesBefore | null;
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
    person_ids: number[];
    reminder_minutes_before?: ReminderMinutesBefore | null;
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
      person_ids: number[];
      reminder_minutes_before?: ReminderMinutesBefore | null;
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
    /** Onboarding step 1 sets this — gates the /admin/trasplantes
     * module visibility and the related API endpoints. */
    transplants_enabled?: boolean;
    /** /admin/swaps writes this. Pass null to clear (= unlimited);
     * pass a non-negative integer to cap fulfilled swaps per member
     * per monthly schedule. */
    max_swaps_per_member_per_month?: number | null;
    /** /admin/swaps writes this. Opt-in admin approval / veto for
     * every fulfilled cambio. */
    swap_requires_admin_approval?: boolean;
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
  /** Commit 1 of the stats overhaul. One round-trip payload powering
   * the KPI strip, equity histogram, coverage trend, and trend mini-
   * charts on /admin/stats. The existing statsAssignments call still
   * feeds the "Detalle por actividad" section underneath. */
  statsOverview: (params: { from: string; to: string }) => {
    const qs = new URLSearchParams();
    qs.set("from", params.from);
    qs.set("to", params.to);
    return request<StatsOverviewResponse>(
      `/api/stats/overview?${qs.toString()}`,
    );
  },
  /** Commit 3 of the stats overhaul. Per-(person, day) shift counts +
   * bloqueo overlay for the calendar heat map. Sparse payload (only
   * days with activity), so a 100-person year-view is still ~1.5 MB
   * gzipped — fine for an admin-only surface. */
  statsCalendar: (params: { from: string; to: string }) => {
    const qs = new URLSearchParams();
    qs.set("from", params.from);
    qs.set("to", params.to);
    return request<StatsCalendarResponse>(
      `/api/stats/calendar?${qs.toString()}`,
    );
  },
  /** Same shape as statsAssignments but scoped to the caller. No
   * admin gate — every member can see their own breakdown. Drives
   * /me/estadisticas. */
  myStatsAssignments: (params: { from: string; to: string }) => {
    const qs = new URLSearchParams();
    qs.set("from", params.from);
    qs.set("to", params.to);
    return request<StatsResponse>(
      `/api/me/stats/assignments?${qs.toString()}`,
    );
  },

  // Team absences (public, read-only). Used by the Libre row in
  // the planning grid; visible to any authenticated user.
  listTeamAbsences: (params?: {
    from?: string;
    to?: string;
  }) => {
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
    /** Migration 0083. Required — the chosen admin who will
     * review this bloqueo. Must reference a membership returned
     * by listMyServicioAdmins(). Backend 422s on missing/invalid
     * values. */
    reviewer_membership_id: number;
  }) =>
    request<AvailabilityBlock>("/api/me/availability-requests", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteMyAvailabilityRequest: (id: number) =>
    request<void>(`/api/me/availability-requests/${id}`, { method: "DELETE" }),
  /** Migration 0083 + 0085. Picker source for the reviewer
   * dropdown on the /me/bloqueos create modal. Returns the
   * servicio routing mode AND the candidate admins. When mode is
   * 'centralised' AND a Jefe de Servicio resolves, `admins`
   * collapses to that single membership and the UI renders a
   * read-only "Se enviará a X" line instead of the dropdown. */
  listMyServicioAdmins: () =>
    request<ServicioAdminPicker>("/api/me/servicio/admins"),
  /** Migration 0085. Read the bloqueo routing mode for the
   * caller's servicio. Jefe-only — returns 403 to non-jefes.
   * Used by /admin/compartir to render (or hide) the toggle. */
  getBloqueoRouting: () =>
    request<BloqueoRouting>("/api/servicios/me/bloqueo-routing"),
  /** Migration 0085. Flip the bloqueo routing mode. Jefe-only.
   * Setting 'centralised' with no jefe currently in place is
   * allowed — create_my_request silently falls back to delegated
   * until a jefe reappears, so the toggle can be pre-armed. */
  updateBloqueoRouting: (body: { mode: "delegated" | "centralised" }) =>
    request<BloqueoRouting>("/api/servicios/me/bloqueo-routing", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
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
  getSchedule: (id: number) => request<ScheduleDetail>(`/api/schedules/${id}`),
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
  // Shift swaps
  listSwapOffers: (opts?: { mine?: boolean; status?: SwapOfferStatus }) => {
    const qs = new URLSearchParams();
    if (opts?.mine) qs.set("mine", "true");
    if (opts?.status) qs.set("status_", opts.status);
    const q = qs.toString();
    return request<SwapOffer[]>(`/api/swap-offers${q ? `?${q}` : ""}`);
  },
  createSwapOffer: (body: {
    assignment_id: number;
    notes?: string | null;
    /** Migration 0063: explicit list of membership ids who should
     * see + receive + respond to this offer. Frontend resolves
     * "by categoría" into a flat id list before submitting. Omit
     * (or pass null) for "the whole team" — back-compat. */
    audience_membership_ids?: number[] | null;
    /** Migration 0064: which response kinds the requester will
     * entertain. Default "either" preserves legacy behaviour. */
    accepts?: SwapOfferAccepts;
  }) =>
    request<SwapOffer>("/api/swap-offers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Membership ids configured (in the actividad's settings) to
   * cover the given assignment's slot. Honours per-slot allow-list,
   * slot categoría, and per-role categoría. Used by the
   * Pedir cobertura modal to narrow the audience picker. Only the
   * assignment's own person may call this. */
  listEligibleCoverers: (assignmentId: number) =>
    request<number[]>(
      `/api/swap-offers/eligible-coverers/${assignmentId}`,
    ),
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
  /** Migration 0084. Admin approves a swap parked in pending_admin.
   * Server re-runs eligibility + charges the requester's quota; on
   * any failure (schedule changed, requester at cap, etc.) the
   * response is 400 — the admin should then veto with a note. */
  adminApproveSwapResponse: (offerId: number, responseId: number) =>
    request<SwapOffer>(
      `/api/swap-offers/${offerId}/responses/${responseId}/admin-approve`,
      { method: "POST" },
    ),
  /** Migration 0084. Admin vetoes a swap parked in pending_admin.
   * `scope: "response_only"` declines this response only and
   * reopens the offer (another colleague can step in);
   * `scope: "entire_offer"` closes the offer for good and declines
   * every still-pending sibling response. `notes` is shown to both
   * the requester and the responder in the veto email. */
  adminVetoSwapResponse: (
    offerId: number,
    responseId: number,
    body: { scope: SwapVetoScope; notes?: string | null },
  ) =>
    request<SwapOffer>(
      `/api/swap-offers/${offerId}/responses/${responseId}/admin-veto`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Per-person view of swap usage in a given month.
   *
   * `period` is YYYY-MM. `used` is the number of fulfilled offers
   * the caller REQUESTED in that month (responders are not charged).
   * `limit` mirrors tenant.max_swaps_per_member_per_month (null =
   * unlimited). The frontend renders "X de N cambios este mes" and
   * disables swap actions when used >= limit. */
  getMySwapQuota: (period: string) =>
    request<{ period: string; used: number; limit: number | null }>(
      `/api/me/swap-quota?period=${encodeURIComponent(period)}`,
    ),
  patchAssignment: (
    scheduleId: number,
    assignmentId: number,
    body: { person_id?: number | null; clear_person?: boolean; team_role_id?: number | null },
  ) =>
    request<AssignmentSaveResponse>(
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
    request<AssignmentSaveResponse>(
      `/api/schedules/${scheduleId}/assignments`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  /** Full list of rule breaches in the schedule's current
   * assignments. Used by /admin/schedule/[id] for the banner +
   * per-cell markers. Warnings only — never blocks. Each entry
   * carries `signature` (stable hash) + `suppressed_at` so the
   * banner can hide entries the admin has overruled. */
  listScheduleViolations: (scheduleId: number) =>
    request<Violation[]>(`/api/schedules/${scheduleId}/violations`),
  /** Hide ("overrule") a specific rule violation on this schedule.
   * Admin-only on the server. Pass the `signature` from the GET
   * response verbatim. Idempotent (re-submitting is a no-op). 204. */
  suppressScheduleViolation: (
    scheduleId: number,
    body: { signature: string; kind: ViolationKind },
  ) =>
    request<void>(
      `/api/schedules/${scheduleId}/violations/suppress`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Un-hide a previously suppressed violation. Idempotent — 204
   * even if no matching row exists. */
  unsuppressScheduleViolation: (
    scheduleId: number,
    signature: string,
  ) =>
    request<void>(
      `/api/schedules/${scheduleId}/violations/suppressions/${signature}`,
      { method: "DELETE" },
    ),
  /** Phase C.2: servicio metadata + list of peer equipos with their
   * share_policy + approval_state. The caller must belong to the
   * servicio (any non-pending member of any equipo in it). 404
   * otherwise — we don't leak servicio ids. */
  getServicio: (servicioId: number) =>
    request<Servicio>(`/api/servicios/${servicioId}`),
  /** Phase C.2: cross-equipo timeline for [from, to] (date strings
   * YYYY-MM-DD inclusive). Returns flat cells; the page groups
   * client-side. Range capped server-side at 366 days. */
  getServicioTimeline: (
    servicioId: number,
    from: string,
    to: string,
  ) => {
    const qs = new URLSearchParams({ from, to });
    return request<ServicioTimeline>(
      `/api/servicios/${servicioId}/timeline?${qs.toString()}`,
    );
  },
  /** Phase C.2: persons across every approved Equipo in a
   * Servicio. Drives the cross-equipo meeting invitee picker.
   * Caller's own tenant is included with is_caller_tenant=true so
   * the UI can render two sections from one response. */
  getServicioPersons: (servicioId: number) =>
    request<ServicioPerson[]>(`/api/servicios/${servicioId}/persons`),
  /** Phase C.2: set the caller's own equipo share_policy. Admin-
   * only on the server. The per-slot picker (when 'selected')
   * lives on the slot itself — PATCH /api/slots/{id} accepts
   * shared_with_servicio. */
  updateMySharePolicy: (body: { share_policy: SharePolicy }) =>
    request<void>(`/api/equipos/me/share-policy`, {
      method: "PATCH",
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
  /** Mark a (slot, date) as "No aplica" — cascades to every sibling
   * row of the same (slot, date) so a single click dismisses the
   * full activity for that day. Dismissed rows are auto-locked so
   * the lock-carry mechanism preserves them across regeneration. */
  dismissAssignment: (scheduleId: number, assignmentId: number) =>
    request<Assignment>(
      `/api/schedules/${scheduleId}/assignments/${assignmentId}/dismiss`,
      { method: "POST" },
    ),
  /** Revert "No aplica" for this (slot, date). Cascades to every
   * sibling row and also clears the auto-lock so the next regenerate
   * can re-populate the cell from rules. */
  undismissAssignment: (scheduleId: number, assignmentId: number) =>
    request<Assignment>(
      `/api/schedules/${scheduleId}/assignments/${assignmentId}/dismiss`,
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
  /** Commit a previously-validated bulk-import preview.
   *
   * `sendEmail` defaults to true (the /admin/team behaviour: create
   * + email immediately). The onboarding /team step opts out with
   * `false`: the rows are still created as pendiente Members but no
   * invitation email goes out. The admin sends them later from
   * /admin/team's per-row "Enviar invitación" button.
   */
  bulkInviteCommit: (
    rows: BulkCommitRow[],
    options?: { sendEmail?: boolean },
  ) =>
    request<BulkCommitResponse>("/api/team/invite/bulk/commit", {
      method: "POST",
      body: JSON.stringify({
        rows,
        send_email: options?.sendEmail ?? true,
      }),
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

  // Transplant case log (admin-only). Cases carry their full
  // set of procedures on every read AND on every write — the
  // server replaces procedures atomically on PUT, so callers
  // re-send the whole list.
  listTransplants: (params?: {
    from?: string;
    to?: string;
    person_id?: number;
    type?: TransplantProcedureType;
    cross_hospital?: boolean;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (params?.person_id !== undefined)
      qs.set("person_id", String(params.person_id));
    if (params?.type) qs.set("type", params.type);
    if (params?.cross_hospital !== undefined)
      qs.set("cross_hospital", String(params.cross_hospital));
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.toString();
    return request<TransplantCase[]>(
      "/api/transplants" + (suffix ? `?${suffix}` : ""),
    );
  },
  getTransplant: (id: number) =>
    request<TransplantCase>(`/api/transplants/${id}`),
  createTransplant: (body: TransplantCaseInput) =>
    request<TransplantCase>("/api/transplants", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateTransplant: (id: number, body: TransplantCaseInput) =>
    request<TransplantCase>(`/api/transplants/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteTransplant: (id: number) =>
    request<void>(`/api/transplants/${id}`, { method: "DELETE" }),
  transplantStats: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const suffix = qs.toString();
    return request<TransplantStats>(
      "/api/transplants/stats" + (suffix ? `?${suffix}` : ""),
    );
  },

  // -------------------------------------------------------------
  // Vacation periods: V.2.5 model — per-(period, slot) full snapshot
  // of slot+rules config, plus succession + cap delta overrides.
  // Admin-only on every endpoint. Non-overlap of periodos per tenant
  // is enforced server-side; createPeriodo / updatePeriodo surface
  // the conflict as a 422 the caller can render verbatim.
  // -------------------------------------------------------------
  listPeriodos: () => request<Periodo[]>("/api/periodos"),
  createPeriodo: (body: { name: string; start_date: string; end_date: string }) =>
    request<Periodo>("/api/periodos", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getPeriodo: (periodId: number) =>
    request<Periodo>(`/api/periodos/${periodId}`),
  updatePeriodo: (
    periodId: number,
    body: { name?: string; start_date?: string; end_date?: string },
  ) =>
    request<Periodo>(`/api/periodos/${periodId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deletePeriodo: (periodId: number) =>
    request<void>(`/api/periodos/${periodId}`, { method: "DELETE" }),
  /** One-button multi-month solve. Returns one row per Schedule
   * created (one per touched month). 409 if any touched month
   * already has a published or archived schedule — caller has to
   * archive/delete it first. */
  generatePeriodo: (periodId: number) =>
    request<GeneratePeriodResult[]>(
      `/api/periodos/${periodId}/generate`,
      { method: "POST" },
    ),

  // Succession + frequency cap delta overrides. They stay as deltas
  // (vs the slot snapshot below) because both rules are tenant-scoped
  // cross-slot — the snapshot framing doesn't fit them.
  listSuccessionPeriodOverrides: (periodId: number) =>
    request<SuccessionPeriodOverride[]>(
      `/api/periodos/${periodId}/succession-overrides`,
    ),
  upsertSuccessionPeriodOverride: (
    periodId: number,
    successionRuleId: number,
    body: SuccessionPeriodOverrideUpsert,
  ) =>
    request<SuccessionPeriodOverride>(
      `/api/periodos/${periodId}/succession-overrides/${successionRuleId}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  deleteSuccessionPeriodOverride: (
    periodId: number,
    successionRuleId: number,
  ) =>
    request<void>(
      `/api/periodos/${periodId}/succession-overrides/${successionRuleId}`,
      { method: "DELETE" },
    ),
  // Period-only succession rules. Complements the override endpoints
  // above — those edit existing global rules for the period; these
  // create brand-new rules that only fire inside the period.
  listSuccessionPeriodExtras: (periodId: number) =>
    request<SuccessionPeriodExtra[]>(
      `/api/periodos/${periodId}/succession-extras`,
    ),
  createSuccessionPeriodExtra: (
    periodId: number,
    body: SuccessionPeriodExtraIn,
  ) =>
    request<SuccessionPeriodExtra>(
      `/api/periodos/${periodId}/succession-extras`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  updateSuccessionPeriodExtra: (
    periodId: number,
    extraId: number,
    body: SuccessionPeriodExtraIn,
  ) =>
    request<SuccessionPeriodExtra>(
      `/api/periodos/${periodId}/succession-extras/${extraId}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  deleteSuccessionPeriodExtra: (periodId: number, extraId: number) =>
    request<void>(
      `/api/periodos/${periodId}/succession-extras/${extraId}`,
      { method: "DELETE" },
    ),
  listCapPeriodOverrides: (periodId: number) =>
    request<CapPeriodOverride[]>(
      `/api/periodos/${periodId}/cap-overrides`,
    ),
  upsertCapPeriodOverride: (
    periodId: number,
    capId: number,
    body: CapPeriodOverrideUpsert,
  ) =>
    request<CapPeriodOverride>(
      `/api/periodos/${periodId}/cap-overrides/${capId}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  deleteCapPeriodOverride: (periodId: number, capId: number) =>
    request<void>(
      `/api/periodos/${periodId}/cap-overrides/${capId}`,
      { method: "DELETE" },
    ),

  // V.2.5 — per-(period, slot) full snapshot of slot+rules config.
  // Replaces the V.1 SlotPeriodOverride + V.2 RulePeriodOverride
  // endpoints. The PUT payload mirrors the /api/slots PUT shape
  // (SlotInput + rules-replace), with a `dismissed` bool at the top
  // level. The frontend's SlotDialog produces both payloads from the
  // same form. DELETE reverts the slot to its defaults for the period.
  listSlotPeriodSnapshots: (periodId: number) =>
    request<SlotPeriodSnapshot[]>(
      `/api/periodos/${periodId}/slot-snapshots`,
    ),
  upsertSlotPeriodSnapshot: (
    periodId: number,
    slotId: number,
    body: SlotPeriodSnapshotUpsert,
  ) =>
    request<SlotPeriodSnapshot>(
      `/api/periodos/${periodId}/slot-snapshots/${slotId}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  deleteSlotPeriodSnapshot: (periodId: number, slotId: number) =>
    request<void>(
      `/api/periodos/${periodId}/slot-snapshots/${slotId}`,
      { method: "DELETE" },
    ),
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
  /** Structured names from the underlying Person row when one
   * already exists for this email (pendiente migrated users,
   * cross-tenant invitees). Null on fresh invites where the
   * admin only typed a composite name — accept page falls back
   * to splitting person_name in that case. */
  first_name: string | null;
  last_name: string | null;
  expires_at: string;
  /** Migration 0080. Lets the accept page render the right
   * billing flow — short notice under team_pays, trial-vs-paper
   * picker under members_pay. Defaults to "members_pay" if the
   * server is on an older schema. */
  tenant_billing_model: "members_pay" | "team_pays";
};

// ---------------------------------------------------------------------------
// Transplant case log
//
// A "case" is one transplant patient / one organ. Usually 1–2
// procedures (EXPLANTE = donor extraction, IMPLANTE = recipient
// surgery). Cross-hospital cases have just one local procedure
// and a NULL primary surgeon on the missing half — the backend's
// is_cross_hospital convenience flag surfaces that for the UI.
// ---------------------------------------------------------------------------

export type TransplantProcedureType = "explante" | "implante";

export type TransplantProcedure = {
  id: number;
  type: TransplantProcedureType;
  occurred_at: string;
  primary_person_id: number | null;
  primary_person_name: string | null;
  secondary_person_id: number | null;
  secondary_person_name: string | null;
  notes: string | null;
};

export type TransplantProcedureInput = {
  type: TransplantProcedureType;
  occurred_at: string;
  primary_person_id: number | null;
  secondary_person_id: number | null;
  notes: string | null;
};

export type TransplantCase = {
  id: number;
  tenant_id: number;
  external_case_id: string | null;
  occurred_on: string;
  notes: string | null;
  procedures: TransplantProcedure[];
  has_explante: boolean;
  has_implante: boolean;
  is_cross_hospital: boolean;
  created_at: string;
  updated_at: string;
};

export type TransplantCaseInput = {
  external_case_id: string | null;
  notes: string | null;
  procedures: TransplantProcedureInput[];
};

export type TransplantStatsMonthSurgeon = {
  person_id: number;
  count: number;
};

export type TransplantStatsMonth = {
  period: string;
  explante_count: number;
  implante_count: number;
  cross_hospital_count: number;
  /** Sprint 28: per-surgeon attribution counts for this month.
   * Each procedure contributes +1 for primary and +1 for
   * secondary independently (matches the per-surgeon totals
   * chart). Used by the "Procedimientos por mes y cirujano"
   * stacked chart. Empty on older backends. */
  per_surgeon?: TransplantStatsMonthSurgeon[];
};

export type TransplantStatsSurgeon = {
  person_id: number;
  person_name: string;
  /** Sum of explante_primary + implante_primary. Drives the
   * default sort on the page. */
  primary_count: number;
  /** Sum of explante_secondary + implante_secondary. */
  secondary_count: number;
  explante_primary: number;
  explante_secondary: number;
  implante_primary: number;
  implante_secondary: number;
};

export type TransplantStats = {
  total_cases: number;
  total_procedures: number;
  explante_total: number;
  implante_total: number;
  cross_hospital_cases: number;
  months: TransplantStatsMonth[];
  surgeons: TransplantStatsSurgeon[];
};

// ---------------------------------------------------------------------------
// Vacation V.1: periodos especiales + slot overrides.
//
// A Periodo defines a date range (inclusive on both ends) during which
// the scheduler applies modified slot/rule config. V.1 ships slot
// overrides (headcount, dismiss, allow-lists). Rule/succession/cap
// overrides land in V.2.
// ---------------------------------------------------------------------------

export type Periodo = {
  id: number;
  tenant_id: number;
  name: string;
  /** YYYY-MM-DD, inclusive. */
  start_date: string;
  /** YYYY-MM-DD, inclusive. */
  end_date: string;
  created_at: string;
};

/** GET /api/founder/tenants — one row per signed-up equipo, with
 * cross-tenant rollups. Backend is gated on Person.is_founder, so
 * regular users never see this data. */
export type FounderTenantSummary = {
  id: number;
  name: string;
  slug: string;
  /** Parent hospital name. Null on legacy standalone tenants. */
  hospital_name: string | null;
  /** Servicio (department) name. Null on pre-Hospital-layer tenants. */
  servicio_name: string | null;
  /** tenants.created_at — when the equipo signed up. */
  signup_date: string;
  /** ACTIVATED + non-disabled memberships only. Matches the
   * "active roster" definition used by /admin/team. */
  members_count: number;
  /** Subset of members_count whose roles array includes 'admin'. */
  admins_count: number;
  /** MAX(persons.last_login_at) across the equipo's roster.
   * Null = nobody has logged in yet (or pre-migration-0079 accounts
   * that haven't logged in since). */
  last_login_at: string | null;
  /** MAX(schedules.published_at) for the tenant. Null = nothing
   * published yet. */
  last_schedule_published_at: string | null;
  /** Live invitations: not accepted, not revoked, not expired. */
  pending_invitations_count: number;
};

/** One element of the array returned by POST /api/periodos/{id}/generate.
 * One row per Schedule the generate produced (one per touched month). */
export type GeneratePeriodResult = {
  schedule_id: number;
  /** YYYY-MM-01 — the Schedule.period column on the server. */
  period: string;
  /** Which solver produced the result. Same shape as Schedule. */
  solver_used: string;
  assignments_created: number;
};

// Succession + frequency cap delta overrides. The slot+rule deltas
// got replaced by the snapshot model below in V.2.5; these two
// surfaces remain because both rules are tenant-scoped cross-slot
// and don't fit the snapshot framing.

export type SuccessionPeriodOverride = {
  id: number;
  period_id: number;
  succession_rule_id: number;
  /** NULL = keep the rule's default days_after. Non-null = use this
   * gap (0..14) during the period — useful for shortening or
   * widening the forbidden window. */
  days_after_override: number | null;
  /** NULL = keep severity. 'soft' downgrades a 'hard' rule to a
   * penalty (the solver may break it if necessary). */
  severity_override: "hard" | "soft" | null;
  disabled: boolean;
};

export type SuccessionPeriodOverrideUpsert = {
  days_after_override?: number | null;
  severity_override?: "hard" | "soft" | null;
  disabled?: boolean;
};

/** A brand-new succession rule that exists ONLY during one periodo
 * especial. Covers cases the override model can't: needing a rule
 * during the period when no global rule exists. */
export type SuccessionPeriodExtra = {
  id: number;
  period_id: number;
  after_slot_id: number;
  forbid_slot_id: number;
  after_team_role_id: number | null;
  forbid_team_role_id: number | null;
  /** 0 = same-day incompatibility, 1..14 = "after X, no Y for N days". */
  days_after: number;
  severity: "hard" | "soft";
  weight: number;
};

export type SuccessionPeriodExtraIn = {
  after_slot_id: number;
  forbid_slot_id: number;
  after_team_role_id?: number | null;
  forbid_team_role_id?: number | null;
  days_after: number;
  severity: "hard" | "soft";
  weight?: number;
};

export type CapPeriodOverride = {
  id: number;
  period_id: number;
  cap_id: number;
  /** NULL = keep the cap's default max_count. Non-null = use this
   * ceiling during the period (e.g. 2 guardias/month → 5/month
   * during summer when 60% of the team is out). */
  max_count_override: number | null;
  severity_override: "hard" | "soft" | null;
  disabled: boolean;
};

export type CapPeriodOverrideUpsert = {
  max_count_override?: number | null;
  severity_override?: "hard" | "soft" | null;
  disabled?: boolean;
};

// Per-(period, slot) full snapshot of slot+rules config. Replaces
// the V.1 SlotPeriodOverride + V.2 RulePeriodOverride delta tables
// (dropped in migration 0077): admin redefines the slot for the
// period, snapshot stores the full config + a `dismissed` flag.

/** Server response shape for a snapshot row. Mirrors `Slot` but
 * scoped to (period_id, slot_id) and with `dismissed` at the top
 * level — when true the slot doesn't run during the period at all.
 * Other fields stay populated so the snapshot stays valid if admin
 * toggles dismissed off later. */
export type SlotPeriodSnapshot = {
  id: number;
  period_id: number;
  slot_id: number;
  dismissed: boolean;
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
  team_roles: SlotTeamRole[];
  allowed_person_ids: number[];
  allowed_category_ids: number[];
  rules: SlotRule[];
  created_at: string;
};

/** Payload for PUT /api/periodos/{id}/slot-snapshots/{slot_id}.
 * Same shape as `SlotInput` minus `name`/`department_id` (the slot
 * keeps those across periods) plus `dismissed`. The rules list fully
 * replaces what's in the snapshot (rules + their child rows) on each
 * upsert. */
export type SlotPeriodSnapshotUpsert = {
  dismissed?: boolean;
  start_time?: string | null;
  end_time?: string | null;
  days_applied: DaysApplied;
  custom_days_bitmap?: number | null;
  staffing_mode: StaffingMode;
  headcount: number;
  post_slot_rest?: boolean;
  counts_for_equity: boolean;
  guardia_type?: string | null;
  color?: string | null;
  team_roles: { role_label: string; headcount: number; category_ids: number[] }[];
  allowed_person_ids: number[];
  allowed_category_ids?: number[];
  rules: SlotRuleInput[];
};
