import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { NCTimelinePoint } from "@/lib/nc/types";

export default function ThreatTimeline({ points }: { points: NCTimelinePoint[] }) {
  if (points.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-slate-500">
        Not enough flagged activity to plot a timeline.
      </p>
    );
  }

  const data = points.map((p) => ({
    date: p.date.slice(5), // MM-DD
    flagged: p.flaggedVideos,
    toxicity: Math.round(p.toxicity * 100),
    velocity: p.threatVelocity,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="ncFlagged" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#f43f5e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 11 }} stroke="#334155" />
        <YAxis tick={{ fill: "#64748b", fontSize: 11 }} stroke="#334155" />
        <Tooltip
          contentStyle={{
            backgroundColor: "#0f172a",
            border: "1px solid #334155",
            borderRadius: 8,
            color: "#e2e8f0",
            fontSize: 12,
          }}
        />
        <Area
          type="monotone"
          dataKey="flagged"
          name="Flagged videos"
          stroke="#f43f5e"
          fill="url(#ncFlagged)"
          strokeWidth={2}
        />
        <Line
          type="monotone"
          dataKey="toxicity"
          name="Toxicity %"
          stroke="#f97316"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
