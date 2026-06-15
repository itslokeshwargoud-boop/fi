/**
 * NC server service — shared by all NC API routes.
 *
 * Wraps the unified data-ingestion layer + the NC engine so every route
 * (tenant-scoped UI routes and the public /api/nc/* namespace) goes through one
 * code path. Server-only: imports the SQLite-backed ingestion layer.
 */

import { ingestData, type DateFilter } from "@/lib/dataIngestion";
import { ANIL_DISPLAY_NAME } from "@/lib/constants";
import { buildNCIntelligence, buildChannelEvidence, slug } from "./ncEngine";
import { fetchTranscriptsForVideos } from "./transcriptIngest";
import type { NCChannelEvidence, NCIntelligence } from "./types";

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export interface NCQuery {
  keyword?: string;
  startDate?: string;
  endDate?: string;
}

function parseQuery(q: NCQuery): { keyword: string; dateFilter?: DateFilter } {
  const keyword =
    q.keyword && q.keyword.trim() ? q.keyword.trim() : ANIL_DISPLAY_NAME;
  const start = (q.startDate ?? "").trim();
  const end = (q.endDate ?? "").trim();
  const dateFilter =
    DATE_RX.test(start) && DATE_RX.test(end) && start <= end
      ? { startDate: start, endDate: end }
      : undefined;
  return { keyword, dateFilter };
}

/** Build the full NC intelligence payload for a keyword/date window. */
export async function getNCIntelligence(q: NCQuery): Promise<NCIntelligence> {
  const { keyword, dateFilter } = parseQuery(q);
  // deep=true → reuse Feed's full collection engine so NC analyzes the FULL
  // ingestion volume (hundreds of videos), date-scoped to the selected window.
  const data = await ingestData(keyword, {}, dateFilter, { deep: true });
  return buildNCIntelligence(data);
}

/** Build the per-channel evidence bundle for the drawer. */
export async function getNCChannelEvidence(
  channelKey: string,
  q: NCQuery,
): Promise<NCChannelEvidence | null> {
  const { keyword, dateFilter } = parseQuery(q);
  const data = await ingestData(keyword, {}, dateFilter, { deep: true });

  // Issue 3: pull spoken-transcript captions for THIS channel's videos only
  // (bounded + capped concurrency), so the drawer surfaces timestamped
  // transcript evidence. Best-effort: degrades to title/comment evidence when
  // captions are unavailable. Authoritative at-scale source is the backend
  // caption→Whisper pipeline.
  const channelVideoIds = data.videos
    .filter((v) => slug(v.channelTitle) === channelKey)
    .map((v) => v.id);
  if (channelVideoIds.length > 0) {
    try {
      const transcripts = await fetchTranscriptsForVideos(channelVideoIds, {
        maxVideos: 25,
        concurrency: 4,
      });
      if (Object.keys(transcripts).length > 0) {
        data.transcripts = { ...(data.transcripts ?? {}), ...transcripts };
      }
    } catch {
      /* graceful: keep title/comment evidence */
    }
  }

  return buildChannelEvidence(data, channelKey);
}
