/**
 * Pure date-window helpers for NC time-based filtering (Issue 2).
 *
 * Kept dependency-free (no DB, no model) so the temporal logic is unit-testable
 * in isolation and reusable across ingestion, clustering and evidence paths.
 * The window is inclusive on both ends; the end date covers the full day.
 */

export interface DateWindow {
  startDate?: string; // YYYY-MM-DD inclusive
  endDate?: string;   // YYYY-MM-DD inclusive (extended to 23:59:59Z)
}

/** True when the window has both bounds set. */
export function hasWindow(w?: DateWindow): w is Required<DateWindow> {
  return !!(w?.startDate && w?.endDate);
}

/** Inclusive membership test for an ISO publishedAt against the window. */
export function isWithinWindow(publishedAt: string, w?: DateWindow): boolean {
  if (!hasWindow(w)) return true; // no window → everything passes
  const t = new Date(publishedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const start = new Date(w.startDate + "T00:00:00Z").getTime();
  const end = new Date(w.endDate + "T23:59:59Z").getTime();
  return t >= start && t <= end;
}

/** Filter any items carrying a `publishedAt` ISO string by the window. */
export function filterByWindow<T extends { publishedAt: string }>(
  items: T[],
  w?: DateWindow,
): T[] {
  if (!hasWindow(w)) return items;
  return items.filter((it) => isWithinWindow(it.publishedAt, w));
}
