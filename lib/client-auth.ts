"use client";

export type Session = {
  accessToken: string;
  refreshToken: string;
};

const KEY = "vlm-session";

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

export function clearSession() {
  localStorage.removeItem(KEY);
}

export async function authedFetch(input: string, init?: RequestInit) {
  const session = getSession();
  const headers = new Headers(init?.headers ?? {});
  if (session?.accessToken) {
    headers.set("authorization", `Bearer ${session.accessToken}`);
  }
  headers.set("content-type", "application/json");

  let response = await fetch(input, { ...init, headers });

  if (response.status !== 401 || !session?.refreshToken) {
    return response;
  }

  const refresh = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });

  if (!refresh.ok) {
    clearSession();
    return response;
  }

  const refreshData = (await refresh.json()) as {
    access_token: string;
    refresh_token: string;
  };

  setSession({ accessToken: refreshData.access_token, refreshToken: refreshData.refresh_token });
  headers.set("authorization", `Bearer ${refreshData.access_token}`);
  response = await fetch(input, { ...init, headers });
  return response;
}
