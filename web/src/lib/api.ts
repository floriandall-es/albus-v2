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
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    let detail = res.statusText;
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
};
