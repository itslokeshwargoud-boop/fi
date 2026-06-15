/**
 * /api/reputation-os/[tenant]/nc/intelligence
 * Full NC intelligence payload (metrics, channels, narratives, timeline, shorts).
 * Powers the NC console in a single fetch.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import type { NCIntelligence } from "@/lib/nc/types";
import { getNCIntelligence } from "@/lib/nc/ncService";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<NCIntelligence | { error: string }>,
) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  try {
    const intel = await getNCIntelligence({
      keyword: typeof req.query.keyword === "string" ? req.query.keyword : undefined,
      startDate: typeof req.query.startDate === "string" ? req.query.startDate : undefined,
      endDate: typeof req.query.endDate === "string" ? req.query.endDate : undefined,
    });
    return res.status(200).json(intel);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}
