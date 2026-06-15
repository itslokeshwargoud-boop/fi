/**
 * Target Expansion Engine (Phase 1).
 *
 * Telugu narrative discovery must NOT depend on English negative keywords
 * ("scam", "fraud", "exposed") — that misses most of the Telugu ecosystem.
 * Instead we expand a TARGET (a person) into all the ways creators refer to
 * them — Telugu script, transliteration, nicknames, public aliases — collect
 * every video mentioning the target, and classify negativity AFTER collection.
 *
 * The alias map is data-driven and configurable. Targets not in the map still
 * get systematic expansion (raw + Telugu intent modifiers), so discovery works
 * for any subject; curated aliases simply improve recall for known targets.
 */

export interface TargetAliases {
  /** Canonical display name. */
  canonical: string;
  /** All known surface forms: Telugu script, transliteration, nicknames. */
  aliases: string[];
}

/**
 * Seed alias dictionary (configurable / DB-backable). Keyed by lowercase
 * canonical. Telugu script + romanized + public nicknames.
 */
export const TARGET_ALIASES: Record<string, TargetAliases> = {
  prabhas: {
    canonical: "Prabhas",
    aliases: [
      "Prabhas",
      "ప్రభాస్",
      "Darling",
      "Rebel Star",
      "Prabhas Anna",
      "ప్రభాస్ అన్న",
      "Prabhas Raju",
      "ప్రభాస్ రాజు",
      "Baahubali",
      "బాహుబలి",
    ],
  },
  "pawan kalyan": {
    canonical: "Pawan Kalyan",
    aliases: [
      "Pawan Kalyan",
      "పవన్ కళ్యాణ్",
      "Power Star",
      "PSPK",
      "Pawan Anna",
      "పవన్",
    ],
  },
  "allu arjun": {
    canonical: "Allu Arjun",
    aliases: [
      "Allu Arjun",
      "అల్లు అర్జున్",
      "Bunny",
      "Icon Star",
      "Stylish Star",
      "బన్నీ",
    ],
  },
};

/**
 * Telugu + transliterated "intent" modifiers — NEUTRAL discovery boosters, not
 * negative pre-filters. They broaden coverage of the Telugu ecosystem.
 */
export const TELUGU_INTENT_MODIFIERS: string[] = [
  "interview",
  "latest",
  "news",
  "update",
  "speech",
  "వార్తలు", // news
  "లేటెస్ట్", // latest
  "ఇంటర్వ్యూ", // interview
  "గురించి", // about
];

export interface TargetExpansionOptions {
  /** Cap on number of expanded queries (incl. base). Default 16. */
  maxQueries?: number;
  /** Provide/override alias entries (e.g. from a DB). */
  aliasMap?: Record<string, TargetAliases>;
  /** Append Telugu intent modifiers to widen coverage. Default true. */
  withModifiers?: boolean;
}

/** Resolve curated aliases for a target (case-insensitive), if any. */
export function resolveAliases(
  target: string,
  aliasMap: Record<string, TargetAliases> = TARGET_ALIASES,
): TargetAliases | null {
  const key = target.trim().toLowerCase();
  if (aliasMap[key]) return aliasMap[key];
  // also match when the target equals a known alias
  for (const entry of Object.values(aliasMap)) {
    if (entry.aliases.some((a) => a.toLowerCase() === key)) return entry;
  }
  return null;
}

/**
 * Expand a target into discovery queries: aliases first (Telugu + romanized +
 * nicknames), then optional Telugu intent modifiers on the canonical name.
 * De-duplicated; canonical/base always included.
 */
export function expandTarget(
  target: string,
  options: TargetExpansionOptions = {},
): string[] {
  const trimmed = target.trim();
  if (!trimmed) return [];
  const maxQueries = Math.max(1, options.maxQueries ?? 16);
  const withModifiers = options.withModifiers ?? true;

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const v = q.trim();
    const k = v.toLowerCase();
    if (v && !seen.has(k) && out.length < maxQueries) {
      seen.add(k);
      out.push(v);
    }
  };

  push(trimmed);
  const resolved = resolveAliases(trimmed, options.aliasMap);
  if (resolved) {
    push(resolved.canonical);
    for (const a of resolved.aliases) push(a);
  }
  if (withModifiers) {
    const baseName = resolved?.canonical ?? trimmed;
    for (const m of TELUGU_INTENT_MODIFIERS) push(`${baseName} ${m}`);
  }
  return out;
}

/**
 * Does `text` mention the target (via any alias / the canonical name)?
 * Handles Telugu script, romanized, and code-mixed text. Used to keep a
 * collected video in-scope BEFORE any negativity classification.
 */
export function mentionsTarget(
  text: string,
  target: string,
  aliasMap: Record<string, TargetAliases> = TARGET_ALIASES,
): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  const forms = new Set<string>([target.trim().toLowerCase()]);
  const resolved = resolveAliases(target, aliasMap);
  if (resolved) {
    forms.add(resolved.canonical.toLowerCase());
    resolved.aliases.forEach((a) => forms.add(a.toLowerCase()));
  }
  for (const f of forms) {
    if (f && hay.includes(f)) return true;
  }
  return false;
}
