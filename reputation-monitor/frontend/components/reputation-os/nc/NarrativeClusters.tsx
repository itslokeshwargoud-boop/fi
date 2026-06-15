import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { NCNarrativeCluster } from "@/lib/nc/types";

const TREND_ICON: Record<NCNarrativeCluster["trend"], React.ReactNode> = {
  growing: <TrendingUp size={13} className="text-red-400" />,
  stable: <Minus size={13} className="text-slate-400" />,
  declining: <TrendingDown size={13} className="text-emerald-400" />,
};

const BAR_COLORS = ["#f43f5e", "#f97316", "#eab308", "#8b5cf6", "#06b6d4", "#ec4899"];

export default function NarrativeClusters({
  clusters,
}: {
  clusters: NCNarrativeCluster[];
}) {
  if (clusters.length === 0) {
    return <p className="text-sm text-slate-500">No narrative clusters detected.</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {clusters.map((c, i) => (
        <div
          key={c.id}
          className="rounded-xl border border-slate-800/60 bg-slate-900/50 p-4 backdrop-blur"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <h4 className="text-sm font-semibold text-white">{c.label}</h4>
            <span className="flex shrink-0 items-center gap-1 text-[10px] capitalize text-slate-500">
              {TREND_ICON[c.trend]}
              {c.trend}
            </span>
          </div>

          {/* Share bar */}
          <div className="mb-3">
            <div className="mb-1 flex justify-between text-xs text-slate-400">
              <span>{c.percentage}% of flagged items</span>
              <span>{c.size} items</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${c.percentage}%`,
                  backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                }}
              />
            </div>
          </div>

          {/* Key terms (explainability) */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {c.keyTerms.map((t) => (
              <span
                key={t}
                className="rounded-full bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-400"
              >
                {t}
              </span>
            ))}
          </div>

          {/* Toxicity / sentiment chips */}
          <div className="mb-3 flex gap-3 text-[11px] text-slate-500">
            <span>Toxicity {(c.toxicity * 100).toFixed(0)}%</span>
            <span>
              Sentiment {c.sentiment > 0 ? "+" : ""}
              {c.sentiment.toFixed(2)}
            </span>
          </div>

          {/* Sample */}
          {c.sampleTexts[0] && (
            <p className="rounded-lg bg-slate-800/50 px-3 py-2 text-xs text-slate-300">
              &ldquo;{c.sampleTexts[0]}&rdquo;
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
