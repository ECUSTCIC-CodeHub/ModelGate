import type { Metadata } from "next";
import { cookies } from "next/headers";
import "../public/fonts/harmony.css";
import "./globals.css";
import { BrandingProvider } from "@/components/providers/branding-provider";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeScript } from "@/components/providers/theme-script";
import { ThemeColorSync } from "@/components/providers/theme-color-sync";
import { getGatewaySettings } from "@/lib/core/settings";
import { isValidHexColor } from "@/lib/shared/color";

export const metadata: Metadata = {
  title: "ModelGate",
  description: "多租户 LLM 网关管理控制台",
};

const PREFS_COOKIE = "modelgate-prefs";

function parsePrefs(cookieValue: string | undefined): { appearance: "default" | "retro"; mode: "light" | "dark" | "system" } | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split(",");
  if (parts.length !== 2) return null;
  const [appearance, mode] = parts;
  if (appearance !== "default" && appearance !== "retro") return null;
  if (mode !== "light" && mode !== "dark" && mode !== "system") return null;
  return { appearance, mode };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const settings = await getGatewaySettings();
  const themeColor = isValidHexColor(settings.theme_color) ? settings.theme_color : null;

  let appearance: "default" | "retro" = settings.default_appearance ?? "default";
  let mode: "light" | "dark" | "system" = settings.default_mode ?? "light";
  let resolvedMode: "light" | "dark" = mode === "system" ? "light" : mode;

  try {
    const cookieStore = await cookies();
    const prefsCookie = cookieStore.get(PREFS_COOKIE)?.value;
    const prefs = parsePrefs(prefsCookie);
    if (prefs) {
      appearance = prefs.appearance;
      if (prefs.mode === "light" || prefs.mode === "dark") {
        mode = prefs.mode;
        resolvedMode = prefs.mode;
      }
    }
  } catch {
    // cookies() 在 build 时可能失败，使用默认值
  }

  const htmlClasses = [
    resolvedMode === "dark" ? "dark" : "",
    appearance === "retro" ? "retro" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <html lang="zh" suppressHydrationWarning className={htmlClasses} data-appearance={appearance} data-mode={mode}>
      <head>
        <ThemeScript themeColor={themeColor} />
      </head>
      <body className="antialiased">
        <ThemeColorSync themeColor={themeColor} />
        <BrandingProvider logoUrl={settings.logo_url} logoSquareUrl={settings.logo_square_url}>
          <ToastProvider>{children}</ToastProvider>
        </BrandingProvider>
      </body>
    </html>
  );
}
