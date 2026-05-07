"use client";

export type Session = {
  accessToken: string;
  refreshToken: string;
};

export type CachedProfile = {
  id: number;
  username: string;
  role: "admin" | "user";
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  used_tokens?: number;
  used_requests?: number;
  period_used_tokens?: number;
  period_used_requests?: number;
  period_reset_at?: string | null;
  oidc_issuer?: string | null;
  oidc_subject?: string | null;
};

const KEY = "vlm-session";
const PROFILE_KEY = "vlm-profile";

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setSession(session: Session) {
  localStorage.setItem(KEY, JSON.stringify(session));
}

export function getCachedProfile(): CachedProfile | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedProfile;
  } catch {
    return null;
  }
}

export function setCachedProfile(profile: CachedProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function clearCachedProfile() {
  localStorage.removeItem(PROFILE_KEY);
}

export function clearSession() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(PROFILE_KEY);
}

export async function getOrFetchProfile() {
  const cached = getCachedProfile();
  if (cached) return cached;

  const response = await authedFetch("/api/dashboard/profile");
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  const user = data?.user as CachedProfile | undefined;
  if (!user) return null;
  setCachedProfile(user);
  return user;
}

export async function authedFetch(input: string, init?: RequestInit) {
  const session = getSession();
  const headers = new Headers(init?.headers ?? {});
  if (session?.accessToken) {
    headers.set("authorization", `Bearer ${session.accessToken}`);
  }
  headers.set("content-type", "application/json");

  let response = await fetch(input, { ...init, headers, credentials: "same-origin" });

  if (response.status !== 401) {
    return response;
  }

  const refresh = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(session?.refreshToken ? { refresh_token: session.refreshToken } : {}),
  });

  if (!refresh.ok) {
    clearSession();
    return response;
  }

  const refreshData = (await refresh.json()) as {
    access_token: string;
    refresh_token: string;
  };

  if (refreshData?.access_token && refreshData?.refresh_token) {
    setSession({ accessToken: refreshData.access_token, refreshToken: refreshData.refresh_token });
    headers.set("authorization", `Bearer ${refreshData.access_token}`);
  }
  response = await fetch(input, { ...init, headers, credentials: "same-origin" });
  return response;
}
