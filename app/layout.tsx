import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeScript } from "@/components/providers/theme-script";

export const metadata: Metadata = {
  title: "ModelGate",
  description: "多租户 LLM 网关管理控制台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        {/* HarmonyOS Sans SC — subset CSS with full unicode-range mapping */}
        <link rel="stylesheet" href="/fonts/harmony.css" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&display=swap"
        />
        <ThemeScript />
      </head>
      <body className="antialiased">
        {/* Anime wallpaper background layer (LoliAPI ACG, adaptive).
            Rendered as an <img> so browsers follow the cross-origin 302
            redirect reliably. Falls back to the body background color. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="https://www.loliapi.com/acg/"
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          className="anime-bg"
        />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
