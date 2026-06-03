"use client";

import { createContext, ReactNode, useContext, useEffect } from "react";
import { CachedProfile, setCachedProfile } from "@/lib/auth/client-auth";

type AuthContextValue = {
  profile: CachedProfile | null;
  oidcEnabled: boolean;
  passwordLoginEnabled: boolean;
};

const AuthProfileContext = createContext<AuthContextValue>({
  profile: null,
  oidcEnabled: false,
  passwordLoginEnabled: true,
});

type AuthProviderProps = {
  initialProfile: CachedProfile | null;
  oidcEnabled?: boolean;
  passwordLoginEnabled?: boolean;
  children: ReactNode;
};

export function AuthProvider({
  initialProfile,
  oidcEnabled = false,
  passwordLoginEnabled = true,
  children,
}: AuthProviderProps) {
  useEffect(() => {
    if (initialProfile) {
      setCachedProfile(initialProfile);
    }
  }, [initialProfile]);

  return (
    <AuthProfileContext.Provider value={{ profile: initialProfile, oidcEnabled, passwordLoginEnabled }}>
      {children}
    </AuthProfileContext.Provider>
  );
}

export function useAuthProfile() {
  return useContext(AuthProfileContext).profile;
}

export function useOidcEnabled() {
  return useContext(AuthProfileContext).oidcEnabled;
}

export function usePasswordLoginEnabled() {
  return useContext(AuthProfileContext).passwordLoginEnabled;
}
