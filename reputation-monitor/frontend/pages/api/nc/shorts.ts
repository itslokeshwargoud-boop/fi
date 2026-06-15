/** GET /api/nc/shorts — shorts slice of NC intelligence. */
import type { NextApiRequest, NextApiResponse } from "next";
import { getNCIntelligence } from "@/lib/nc/ncService";
import { ncQueryFrom } from "./_shared";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  try {
    const intel = await getNCIntelligence(ncQueryFrom(req));
    return res.status(200).json(intel.shorts);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}
