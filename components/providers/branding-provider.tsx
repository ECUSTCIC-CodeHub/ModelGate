"use client";

import { createContext, useContext } from "react";

type BrandingContextValue = {
  logoUrl: string;
  logoSquareUrl: string;
};

const BrandingContext = createContext<BrandingContextValue>({
  logoUrl: "",
  logoSquareUrl: "",
});

export function BrandingProvider({
  logoUrl,
  logoSquareUrl,
  children,
}: {
  logoUrl: string;
  logoSquareUrl: string;
  children: React.ReactNode;
}) {
  return (
    <BrandingContext.Provider value={{ logoUrl, logoSquareUrl }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}
