/**
 * Live-path transcript ingestion (Issue 3).
 *
 * Best-effort YouTube caption fetch for the NC Evidence Drawer, following the
 * brief's priority order: official captions → auto-generated captions. (The
 * Whisper fallback is the backend pipeline's job — see
 * `backend/modules/nc/youtube_transcript_service.py`; transcribing audio
 * synchronously in a serverless request is not viable at feed scale.)
 *
 * This module is DETERMINISTIC and GRACEFUL: it never throws, and when captions
 * are unavailable (disabled, none present, or no network) it returns an empty
 * segment list so evidence cleanly falls back to titles + comments. It never
 * fabricates transcript text.
 *
 * Fetching is bounded (per-channel, capped concurrency) so it stays within the
 * performance envelope — the full intelligence payload is never blocked on it.
 */

import type { TranscriptSegment } from "@/lib/dataIngestion";
import { normalizeText } from "./preprocess";

const TIMEDTEXT = "https://video.google.com/timedtext";
const PREFERRED_LANGS = ["te", "en"];
const FETCH_TIMEOUT_MS = 4000;

async function withTimeout(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null; // network blocked / aborted / offline → graceful
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the timedtext XML payload (`<text start="12.3" dur="2.1">…</text>`)
 * into normalized, de-duplicated segments. Exported for unit testing without
 * network access.
 */
export function parseTimedText(xml: string): TranscriptSegment[] {
  if (!xml || xml.indexOf("<text") === -1) return [];
  const segs: TranscriptSegment[] = [];
  const seen = new Set<string>();
  const re = /<text[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const raw = decodeEntities(m[2]);
    const text = normalizeText(raw).normalized || raw.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue; // caption tracks repeat lines across cues
    seen.add(key);
    if (Number.isFinite(start)) segs.push({ start, text });
  }
  return segs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch captions for one video (official preferred, then auto). Graceful. */
export async function fetchTranscriptSegments(
  videoId: string,
): Promise<TranscriptSegment[]> {
  for (const lang of PREFERRED_LANGS) {
    // Manually-created track first.
    const manual = await withTimeout(`${TIMEDTEXT}?lang=${lang}&v=${videoId}`);
    const segs = manual ? parseTimedText(manual) : [];
    if (segs.length) return segs;
    // Auto-generated track (kind=asr).
    const auto = await withTimeout(`${TIMEDTEXT}?lang=${lang}&kind=asr&v=${videoId}`);
    const autoSegs = auto ? parseTimedText(auto) : [];
    if (autoSegs.length) return autoSegs;
  }
  return [];
}

/**
 * Fetch transcripts for a bounded set of video ids with capped concurrency.
 * Returns a map keyed by video id; videos without captions are omitted.
 */
export async function fetchTranscriptsForVideos(
  videoIds: string[],
  opts: { maxVideos?: number; concurrency?: number } = {},
): Promise<Record<string, TranscriptSegment[]>> {
  const maxVideos = opts.maxVideos ?? 25;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const ids = videoIds.slice(0, maxVideos);
  const out: Record<string, TranscriptSegment[]> = {};

  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const segs = await fetchTranscriptSegments(id);
      if (segs.length) out[id] = segs;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

export type CaptionSource = "official_caption" | "auto_caption" | "none";

/**
 * Caption fetch that also reports the SOURCE (official vs auto vs none), needed
 * by the real-world coverage report. "none" means no caption track was found —
 * those videos require the backend Whisper pipeline. Graceful: never throws.
 */
export async function fetchTranscriptWithSource(
  videoId: string,
): Promise<{ segments: TranscriptSegment[]; source: CaptionSource }> {
  for (const lang of PREFERRED_LANGS) {
    const manual = await withTimeout(`${TIMEDTEXT}?lang=${lang}&v=${videoId}`);
    const segs = manual ? parseTimedText(manual) : [];
    if (segs.length) return { segments: segs, source: "official_caption" };
    const auto = await withTimeout(`${TIMEDTEXT}?lang=${lang}&kind=asr&v=${videoId}`);
    const autoSegs = auto ? parseTimedText(auto) : [];
    if (autoSegs.length) return { segments: autoSegs, source: "auto_caption" };
  }
  return { segments: [], source: "none" };
}

/**
 * Source-aware bulk fetch for the coverage report. Returns the transcript map
 * AND a per-video source map (official_caption | auto_caption | none).
 */
export async function fetchTranscriptsWithSourcesForVideos(
  videoIds: string[],
  opts: { maxVideos?: number; concurrency?: number } = {},
): Promise<{
  transcripts: Record<string, TranscriptSegment[]>;
  sources: Record<string, CaptionSource>;
}> {
  const maxVideos = opts.maxVideos ?? 1000;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const ids = videoIds.slice(0, maxVideos);
  const transcripts: Record<string, TranscriptSegment[]> = {};
  const sources: Record<string, CaptionSource> = {};

  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const { segments, source } = await fetchTranscriptWithSource(id);
      sources[id] = source;
      if (segments.length) transcripts[id] = segments;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { transcripts, sources };
}
