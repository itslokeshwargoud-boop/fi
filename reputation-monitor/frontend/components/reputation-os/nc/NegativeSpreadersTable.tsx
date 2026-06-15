import { useMemo, useState } from "react";
import { ArrowUpDown, ChevronRight } from "lucide-react";
import RiskBadge from "./RiskBadge";
import type { NCChannel, NarrativeType } from "@/lib/nc/types";

const NARRATIVE_LABEL: Record<NarrativeType, string> = {
  controversy_amplification: "Controversy amplification",
  troll_targeting: "Targeted trolling",
  fan_war: "Fan-war",
  harassment: "Harassment",
  authenticity_attack: "Authenticity attack",
  industry_politics: "Industry politics",
  overaction_criticism: "Performance criticism",
  other: "Mixed",
};

type SortKey = "riskScore" | "reach" | "flaggedVideoCount" | "lastActive";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function ThreatBar({ score }: { score: number }) {
  const color =
    score >= 75 ? "#ef4444" : score >= 55 ? "#f97316" : score >= 35 ? "#eab308" : "#3b82f6";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full" style={{ width: `${score}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs text-slate-400">{score.toFixed(0)}</span>
    </div>
  );
}

export default function NegativeSpreadersTable({
  channels,
  onSelect,
}: {
  channels: NCChannel[];
  onSelect: (channel: NCChannel) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("riskScore");
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const dir = asc ? 1 : -1;
    return [...channels].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [channels, sortKey, asc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setAsc((p) => !p);
    else {
      setSortKey(key);
      setAsc(false);
    }
  }

  const Th = ({ label, k }: { label: string; k?: SortKey }) => (
    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
      {k ? (
        <button
          onClick={() => toggleSort(k)}
          className="inline-flex items-center gap-1 hover:text-slate-300"
        >
          {label}
          <ArrowUpDown size={11} className={sortKey === k ? "text-rose-400" : ""} />
        </button>
      ) : (
        label
      )}
    </th>
  );

  if (channels.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800/60 bg-slate-900/50 p-10 text-center backdrop-blur">
        <p className="text-sm text-slate-500">
          No negative-narrative amplification patterns detected for this query.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800/60 bg-slate-900/50 backdrop-blur">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-800/60 bg-slate-900/80">
            <tr>
              <Th label="Channel" />
              <Th label="Risk" k="riskScore" />
              <Th label="Narrative" />
              <Th label="Confidence" />
              <Th label="Flagged" k="flaggedVideoCount" />
              <Th label="Reach" k="reach" />
              <Th label="Threat" />
              <Th label="Last Active" k="lastActive" />
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr
                key={c.channelKey}
                onClick={() => onSelect(c)}
                className="cursor-pointer border-b border-slate-800/40 transition-colors hover:bg-slate-800/40"
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{c.channelName}</div>
                  <div className="text-xs text-slate-500">{c.shortsCount} shorts tracked</div>
                </td>
                <td className="px-4 py-3">
                  <RiskBadge level={c.riskLevel} pulse />
                </td>
                <td className="px-4 py-3 text-sm text-slate-300">
                  {NARRATIVE_LABEL[c.dominantNarrative]}
                </td>
                <td className="px-4 py-3 text-sm text-slate-400">
                  {(c.confidence * 100).toFixed(0)}%
                </td>
                <td className="px-4 py-3 text-sm text-slate-300">
                  {c.flaggedVideoCount}
                  <span className="text-slate-600">/{c.totalVideoCount}</span>
                </td>
                <td className="px-4 py-3 text-sm text-slate-300">{fmtNum(c.reach)}</td>
                <td className="px-4 py-3">
                  <ThreatBar score={c.riskScore} />
                </td>
                <td className="px-4 py-3 text-xs text-slate-400">{fmtDate(c.lastActive)}</td>
                <td className="px-2 py-3 text-slate-600">
                  <ChevronRight size={16} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { NARRATIVE_LABEL };
