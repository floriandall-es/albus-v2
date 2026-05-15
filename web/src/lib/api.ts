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
  created_at: string;
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
  solver_used: SolverUsed | null;
  created_at: string;
};

export type Assignment = {
  id: number;
  schedule_id: number;
  slot_id: number;
  slot_name: string;
  slot_color: string | null;
  date: string;
  person_id: number | null;
  person_name: string | null;
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
  name: string;
  locale: string | null;
  avatar_url: string | null;
  created_at: string;
};

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
  does_guardias: boolean;
  guardia_types: string[];
  exemption_type: string | null;
  exemption_until: string | null;
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

export type MembershipMode = "dedicated" | "rotational" | "mixed";

export type Pool = {
  id: number;
  tenant_id: number;
  department_id: number | null;
  name: string;
  membership_mode: MembershipMode;
  equity_independent: boolean;
  member_count: number;
  created_at: string;
};

export type PoolMember = {
  id: number;
  person_id: number;
  person_name: string;
  person_email: string;
  created_at: string;
};

export type PoolDetail = Pool & { members: PoolMember[] };

export type Skill = {
  id: number;
  tenant_id: number;
  name: string;
  description: string | null;
  created_at: string;
};

export type DaysApplied = "all" | "weekdays" | "weekends_holidays" | "custom";
export type StaffingMode = "single" | "multiple_same" | "team_composition";
export type SkillStrength = "hard" | "soft";

export type SlotTeamRole = {
  id: number;
  role_label: string;
  headcount: number;
  category_ids: number[];
};

export type SlotSkillRequired = {
  id: number;
  skill_id: number;
  strength: SkillStrength;
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
  pool_id: number | null;
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
  equity_group_key: string | null;
  color: string | null;
  crosses_midnight: boolean;
  team_roles: SlotTeamRole[];
  skills_required: SlotSkillRequired[];
  rules: SlotRule[];
  created_at: string;
};

export type SlotInput = {
  name: string;
  department_id?: number | null;
  pool_id?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  days_applied: DaysApplied;
  custom_days_bitmap?: number | null;
  staffing_mode: StaffingMode;
  headcount: number;
  post_slot_rest: boolean;
  counts_for_equity: boolean;
  guardia_type?: string | null;
  equity_group_key?: string | null;
  color?: string | null;
  team_roles: { role_label: string; headcount: number; category_ids: number[] }[];
  skills_required: { skill_id: number; strength: SkillStrength }[];
};

export type TeamMember = {
  id: number;
  tenant_id: number;
  person_id: number;
  person_name: string;
  person_email: string;
  person_locale: string | null;
  roles: string[];
  category_id: number | null;
  category_name: string | null;
  fte_pct: number;
  does_guardias: boolean;
  guardia_types: string[];
  exemption_type: string | null;
  exemption_until: string | null;
  created_at: string;
};

export type TeamMemberUpdate = {
  category_id?: number | null;
  fte_pct?: number;
  does_guardias?: boolean;
  guardia_types?: string[];
  exemption_type?: "permanent" | "temporary" | null;
  exemption_until?: string | null;
  roles?: string[];
  clear_exemption?: boolean;
};

export type TenantSummaryCounts = {
  categories: number;
  pools: number;
  skills: number;
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
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return (await res.json()) as T;
}

export const api = {
  signup: (body: {
    tenant_name: string;
    person_name: string;
    email: string;
    password: string;
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
  updateProfile: (body: { name: string }) =>
    request<Person>("/api/me/profile", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  changePassword: (body: { current_password: string; new_password: string }) =>
    request<void>("/api/me/password", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  changeEmail: (body: { current_password: string; new_email: string }) =>
    request<Person>("/api/me/email", {
      method: "POST",
      body: JSON.stringify(body),
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
      throw new Error(
        typeof detail === "string" ? detail : JSON.stringify(detail),
      );
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

  // Pools
  listPools: () => request<Pool[]>("/api/pools"),
  getPool: (id: number) => request<PoolDetail>(`/api/pools/${id}`),
  createPool: (body: {
    name: string;
    department_id?: number | null;
    membership_mode: MembershipMode;
    equity_independent: boolean;
  }) => request<Pool>("/api/pools", { method: "POST", body: JSON.stringify(body) }),
  updatePool: (
    id: number,
    body: {
      name?: string;
      department_id?: number | null;
      membership_mode?: MembershipMode;
      equity_independent?: boolean;
    },
  ) => request<Pool>(`/api/pools/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePool: (id: number) => request<void>(`/api/pools/${id}`, { method: "DELETE" }),
  addPoolMember: (id: number, person_id: number) =>
    request<PoolMember>(`/api/pools/${id}/members`, {
      method: "POST",
      body: JSON.stringify({ person_id }),
    }),
  removePoolMember: (id: number, person_id: number) =>
    request<void>(`/api/pools/${id}/members/${person_id}`, { method: "DELETE" }),

  // Skills
  listSkills: () => request<Skill[]>("/api/skills"),
  createSkill: (body: { name: string; description?: string | null }) =>
    request<Skill>("/api/skills", { method: "POST", body: JSON.stringify(body) }),
  updateSkill: (id: number, body: { name?: string; description?: string | null }) =>
    request<Skill>(`/api/skills/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSkill: (id: number) => request<void>(`/api/skills/${id}`, { method: "DELETE" }),

  // Slots
  listSlots: () => request<Slot[]>("/api/slots"),
  getSlot: (id: number) => request<Slot>(`/api/slots/${id}`),
  createSlot: (body: SlotInput) =>
    request<Slot>("/api/slots", { method: "POST", body: JSON.stringify(body) }),
  updateSlot: (id: number, body: Partial<SlotInput>) =>
    request<Slot>(`/api/slots/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSlot: (id: number) => request<void>(`/api/slots/${id}`, { method: "DELETE" }),
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

  // Public invite acceptance (no auth)
  getInvitationByToken: (token: string) =>
    request<InvitationPublicView>(`/api/invitations/by-token/${encodeURIComponent(token)}`),
  acceptInvitation: (token: string, body: { password: string; person_name?: string }) =>
    request<AuthResponse>(
      `/api/invitations/by-token/${encodeURIComponent(token)}/accept`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  // Onboarding
  completeOnboarding: () =>
    request<Tenant>("/api/onboarding/complete", { method: "POST" }),

  // Tenant defaults
  updateTenantDefaults: (body: {
    country_code?: string | null;
    region_code?: string | null;
  }) => request<Tenant>("/api/tenants/me", { method: "PATCH", body: JSON.stringify(body) }),

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
  getSchedule: (id: number) => request<ScheduleDetail>(`/api/schedules/${id}`),
  generateSchedule: (period: string) =>
    request<ScheduleDetail>("/api/schedules/generate", {
      method: "POST",
      body: JSON.stringify({ period }),
    }),
  publishSchedule: (id: number) =>
    request<Schedule>(`/api/schedules/${id}/publish`, { method: "POST" }),
  archiveSchedule: (id: number) =>
    request<Schedule>(`/api/schedules/${id}/archive`, { method: "POST" }),
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
  days_after: number;
  applies_to: SuccessionAppliesTo;
  severity: DependencySeverity;
  weight: number;
  created_at: string;
};

export type SlotSuccessionRuleInput = {
  after_slot_id: number;
  forbid_slot_id: number;
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
  period: FrequencyPeriod;
  max_count: number;
  severity: DependencySeverity;
  weight: number;
  created_at: string;
};

export type SlotFrequencyCapInput = {
  slot_id: number;
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
  created_at: string;
};

export type InvitationPublicView = {
  tenant_name: string;
  tenant_slug: string;
  email: string;
  person_name: string;
  expires_at: string;
};
