/**
 * /api/reputation-os/[tenant]/nc/evidence?channel=<channelKey>
 * Per-channel evidence bundle for the Evidence Drawer.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import type { NCChannelEvidence } from "@/lib/nc/types";
import { getNCChannelEvidence } from "@/lib/nc/ncService";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<NCChannelEvidence | { error: string }>,
) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  const channel = typeof req.query.channel === "string" ? req.query.channel.trim() : "";
  if (!channel) return res.status(400).json({ error: "Missing 'channel' query param" });
  try {
    const bundle = await getNCChannelEvidence(channel, {
      keyword: typeof req.query.keyword === "string" ? req.query.keyword : undefined,
      startDate: typeof req.query.startDate === "string" ? req.query.startDate : undefined,
      endDate: typeof req.query.endDate === "string" ? req.query.endDate : undefined,
    });
    if (!bundle) return res.status(404).json({ error: "Channel not found" });
    return res.status(200).json(bundle);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}
