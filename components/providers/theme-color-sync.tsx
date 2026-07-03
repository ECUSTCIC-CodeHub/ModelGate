"use client";

import { useEffect } from "react";
import { generateThemeCssVariables, cssVariablesToText } from "@/lib/shared/color";

const STYLE_ID = "modelgate-theme";

export function ThemeColorSync({ themeColor }: { themeColor: string | null }) {
  useEffect(() => {
    if (themeColor !== null) return;
    const el = document.getElementById(STYLE_ID);
    if (el) el.textContent = "";
  }, [themeColor]);

  if (!themeColor) return null;

  const vars = generateThemeCssVariables(themeColor);
  const css = `:root{${cssVariablesToText(vars.light)}}.dark{${cssVariablesToText(vars.dark)}}`;

  return <style>{css}</style>;
}
