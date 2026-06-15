/**
 * GET /api/nc/channels — paginated, filterable, sortable channel intelligence.
 * Query: keyword, startDate, endDate, risk(LOW|MEDIUM|HIGH|CRITICAL),
 *        narrative, sort(riskScore|reach|flaggedVideoCount|lastActive),
 *        order(asc|desc), page, pageSize.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { getNCIntelligence } from "@/lib/nc/ncService";
import { ncQueryFrom, intParam } from "./_shared";
import type { NCChannel } from "@/lib/nc/types";

type SortKey = "riskScore" | "reach" | "flaggedVideoCount" | "lastActive";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  try {
    const intel = await getNCIntelligence(ncQueryFrom(req));
    let rows: NCChannel[] = intel.channels;

    const risk = typeof req.query.risk === "string" ? req.query.risk.toUpperCase() : "";
    if (risk) rows = rows.filter((c) => c.riskLevel === risk);
    const narrative = typeof req.query.narrative === "string" ? req.query.narrative : "";
    if (narrative) rows = rows.filter((c) => c.narrativeTypes.includes(narrative as NCChannel["dominantNarrative"]));

    const sort = (typeof req.query.sort === "string" ? req.query.sort : "riskScore") as SortKey;
    const order = req.query.order === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = a[sort]; const bv = b[sort];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * order;
      return String(av).localeCompare(String(bv)) * order;
    });

    const page = intParam(req.query.page, 1);
    const pageSize = Math.min(100, intParam(req.query.pageSize, 25));
    const total = rows.length;
    const start = (page - 1) * pageSize;
    const items = rows.slice(start, start + pageSize);

    return res.status(200).json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}
