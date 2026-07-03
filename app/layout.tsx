import type { Metadata } from "next";
import "../public/fonts/harmony.css";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeScript } from "@/components/providers/theme-script";
import { ThemeColorSync } from "@/components/providers/theme-color-sync";
import { getGatewaySettings } from "@/lib/core/settings";
import { isValidHexColor } from "@/lib/shared/color";

export const metadata: Metadata = {
  title: "ModelGate",
  description: "多租户 LLM 网关管理控制台",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const settings = await getGatewaySettings();
  const themeColor = isValidHexColor(settings.theme_color) ? settings.theme_color : null;

  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        <ThemeScript themeColor={themeColor} />
      </head>
      <body className="antialiased">
        <ThemeColorSync themeColor={themeColor} />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
