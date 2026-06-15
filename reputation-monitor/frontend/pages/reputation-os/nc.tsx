/**
 * NC — Narrative Control / Negative Channels Intelligence console.
 *
 * Route: /reputation-os/nc  (inserted in the sidebar between Talk and Alerts)
 *
 * This is an intelligence console, not a plain analytics table. It assembles
 * the full NC pipeline output (ncEngine -> /api/reputation-os/[tenant]/nc)
 * into: keyword/date controls, six metric cards, the Negative Spreaders
 * table, narrative clusters, a risk timeline, a viral-shorts tracker, and a
 * per-channel evidence drawer.
 *
 * Detection framing is deliberately non-defamatory throughout: the console
 * surfaces "AI-detected repeated negative narrative amplification patterns"
 * with confidence + evidence + timestamps, and never asserts that a channel
 * "spreads lies".
 *
 * It reuses the existing dashboard shell (TenantProvider + ROLayout), the
 * shared KeywordContext, KeywordSearchBar, ROCard and ROMetricCard so it is
 * visually and behaviourally consistent with every other module.
 */

import { useState } from "react";
import {
  AlertOctagon,
  Activity,
  Gauge,
  Radar,
  ShieldAlert,
  TrendingUp,
  Film,
  Network,
  Info,
} from "lucide-react";

import { TenantProvider } from "@/contexts/TenantContext";
import { useKeyword } from "@/contexts/KeywordContext";
import ROLayout from "@/components/reputation-os/ROLayout";
import ROCard from "@/components/reputation-os/ROCard";
import ROMetricCard from "@/components/reputation-os/ROMetricCard";
import KeywordSearchBar from "@/components/reputation-os/KeywordSearchBar";
import { ANIL_DISPLAY_NAME } from "@/lib/constants";

import { useNc } from "@/hooks/useNc";
import type { NCChannel } from "@/lib/nc/types";
import NegativeSpreadersTable from "@/components/reputation-os/nc/NegativeSpreadersTable";
import NarrativeClusters from "@/components/reputation-os/nc/NarrativeClusters";
import ThreatTimeline from "@/components/reputation-os/nc/ThreatTimeline";
import ShortsTracker from "@/components/reputation-os/nc/ShortsTracker";
import EvidenceDrawer from "@/components/reputation-os/nc/EvidenceDrawer";

const NC_SUGGESTIONS = ["Anil Ravipudi", "Tollywood controversy", "fan war"];

// Refresh the console every 60s so it behaves like a live threat monitor.
const POLL_MS = 60_000;

function SkeletonCard() {
  return <div className="h-24 animate-pulse rounded-xl bg-slate-800/60" />;
}

function NCContent() {
  const shared = useKeyword();
  const { keyword, setKeyword, commitKeyword, startDate, setStartDate, endDate, setEndDate, clearTimeline, isTimelineMode } =
    shared;

  const { intelligence } = useNc({ pollMs: POLL_MS });
  const { data, isLoading, isError, isFetching } = intelligence;

  const [selected, setSelected] = useState<NCChannel | null>(null);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!keyword.trim()) return;
    commitKeyword(keyword.trim());
  }

  const metrics = data?.metrics;
  const activeLabel = shared.activeKeyword.trim() || ANIL_DISPLAY_NAME;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-rose-500/15 text-rose-400">
          <Radar size={18} />
        </span>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-white">
            Narrative Control
            {isFetching && (
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-500" />
            )}
          </h1>
          <p className="text-xs text-slate-500">
            Negative Channels Intelligence — repeated narrative amplification detection
          </p>
        </div>
        <span className="ml-auto rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs text-rose-400">
          Target: {activeLabel}
        </span>
      </div>

      {/* Search + target selector */}
      <KeywordSearchBar
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={handleSearch}
        isLoading={isLoading}
        placeholder="Target keyword / person to monitor for negative amplification…"
        suggestions={NC_SUGGESTIONS}
        onSuggestionClick={(s) => {
          setKeyword(s);
          commitKeyword(s);
        }}
      />

      {/* Date filters */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500">Date range:</span>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="rounded-lg border border-slate-700/60 bg-slate-800/40 px-3 py-1.5 text-xs text-slate-200 focus:border-rose-500/50 focus:outline-none"
        />
        <span className="text-xs text-slate-600">to</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="rounded-lg border border-slate-700/60 bg-slate-800/40 px-3 py-1.5 text-xs text-slate-200 focus:border-rose-500/50 focus:outline-none"
        />
        {isTimelineMode && (
          <button
            onClick={clearTimeline}
            className="rounded-lg border border-slate-700/60 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
          >
            Clear
          </button>
        )}
      </div>

      {/* Legal / framing notice */}
      <div className="flex items-start gap-2 rounded-xl border border-slate-800/60 bg-slate-900/40 px-4 py-3 text-xs text-slate-400">
        <Info size={14} className="mt-0.5 shrink-0 text-slate-500" />
        <p>
          All findings represent{" "}
          <span className="text-slate-300">
            AI-detected repeated negative narrative amplification patterns
          </span>{" "}
          with associated confidence scores and evidence. Findings are
          analytical signals, not factual determinations about any channel.
        </p>
      </div>

      {/* Error state */}
      {isError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          Failed to load NC intelligence. Try adjusting the keyword or date range.
        </div>
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {isLoading || !metrics ? (
          Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <ROMetricCard
              label="Negative Videos Found"
              value={metrics.negativeVideosFound}
              icon={<AlertOctagon size={14} />}
            />
            <ROMetricCard
              label="High Risk Channels"
              value={metrics.highRiskChannels}
              icon={<ShieldAlert size={14} />}
            />
            <ROMetricCard
              label="Narrative Clusters"
              value={metrics.narrativeClusters}
              icon={<Network size={14} />}
            />
            <ROMetricCard
              label="Toxicity Score"
              value={`${metrics.toxicityScore}`}
              icon={<Gauge size={14} />}
            />
            <ROMetricCard
              label="Threat Velocity"
              value={`${metrics.threatVelocity > 0 ? "+" : ""}${metrics.threatVelocity}%`}
              trend={
                metrics.threatVelocity > 0
                  ? "up"
                  : metrics.threatVelocity < 0
                    ? "down"
                    : "stable"
              }
              icon={<Activity size={14} />}
            />
            <ROMetricCard
              label="Amplification Score"
              value={`${metrics.amplificationScore}`}
              icon={<TrendingUp size={14} />}
            />
          </>
        )}
      </div>

      {/* Full-volume ingestion summary (Issue 1/2): shows the analytics reflect
          the entire collected feed, scoped to the selected window. */}
      {data?.processing && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-800/60 bg-slate-900/40 px-4 py-2.5 text-xs text-slate-400">
          <span className="font-medium text-slate-300">Ingestion</span>
          <span>
            collected <span className="font-semibold text-slate-200">{data.processing.collected}</span>
          </span>
          <span>
            analyzed <span className="font-semibold text-emerald-300">{data.processing.analyzed}</span>
          </span>
          <span>
            flagged <span className="font-semibold text-rose-300">{data.processing.flagged}</span>
          </span>
          {data.processing.skipped > 0 && (
            <span>
              out-of-window <span className="font-semibold text-slate-300">{data.processing.skipped}</span>
            </span>
          )}
          {data.processing.withTranscript > 0 && (
            <span>
              with transcript <span className="font-semibold text-cyan-300">{data.processing.withTranscript}</span>
            </span>
          )}
          <span className="ml-auto rounded-full bg-slate-800/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
            {data.processing.mode === "deep" ? "full-scale" : "single-page"}
          </span>
          {data.processing.dateWindow && (
            <span className="text-slate-500">
              {data.processing.dateWindow.startDate} → {data.processing.dateWindow.endDate}
            </span>
          )}
        </div>
      )}

      {/* Negative Spreaders Table */}
      <ROCard
        title="Negative Spreaders"
        subtitle="Channels ranked by AI-detected amplification risk"
        icon={<ShieldAlert size={16} />}
      >
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-800/60" />
            ))}
          </div>
        ) : data && data.channels.length > 0 ? (
          <NegativeSpreadersTable channels={data.channels} onSelect={setSelected} />
        ) : (
          <p className="text-sm text-slate-500">
            No channels currently meet the negative-amplification threshold for this query.
          </p>
        )}
      </ROCard>

      {/* Narrative Clusters + Timeline */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ROCard
          title="Narrative Clusters"
          subtitle="Semantically grouped recurring narratives"
          icon={<Network size={16} />}
        >
          {isLoading ? (
            <div className="h-48 animate-pulse rounded-lg bg-slate-800/60" />
          ) : (
            <NarrativeClusters clusters={data?.narratives ?? []} />
          )}
        </ROCard>

        <ROCard
          title="Risk Timeline"
          subtitle="Flagged volume & toxicity over time"
          icon={<Activity size={16} />}
        >
          {isLoading ? (
            <div className="h-48 animate-pulse rounded-lg bg-slate-800/60" />
          ) : (
            <ThreatTimeline points={data?.timeline ?? []} />
          )}
        </ROCard>
      </div>

      {/* Viral Shorts Tracker */}
      <ROCard
        title="Viral Shorts Tracker"
        subtitle="Clip farming, meme edits & rapid reposting bursts"
        icon={<Film size={16} />}
      >
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="aspect-[9/12] animate-pulse rounded-xl bg-slate-800/60" />
            ))}
          </div>
        ) : (
          <ShortsTracker shorts={data?.shorts ?? []} />
        )}
      </ROCard>

      {/* Evidence Drawer (Evidence Explorer) */}
      <EvidenceDrawer channel={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export default function NCPage() {
  return (
    <TenantProvider>
      <ROLayout activeModule="nc">
        <NCContent />
      </ROLayout>
    </TenantProvider>
  );
}
