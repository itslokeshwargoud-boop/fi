/**
 * NC client — browser-side fetchers for the NC console.
 * Calls the tenant-scoped Next.js API routes (same pattern as lib/reputationOs.ts).
 */

import { ANIL_TENANT_ID } from "@/lib/constants";
import type { NCChannelEvidence, NCIntelligence } from "./types";

const BASE = `/api/reputation-os/${ANIL_TENANT_ID}/nc`;

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && v.trim()) sp.set(k, v.trim());
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(`NC API ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export function fetchNCIntelligence(
  keyword?: string,
  startDate?: string,
  endDate?: string,
): Promise<NCIntelligence> {
  return getJSON<NCIntelligence>(`${BASE}/intelligence${qs({ keyword, startDate, endDate })}`);
}

export function fetchNCChannelEvidence(
  channelKey: string,
  keyword?: string,
  startDate?: string,
  endDate?: string,
): Promise<NCChannelEvidence> {
  return getJSON<NCChannelEvidence>(
    `${BASE}/evidence${qs({ channel: channelKey, keyword, startDate, endDate })}`,
  );
}
