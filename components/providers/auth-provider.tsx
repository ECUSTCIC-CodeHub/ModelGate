"use client";

import { createContext, ReactNode, useContext, useEffect } from "react";
import { CachedProfile, setCachedProfile } from "@/lib/client-auth";

const AuthProfileContext = createContext<CachedProfile | null>(null);

type AuthProviderProps = {
  initialProfile: CachedProfile | null;
  children: ReactNode;
};

export function AuthProvider({ initialProfile, children }: AuthProviderProps) {
  useEffect(() => {
    if (initialProfile) {
      setCachedProfile(initialProfile);
    }
  }, [initialProfile]);

  return <AuthProfileContext.Provider value={initialProfile}>{children}</AuthProfileContext.Provider>;
}

export function useAuthProfile() {
  return useContext(AuthProfileContext);
}
