"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatTokenCount } from "@/lib/shared/utils";
import type { Summary } from "./dashboard-model";

type DashboardTokenTrendCardProps = {
  chartReady: boolean;
  summary: Summary | null;
};

export function DashboardTokenTrendCard({ chartReady, summary }: DashboardTokenTrendCardProps) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="最近 24 小时 Token 趋势"
          description="按小时聚合，适合观察请求高峰和成本变化。"
        />
      </CardHeader>
      <CardContent className="chart-surface h-56 lg:h-72">
        {chartReady ? (
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart
              accessibilityLayer={false}
              data={summary?.hourly_tokens ?? []}
              margin={{ top: 8, right: 12, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
              <XAxis
                dataKey="hour"
                tickLine={false}
                axisLine={false}
                minTickGap={20}
                tick={{ fill: "var(--color-chart-tick)", fontSize: 11 }}
                tickFormatter={(value: string) => value.slice(11, 16)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tick={{ fill: "var(--color-chart-tick)", fontSize: 11 }}
                tickFormatter={(value: number) => formatTokenCount(value)}
              />
              <Tooltip
                cursor={{ fill: "var(--color-chart-cursor-fill)", stroke: "var(--color-chart-cursor-stroke)", strokeWidth: 1 }}
                contentStyle={{ background: "var(--color-chart-tooltip-bg)", border: "1px solid var(--color-chart-tooltip-border)", borderRadius: 12 }}
                labelFormatter={(label) => String(label).replace("T", " ")}
                formatter={(value) => {
                  const normalizedValue = Array.isArray(value) ? value[0] : value;
                  const tokenValue = typeof normalizedValue === "number" ? normalizedValue : Number(normalizedValue);
                  return [formatTokenCount(Number.isFinite(tokenValue) ? tokenValue : 0), "Token"] as const;
                }}
              />
              <Bar dataKey="tokens" fill="var(--color-chart-bar)" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)]" />
        )}
      </CardContent>
    </Card>
  );
}
