/**
 * ShortsTracker — Viral Shorts / clip-farming monitor for the NC console.
 *
 * Renders the NCShort[] surfaced by ncEngine as a thumbnail grid. Highlights
 * repost/clip-farm bursts (shorts that share a burstId), per-short risk level
 * and detected narrative, and an estimated reach. This is the "rapid reposting
 * / meme edit / clip farming" amplification surface called for in the brief.
 */

import { useMemo } from "react";
import { Film, Flame, Layers, Play } from "lucide-react";
import type { NCShort } from "@/lib/nc/types";
import RiskBadge from "./RiskBadge";
import { NARRATIVE_LABEL } from "./NegativeSpreadersTable";

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Assign each detected burst a stable index so we can label "Burst #n". */
function useBurstIndex(shorts: NCShort[]): Map<string, number> {
  return useMemo(() => {
    const map = new Map<string, number>();
    let next = 1;
    for (const s of shorts) {
      if (s.burstId && !map.has(s.burstId)) {
        map.set(s.burstId, next++);
      }
    }
    return map;
  }, [shorts]);
}

export default function ShortsTracker({ shorts }: { shorts: NCShort[] }) {
  const burstIndex = useBurstIndex(shorts);

  const burstCount = burstIndex.size;
  const totalReach = useMemo(
    () => shorts.reduce((sum, s) => sum + (s.views || 0), 0),
    [shorts],
  );

  if (shorts.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No flagged Shorts detected for the current query.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <Film size={14} className="text-rose-400" />
          {shorts.length} flagged shorts
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Layers size={14} className="text-orange-400" />
          {burstCount} repost {burstCount === 1 ? "burst" : "bursts"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Flame size={14} className="text-amber-400" />
          {formatCompact(totalReach)} combined views
        </span>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {shorts.map((s) => {
          const burstNo = s.burstId ? burstIndex.get(s.burstId) : undefined;
          return (
            <a
              key={s.videoId}
              href={s.proofUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative overflow-hidden rounded-xl border border-slate-800/60 bg-slate-900/50 transition hover:border-rose-500/40 hover:shadow-[0_0_16px_rgba(244,63,94,0.18)]"
            >
              {/* Thumbnail */}
              <div className="relative aspect-[9/12] w-full overflow-hidden bg-slate-800">
                {s.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={s.thumbnailUrl}
                    alt={s.title}
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-slate-600">
                    <Film size={28} />
                  </div>
                )}

                {/* Play overlay */}
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/30">
                  <Play
                    size={28}
                    className="text-white opacity-0 drop-shadow transition group-hover:opacity-90"
                    fill="currentColor"
                  />
                </div>

                {/* Risk badge */}
                <div className="absolute left-2 top-2">
                  <RiskBadge level={s.riskLevel} />
                </div>

                {/* Burst tag */}
                {burstNo !== undefined && (
                  <div className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-orange-500/90 px-2 py-0.5 text-[10px] font-semibold text-white shadow">
                    <Layers size={10} />
                    Burst #{burstNo}
                  </div>
                )}

                {/* Views pill */}
                <div className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white">
                  {formatCompact(s.views)} views
                </div>
              </div>

              {/* Meta */}
              <div className="space-y-1 p-2.5">
                <p className="line-clamp-2 text-xs font-medium leading-snug text-slate-200">
                  {s.title}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-slate-500">
                  {NARRATIVE_LABEL[s.narrativeType]}
                </p>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
