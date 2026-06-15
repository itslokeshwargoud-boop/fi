/**
 * ───────────────────────────────────────────────────────────────────────────
 *  Intelligent Query Expansion Engine
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  Turns a single search keyword into a set of intelligent variations so the
 *  collection engine covers far more of the result space than a single query
 *  ever could — reducing blind spots and maximising unique-video coverage.
 *
 *      expandQuery("Mr Beast")
 *      → ["Mr Beast", "Mr Beast latest", "Mr Beast interview", ...]
 *
 *  Fully configurable and scalable: the modifier set and the cap are both
 *  adjustable, and the base query is always included first so existing
 *  single-query expectations are preserved.
 * ───────────────────────────────────────────────────────────────────────────
 */

/**
 * Default "intent" modifiers appended to the base query. Chosen to surface
 * recent, newsworthy, and high-engagement coverage of a subject.
 */
export const DEFAULT_QUERY_MODIFIERS: string[] = [
  "latest",
  "interview",
  "news",
  "viral",
  "podcast",
  "controversy",
  "trending",
  "review",
  "highlights",
  "update",
];

export interface QueryExpansionOptions {
  /** Override the modifier list. */
  modifiers?: string[];
  /**
   * Maximum number of expanded queries to emit (including the base query).
   * Defaults to 8. Set to 1 to disable expansion entirely.
   */
  maxQueries?: number;
}

/**
 * Expand a base query into multiple intelligent variations.
 * The original query is always element 0. Output is de-duplicated and trimmed.
 */
export function expandQuery(
  base: string,
  options: QueryExpansionOptions = {}
): string[] {
  const trimmed = base.trim();
  if (!trimmed) return [];

  const maxQueries = Math.max(1, options.maxQueries ?? 8);
  const modifiers = options.modifiers ?? DEFAULT_QUERY_MODIFIERS;

  const out: string[] = [trimmed];
  const seen = new Set<string>([trimmed.toLowerCase()]);

  for (const mod of modifiers) {
    if (out.length >= maxQueries) break;
    const variant = `${trimmed} ${mod}`.trim();
    const key = variant.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(variant);
    }
  }

  return out;
}
