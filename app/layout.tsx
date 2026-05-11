import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeScript } from "@/components/providers/theme-script";

const misans = localFont({
  src: "../font/MiSans-Bold.ttf",
  variable: "--font-misans",
  display: "swap",
  // MiSans-Bold is the only file; use it for every weight so the site is
  // unified. Range syntax tells next/font to bind this face to weights 100-900.
  weight: "100 900",
  style: "normal",
});

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
    <html lang="zh" suppressHydrationWarning className={misans.variable}>
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&display=swap"
        />
        <ThemeScript />
      </head>
      <body className="antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
