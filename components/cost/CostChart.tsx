"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ByDay } from "@/lib/server/cost-aggregate";

type Props = {
  data: ByDay[];
  /** How many trailing days to show. */
  days?: number;
};

function fmtUsdShort(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(3)}`;
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(1)}`;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function CostChart({ data, days = 60 }: Props) {
  // Build a continuous trailing window so empty days render as zero bars.
  const today = Date.now();
  const map = new Map(data.map((d) => [d.date, d]));
  const series: ByDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dayKey(today - i * 86_400_000);
    series.push(map.get(date) ?? { date, usd: 0, inputTokens: 0, outputTokens: 0 });
  }

  return (
    <div className="h-[280px] w-full rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series} margin={{ top: 5, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            tickFormatter={(v: string) => v.slice(5)}
            interval={Math.max(0, Math.floor(series.length / 8) - 1)}
            axisLine={{ stroke: "var(--border)" }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={fmtUsdShort}
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 11,
            }}
            labelStyle={{ color: "var(--foreground)" }}
            formatter={((value: unknown, name: unknown) => {
              const v = typeof value === "number" ? value : Number(value);
              if (name === "usd") return [fmtUsdShort(v), "Cost"];
              if (name === "inputTokens") return [v.toLocaleString(), "Input tok"];
              if (name === "outputTokens") return [v.toLocaleString(), "Output tok"];
              return [String(value), String(name)];
            }) as never}
          />
          <Bar dataKey="usd" fill="var(--accent)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
