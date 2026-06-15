/** Shared query parsing for the public /api/nc/* namespace. */
import type { NextApiRequest } from "next";
export function ncQueryFrom(req: NextApiRequest) {
  return {
    keyword: typeof req.query.keyword === "string" ? req.query.keyword : undefined,
    startDate: typeof req.query.startDate === "string" ? req.query.startDate : undefined,
    endDate: typeof req.query.endDate === "string" ? req.query.endDate : undefined,
  };
}
export function intParam(v: unknown, def: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}
