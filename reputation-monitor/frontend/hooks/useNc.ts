/**
 * useNc — React hook for the NC (Narrative Control) console.
 *
 * Mirrors useReputationOs: React Query for caching/dedup/background refresh,
 * scoped to the shared active keyword + date window from KeywordContext.
 *
 * Adds configurable live polling (refetchInterval) so the threat console can
 * stay current without a WebSocket. Channel evidence is fetched lazily by key.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchNCIntelligence, fetchNCChannelEvidence } from "@/lib/nc/ncClient";
import { ANIL_DISPLAY_NAME } from "@/lib/constants";
import { useKeyword } from "@/contexts/KeywordContext";
import type { NCChannelEvidence, NCIntelligence } from "@/lib/nc/types";

const STALE_TIME = 30_000;

export interface UseNcOptions {
  /** Poll interval in ms. 0/undefined disables polling. */
  pollMs?: number;
}

export function useNc(options: UseNcOptions = {}) {
  const { activeKeyword, startDate, endDate } = useKeyword();
  const keyword = activeKeyword.trim() || ANIL_DISPLAY_NAME;
  const pollMs = options.pollMs && options.pollMs > 0 ? options.pollMs : undefined;

  const intelligence: UseQueryResult<NCIntelligence> = useQuery({
    queryKey: ["nc-intel", keyword, startDate, endDate],
    queryFn: () =>
      fetchNCIntelligence(keyword, startDate || undefined, endDate || undefined),
    staleTime: STALE_TIME,
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });

  return { intelligence, keyword, startDate, endDate };
}

/** Lazy per-channel evidence query (enabled only when a channel is selected). */
export function useNcChannelEvidence(channelKey: string | null) {
  const { activeKeyword, startDate, endDate } = useKeyword();
  const keyword = activeKeyword.trim() || ANIL_DISPLAY_NAME;

  return useQuery<NCChannelEvidence>({
    queryKey: ["nc-evidence", channelKey, keyword, startDate, endDate],
    queryFn: () =>
      fetchNCChannelEvidence(
        channelKey as string,
        keyword,
        startDate || undefined,
        endDate || undefined,
      ),
    enabled: !!channelKey,
    staleTime: STALE_TIME,
  });
}
