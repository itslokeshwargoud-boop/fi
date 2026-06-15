import { useEffect } from "react";
import {
  X,
  FileText,
  Image as ImageIcon,
  MessageSquareWarning,
  Repeat,
  Type,
  ExternalLink,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import RiskBadge from "./RiskBadge";
import { NARRATIVE_LABEL } from "./NegativeSpreadersTable";
import { useNcChannelEvidence } from "@/hooks/useNc";
import type { EvidenceType, NCChannel, NCEvidence } from "@/lib/nc/types";

const EVIDENCE_META: Record<
  EvidenceType,
  { icon: LucideIcon; label: string }
> = {
  transcript_segment: { icon: FileText, label: "Transcript" },
  ocr_thumbnail: { icon: ImageIcon, label: "Thumbnail OCR" },
  toxic_comment: { icon: MessageSquareWarning, label: "Audience comment" },
  repeated_phrase: { icon: Repeat, label: "Repeated phrase" },
  title_claim: { icon: Type, label: "Video title" },
};

const SEVERITY_COLOR: Record<NCEvidence["severity"], string> = {
  high: "text-red-400",
  medium: "text-orange-400",
  low: "text-yellow-400",
};

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function BreakdownRow({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-300">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-rose-500 to-orange-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function EvidenceDrawer({
  channel,
  onClose,
}: {
  channel: NCChannel | null;
  onClose: () => void;
}) {
  const open = !!channel;
  const { data, isLoading, isError } = useNcChannelEvidence(channel?.channelKey ?? null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open || !channel) return null;

  return (
    <div className="fixed inset-0 z-[60]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-2xl flex-col border-l border-slate-800/60 bg-[#0a0f1d] shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-800/60 p-5">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <ShieldAlert size={18} className="text-rose-400" />
              <h2 className="text-lg font-bold text-white">{channel.channelName}</h2>
              <RiskBadge level={channel.riskLevel} />
            </div>
            <p className="max-w-md text-xs leading-relaxed text-slate-500">
              AI-detected repeated negative-narrative amplification patterns —{" "}
              {(channel.confidence * 100).toFixed(0)}% confidence. Dominant narrative:{" "}
              {NARRATIVE_LABEL[channel.dominantNarrative]}.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-800/60 hover:text-slate-300"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {isLoading && <p className="text-sm text-slate-500">Loading evidence…</p>}
          {isError && (
            <p className="text-sm text-red-400">Failed to load channel evidence.</p>
          )}

          {data && (
            <>
              {/* Risk breakdown */}
              <section>
                <h3 className="mb-3 text-sm font-semibold text-white">Risk breakdown</h3>
                <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800/60 bg-slate-900/50 p-4 sm:grid-cols-2">
                  <BreakdownRow label="Negative sentiment" value={data.riskBreakdown.sentiment} />
                  <BreakdownRow label="Toxicity" value={data.riskBreakdown.toxicity} />
                  <BreakdownRow label="Narrative intensity" value={data.riskBreakdown.narrativeIntensity} />
                  <BreakdownRow label="Virality" value={data.riskBreakdown.virality} />
                  <BreakdownRow label="Repeated targeting" value={data.riskBreakdown.repeatedTargeting} />
                  <div className="flex items-end">
                    <span className="text-xs text-slate-500">
                      Amplification {channel.amplificationScore.toFixed(0)}/100 · Reach{" "}
                      {fmtNum(channel.reach)}
                    </span>
                  </div>
                </div>
              </section>

              {/* Flagged videos */}
              <section>
                <h3 className="mb-3 text-sm font-semibold text-white">
                  Flagged videos ({data.flaggedVideos.length})
                </h3>
                <div className="space-y-3">
                  {data.flaggedVideos.map((v) => (
                    <a
                      key={v.videoId}
                      href={v.proofUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex gap-3 rounded-xl border border-slate-800/60 bg-slate-900/50 p-3 transition-colors hover:border-rose-500/30"
                    >
                      {v.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={v.thumbnailUrl}
                          alt=""
                          className="h-16 w-28 shrink-0 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="h-16 w-28 shrink-0 rounded-lg bg-slate-800" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2">
                          <RiskBadge level={v.riskLevel} />
                          {v.isShort && (
                            <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-300">
                              SHORT
                            </span>
                          )}
                        </div>
                        <p className="truncate text-sm text-slate-200">{v.title}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {fmtNum(v.views)} views · toxicity {(v.toxicityScore * 100).toFixed(0)}% ·{" "}
                          {NARRATIVE_LABEL[v.narrativeType]}
                        </p>
                      </div>
                      <ExternalLink size={14} className="mt-1 shrink-0 text-slate-600" />
                    </a>
                  ))}
                </div>
              </section>

              {/* Evidence explorer */}
              <section>
                <h3 className="mb-3 text-sm font-semibold text-white">
                  Evidence ({data.evidence.length})
                </h3>
                <div className="space-y-2">
                  {data.evidence.map((e) => {
                    const meta = EVIDENCE_META[e.type];
                    const Icon = meta.icon;
                    return (
                      <div
                        key={e.id}
                        className="rounded-lg border border-slate-800/60 bg-slate-900/50 p-3"
                      >
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="flex items-center gap-1.5 text-xs text-slate-400">
                            <Icon size={13} />
                            {meta.label}
                            {e.type === "transcript_segment" &&
                              (e.proofUrl ? (
                                <a
                                  href={e.proofUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="Open video at this timestamp"
                                  className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300 hover:bg-slate-700 hover:text-cyan-200"
                                >
                                  ▶ {e.timestamp}
                                </a>
                              ) : (
                                <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">
                                  {e.timestamp}
                                </span>
                              ))}
                          </span>
                          <span className={`text-[10px] font-medium ${SEVERITY_COLOR[e.severity]}`}>
                            {e.severity.toUpperCase()} · {(e.confidence * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="text-sm text-slate-300">
                          &ldquo;{e.content}&rdquo;
                        </p>
                        {(e.narrativeLabel || typeof e.toxicity === "number") && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                            {e.narrativeLabel && (
                              <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-slate-300">
                                {NARRATIVE_LABEL[e.narrativeLabel] ?? e.narrativeLabel}
                              </span>
                            )}
                            {typeof e.toxicity === "number" && (
                              <span className="rounded bg-red-950/60 px-1.5 py-0.5 text-red-300">
                                toxicity {(e.toxicity * 100).toFixed(0)}%
                              </span>
                            )}
                          </div>
                        )}
                        {e.proofUrl && (
                          <a
                            href={e.proofUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1.5 inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300"
                          >
                            View proof <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                    );
                  })}
                  {data.evidence.length === 0 && (
                    <p className="text-xs text-slate-500">
                      No item-level evidence extracted for this channel in the current window.
                    </p>
                  )}
                </div>
              </section>

              {/* Disclaimer */}
              <p className="rounded-lg border border-slate-800/60 bg-slate-900/30 p-3 text-[11px] leading-relaxed text-slate-500">
                These are automated pattern detections paired with confidence scores and source
                evidence, not factual determinations about the channel. Review the linked proof
                before acting.
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
