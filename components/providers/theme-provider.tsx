"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type Appearance = "default" | "retro";
type ThemeMode = "light" | "dark" | "system";

type ThemeProviderState = {
  appearance: Appearance;
  mode: ThemeMode;
  setAppearance: (appearance: Appearance) => void;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
};

const APPEARANCE_KEY = "modelgate-appearance";
const MODE_KEY = "modelgate-mode";
const LEGACY_KEY = "theme";

const ThemeContext = createContext<ThemeProviderState>({
  appearance: "default",
  mode: "light",
  setAppearance: () => {},
  setMode: () => {},
  toggleMode: () => {},
});

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // localStorage 不可用时静默忽略
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage 不可用时静默忽略，仅影响持久化
  }
}

function readStored(): { appearance: Appearance; mode: ThemeMode } {
  if (typeof window === "undefined") {
    return { appearance: "default", mode: "light" };
  }
  const legacy = safeGetItem(LEGACY_KEY);
  if (legacy !== null) safeRemoveItem(LEGACY_KEY);

  const storedAppearance = safeGetItem(APPEARANCE_KEY);
  const storedMode = safeGetItem(MODE_KEY);

  let appearance: Appearance = "default";
  if (storedAppearance === "retro" || storedAppearance === "default") {
    appearance = storedAppearance;
  } else if (legacy === "retro") {
    appearance = "retro";
  }

  let mode: ThemeMode;
  if (storedMode === "light" || storedMode === "dark" || storedMode === "system") {
    mode = storedMode;
  } else if (legacy !== null) {
    mode = legacy === "dark" ? "dark" : "light";
  } else {
    mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  return { appearance, mode };
}

function applyThemeClasses(appearance: Appearance, mode: ThemeMode) {
  const root = document.documentElement;
  const isDark = mode === "system" ? resolveSystemMode() === "dark" : mode === "dark";
  root.classList.toggle("dark", isDark);
  root.classList.toggle("retro", appearance === "retro");
}

type ThemeProviderProps = {
  children: React.ReactNode;
  initialAppearance?: Appearance;
  initialMode?: ThemeMode;
};

function resolveSystemMode(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children, initialAppearance, initialMode }: ThemeProviderProps) {
  const [appearance, setAppearanceState] = useState<Appearance>(() => {
    if (initialAppearance === "default" || initialAppearance === "retro") return initialAppearance;
    const stored = readStored();
    return stored.appearance;
  });
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (initialMode === "light" || initialMode === "dark" || initialMode === "system") return initialMode;
    const stored = readStored();
    return stored.mode;
  });
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    applyThemeClasses(appearance, mode);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    applyThemeClasses(appearance, mode);
    safeSetItem(APPEARANCE_KEY, appearance);
    safeSetItem(MODE_KEY, mode);
    // 同步到 cookie
    fetch("/api/user/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appearance, mode }),
    }).catch((err) => {
      console.warn("主题偏好同步失败:", err);
    });
  }, [appearance, mode, mounted]);

  const setAppearance = useCallback((next: Appearance) => {
    setAppearanceState(next);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  const value = useMemo(
    () => ({ appearance, mode, setAppearance, setMode, toggleMode }),
    [appearance, mode, setAppearance, setMode, toggleMode],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
