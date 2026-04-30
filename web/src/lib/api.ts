export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

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
}

export type Tenant = {
  id: number;
  slug: string;
  name: string;
  country: string | null;
  locale: string | null;
  created_at: string;
  onboarding_completed_at: string | null;
};

export type Person = {
  id: number;
  email: string;
  name: string;
  locale: string | null;
  created_at: string;
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
  crosses_midnight: boolean;
  team_roles: SlotTeamRole[];
  skills_required: SlotSkillRequired[];
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
    tenant_slug: string;
    person_name: string;
    email: string;
    password: string;
  }) => request<AuthResponse>("/api/signup", { method: "POST", body: JSON.stringify(body) }),

  login: (body: { email: string; password: string; tenant_slug: string }) =>
    request<AuthResponse>("/api/login", { method: "POST", body: JSON.stringify(body) }),

  me: () => request<MeResponse>("/api/me"),

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
