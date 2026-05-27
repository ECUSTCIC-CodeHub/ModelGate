"use client";

import { createContext, ReactNode, useContext, useEffect } from "react";
import { CachedProfile, setCachedProfile } from "@/lib/auth/client-auth";

type AuthContextValue = {
  profile: CachedProfile | null;
  oidcEnabled: boolean;
  logoUrl: string;
};

const AuthProfileContext = createContext<AuthContextValue>({ profile: null, oidcEnabled: false, logoUrl: "" });

type AuthProviderProps = {
  initialProfile: CachedProfile | null;
  oidcEnabled?: boolean;
  logoUrl?: string;
  children: ReactNode;
};

export function AuthProvider({ initialProfile, oidcEnabled = false, logoUrl = "", children }: AuthProviderProps) {
  useEffect(() => {
    if (initialProfile) {
      setCachedProfile(initialProfile);
    }
  }, [initialProfile]);

  return (
    <AuthProfileContext.Provider value={{ profile: initialProfile, oidcEnabled, logoUrl }}>
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

export function useLogoUrl() {
  return useContext(AuthProfileContext).logoUrl;
}
