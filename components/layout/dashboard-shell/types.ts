import type { ComponentType, ReactNode } from "react";
import type { LucideProps } from "lucide-react";

export type Role = "admin" | "user";

export type DashboardShellProps = {
  role: Role;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
};

export type DashboardMenuItem = {
  href: string;
  label: string;
  icon: ComponentType<LucideProps>;
};

export type ProfileBrief = {
  username: string;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  used_tokens?: number;
  used_requests?: number;
  period_used_tokens?: number;
  period_used_requests?: number;
  period_reset_at?: string | null;
  oidc_issuer?: string | null;
  oidc_subject?: string | null;
};
