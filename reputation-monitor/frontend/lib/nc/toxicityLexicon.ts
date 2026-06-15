/**
 * NC toxicity scoring — extensible Telugu/English abuse lexicon.
 *
 * This is the always-on, model-free toxicity signal used inside the Next.js
 * processing layer. It is intentionally architected as a *weighted, categorized
 * dictionary* so it can be extended (and eventually overridden by the Detoxify
 * scores produced by the Python enrichment layer) without code changes.
 *
 * Categories follow the brief: insults, harassment, abuse, threats, hate.
 * The Python layer (toxicity_service.py) returns the same 0..1 shape, so the
 * UI/risk engine are agnostic to which produced the score.
 */

import { normalizeText } from "./preprocess";

export type ToxCategory =
  | "insult"
  | "harassment"
  | "abuse"
  | "threat"
  | "hate";

interface LexEntry {
  term: string;
  category: ToxCategory;
  weight: number; // 0..1 per-hit severity
}

/**
 * Seed lexicon. Romanized Telugu + English. Weights are conservative; the goal
 * is *ranking* signal, not moral judgement. Extend via `extendLexicon`.
 */
const SEED: LexEntry[] = [
  // insults (dismissive / demeaning)
  { term: "fake", category: "insult", weight: 0.4 },
  { term: "overaction", category: "insult", weight: 0.35 },
  { term: "cheat", category: "insult", weight: 0.5 },
  { term: "flop", category: "insult", weight: 0.3 },
  { term: "waste", category: "insult", weight: 0.3 },
  { term: "drama", category: "insult", weight: 0.25 },
  { term: "buffoon", category: "insult", weight: 0.5 },
  { term: "loser", category: "insult", weight: 0.5 },
  // harassment (targeted, repeated)
  { term: "expose", category: "harassment", weight: 0.45 },
  { term: "exposed", category: "harassment", weight: 0.5 },
  { term: "shameless", category: "harassment", weight: 0.55 },
  { term: "beggar", category: "harassment", weight: 0.6 },
  // abuse (vulgar)
  { term: "stupid", category: "abuse", weight: 0.5 },
  { term: "idiot", category: "abuse", weight: 0.55 },
  { term: "trash", category: "abuse", weight: 0.5 },
  { term: "dog", category: "abuse", weight: 0.55 },
  // threats
  { term: "destroy", category: "threat", weight: 0.6 },
  { term: "finish", category: "threat", weight: 0.55 },
  { term: "ban", category: "threat", weight: 0.4 },
  { term: "boycott", category: "threat", weight: 0.6 },
  // hate (group-directed)
  { term: "industry", category: "hate", weight: 0.2 }, // weak on its own, contextual
  { term: "paid", category: "hate", weight: 0.35 },
  // --- Telugu deception / abuse (romanized) — Phase 6 ---
  { term: "mosam", category: "harassment", weight: 0.55 }, // deception/cheating
  { term: "mosagadu", category: "harassment", weight: 0.6 }, // cheater
  { term: "daga", category: "harassment", weight: 0.5 }, // betrayal
  { term: "dongatanam", category: "harassment", weight: 0.5 }, // theft/dishonesty
  { term: "neechudu", category: "abuse", weight: 0.6 }, // vile person
  { term: "chetta", category: "abuse", weight: 0.5 }, // trash
  { term: "nikrushtudu", category: "abuse", weight: 0.6 }, // despicable
  { term: "deshadrohi", category: "hate", weight: 0.6 }, // traitor
  { term: "dimba", category: "insult", weight: 0.35 },
  // --- Telugu deception / abuse (Telugu Unicode) ---
  { term: "మోసం", category: "harassment", weight: 0.55 },
  { term: "మోసగాడు", category: "harassment", weight: 0.6 },
  { term: "దగా", category: "harassment", weight: 0.5 },
  { term: "నీచుడు", category: "abuse", weight: 0.6 },
  { term: "చెత్త", category: "abuse", weight: 0.5 },
  { term: "దేశద్రోహి", category: "hate", weight: 0.6 },
  { term: "ఫేక్", category: "insult", weight: 0.4 }, // "fake"
];

const LEXICON = new Map<string, LexEntry>(SEED.map((e) => [e.term, e]));

export interface ToxicityResult {
  score: number; // 0..1
  category: ToxCategory | null; // dominant category, null if clean
  hits: { term: string; category: ToxCategory; weight: number }[];
}

/**
 * Score a single text. Saturating sum so a few strong hits → high score but a
 * single weak word stays low. Normalization handles transliteration/slang.
 */
export function scoreToxicity(raw: string): ToxicityResult {
  const { tokens } = normalizeText(raw);
  if (tokens.length === 0) return { score: 0, category: null, hits: [] };

  const hits: ToxicityResult["hits"] = [];
  const categoryWeight = new Map<ToxCategory, number>();

  for (const tok of tokens) {
    const entry = LEXICON.get(tok);
    if (!entry) continue;
    hits.push({ term: entry.term, category: entry.category, weight: entry.weight });
    categoryWeight.set(
      entry.category,
      (categoryWeight.get(entry.category) ?? 0) + entry.weight,
    );
  }

  if (hits.length === 0) return { score: 0, category: null, hits: [] };

  // Saturating aggregation: 1 - Π(1 - w). Caps at 1, rewards multiple hits.
  const score = 1 - hits.reduce((acc, h) => acc * (1 - h.weight), 1);

  // Dominant category = highest accumulated weight.
  let category: ToxCategory | null = null;
  let best = -1;
  for (const [cat, w] of categoryWeight) {
    if (w > best) {
      best = w;
      category = cat;
    }
  }

  return { score: Math.min(1, parseFloat(score.toFixed(3))), category, hits };
}

/** Add/override lexicon entries at runtime (e.g. from the DB abuse table). */
export function extendLexicon(entries: LexEntry[]): void {
  for (const e of entries) LEXICON.set(e.term, e);
}

/** Whether a text crosses the toxic threshold (used by the evidence engine). */
export function isToxic(raw: string, threshold = 0.45): boolean {
  return scoreToxicity(raw).score >= threshold;
}
