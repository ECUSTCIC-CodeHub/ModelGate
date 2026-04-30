"use client";

import { createContext, ReactNode, useContext, useEffect } from "react";
import { CachedProfile, setCachedProfile } from "@/lib/client-auth";

type AuthContextValue = {
  profile: CachedProfile | null;
  oidcEnabled: boolean;
};

const AuthProfileContext = createContext<AuthContextValue>({ profile: null, oidcEnabled: false });

type AuthProviderProps = {
  initialProfile: CachedProfile | null;
  oidcEnabled?: boolean;
  children: ReactNode;
};

export function AuthProvider({ initialProfile, oidcEnabled = false, children }: AuthProviderProps) {
  useEffect(() => {
    if (initialProfile) {
      setCachedProfile(initialProfile);
    }
  }, [initialProfile]);

  return (
    <AuthProfileContext.Provider value={{ profile: initialProfile, oidcEnabled }}>
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
