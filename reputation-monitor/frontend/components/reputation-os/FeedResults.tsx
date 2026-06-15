/**
 * FeedResults — Video / search results aggregation panel.
 *
 * Displays YouTube video results from keyword search as cards,
 * plus a "Detailed Video Data" table with columns for Title,
 * Channel, Views, Likes, Comments, Published, and Proof.
 */

import { useState, useEffect } from "react";
import type { YouTubeVideo } from "@/pages/api/youtube";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Exact timestamp formatted for India locale, e.g. "28 Apr 2026, 3:45 PM" */
function formatExactTime(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

/** Compact relative time for quick scanning */
function timeAgo(iso: string): string {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3_600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`;
  if (diff < 2_592_000) return `${Math.floor(diff / 86_400)}d ago`;
  return `${Math.floor(diff / 2_592_000)}mo ago`;
}

// ---------------------------------------------------------------------------
// Video card (no external links)
// ---------------------------------------------------------------------------

function VideoCard({ video }: { video: YouTubeVideo }) {
  return (
    <div className="flex gap-3 p-3 rounded-xl border border-slate-800/60 bg-slate-900/50 hover:border-slate-700 transition-all backdrop-blur">
      {video.thumbnailUrl ? (
        <img
          src={video.thumbnailUrl}
          alt={video.title}
          className="w-24 h-16 object-cover rounded-lg shrink-0 bg-slate-800"
        />
      ) : (
        <div className="w-24 h-16 rounded-lg shrink-0 bg-slate-800 flex items-center justify-center">
          <span className="text-red-400 text-xl">▶</span>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-200 leading-snug line-clamp-2">
          {video.title}
        </p>
        <p className="text-[11px] text-slate-500 mt-1">{video.channelTitle}</p>
        <div className="flex items-center gap-3 mt-1.5">
          <span className="text-[11px] text-slate-400">
            👁 {formatNumber(video.viewCount)}
          </span>
          <span className="text-[11px] text-slate-400">
            👍 {formatNumber(video.likeCount)}
          </span>
          <span className="text-[11px] text-slate-400">
            💬 {formatNumber(video.commentCount)}
          </span>
          <span className="text-[11px] text-slate-500" title={formatExactTime(video.publishedAt)}>
            {timeAgo(video.publishedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detailed Video Data table
// ---------------------------------------------------------------------------

function DetailedVideoTable({ videos }: { videos: YouTubeVideo[] }) {
  return (
    <div className="mt-6 rounded-xl border border-slate-800/60 bg-slate-900/50 backdrop-blur overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800/60">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          🎬 Detailed Video Data
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="border-b border-slate-800/60">
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Title
              </th>
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Channel
              </th>
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 text-right">
                Views
              </th>
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 text-right">
                Likes
              </th>
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 text-right">
                Comments
              </th>
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Published
              </th>
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Proof
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {videos.map((video) => (
              <tr
                key={video.id}
                className="hover:bg-slate-800/30 transition-colors"
              >
                <td className="px-4 py-3 max-w-[280px]">
                  <span
                    className="text-sm text-rose-400 font-medium truncate block"
                    title={video.title}
                  >
                    {video.title}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-blue-400 whitespace-nowrap">
                  {video.channelTitle}
                </td>
                <td className="px-4 py-3 text-sm text-slate-300 text-right whitespace-nowrap">
                  {formatNumber(video.viewCount)}
                </td>
                <td className="px-4 py-3 text-sm text-slate-300 text-right whitespace-nowrap">
                  {formatNumber(video.likeCount)}
                </td>
                <td className="px-4 py-3 text-sm text-slate-300 text-right whitespace-nowrap">
                  {formatNumber(video.commentCount)}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="text-sm text-slate-300 block">{formatExactTime(video.publishedAt)}</span>
                  <span className="text-[11px] text-slate-500">{timeAgo(video.publishedAt)}</span>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {video.proofUrl ? (
                    <a
                      href={video.proofUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-rose-400 hover:text-rose-300 transition-colors"
                    >
                      Open →
                    </a>
                  ) : (
                    <span className="text-sm text-slate-600">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface FeedResultsProps {
  videos: YouTubeVideo[];
}

/**
 * Initial number of videos rendered. Large collections (300+) are revealed
 * progressively so the UI never freezes while mounting hundreds of nodes at
 * once. The visible window applies to BOTH the card grid and the detailed
 * table; the header always reflects the true total.
 */
const INITIAL_VISIBLE = 60;
const REVEAL_STEP = 60;

export default function FeedResults({ videos }: FeedResultsProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

  // Reset the window whenever the underlying result set changes (new search).
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
  }, [videos]);

  if (videos.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800/60 bg-slate-900/50 p-12 text-center backdrop-blur">
        <p className="text-sm text-slate-500">No videos found for this keyword</p>
      </div>
    );
  }

  const visibleVideos = videos.slice(0, visibleCount);
  const remaining = videos.length - visibleVideos.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
          🎬 Video Results
        </h3>
        <span className="text-xs text-slate-600">
          {videos.length} videos
          {remaining > 0 && (
            <span className="text-slate-500"> · showing {visibleVideos.length}</span>
          )}
        </span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {visibleVideos.map((video) => (
          <VideoCard key={video.id} video={video} />
        ))}
      </div>

      {remaining > 0 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            onClick={() => setVisibleCount((c) => c + REVEAL_STEP)}
            className="inline-flex items-center gap-1 rounded-full border border-slate-700/60 bg-slate-800/40 px-4 py-1.5 text-xs text-slate-300 hover:bg-slate-800/70 transition-colors"
          >
            Show {Math.min(REVEAL_STEP, remaining)} more
          </button>
          <button
            onClick={() => setVisibleCount(videos.length)}
            className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-1.5 text-xs text-rose-400 hover:bg-rose-500/20 transition-colors"
          >
            Show all {videos.length}
          </button>
        </div>
      )}

      <DetailedVideoTable videos={visibleVideos} />
    </div>
  );
}
