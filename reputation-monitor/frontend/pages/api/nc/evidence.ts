/** GET /api/nc/evidence?channel=<key> — per-channel evidence bundle. */
import type { NextApiRequest, NextApiResponse } from "next";
import { getNCChannelEvidence } from "@/lib/nc/ncService";
import { ncQueryFrom } from "./_shared";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  const channel = typeof req.query.channel === "string" ? req.query.channel.trim() : "";
  if (!channel) return res.status(400).json({ error: "Missing 'channel' query param" });
  try {
    const bundle = await getNCChannelEvidence(channel, ncQueryFrom(req));
    if (!bundle) return res.status(404).json({ error: "Channel not found" });
    return res.status(200).json(bundle);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}
