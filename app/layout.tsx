import type { Metadata } from "next";
import "../public/fonts/harmony.css";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeScript } from "@/components/providers/theme-script";
import { getGatewaySettings } from "@/lib/core/settings";

export const metadata: Metadata = {
  title: "ModelGate",
  description: "多租户 LLM 网关管理控制台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { wallpaper_url } = getGatewaySettings();

  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="antialiased">
        {wallpaper_url && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={wallpaper_url}
            alt=""
            aria-hidden="true"
            referrerPolicy="no-referrer"
            className="anime-bg"
          />
        )}
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
