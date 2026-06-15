/**
 * NC text preprocessing pipeline.
 *
 * Handles the messy reality of Telugu YouTube comment/title text:
 *   - Telugu Unicode (\u0C00–\u0C7F)
 *   - transliterated Telugu ("idhi fake ra", "overaction chesthundi")
 *   - Telugu–English code-mixing
 *   - emoji / zero-width / repeated-char noise
 *   - slang normalization to canonical forms
 *
 * This is deliberately model-free so it runs inside the Next.js processing
 * layer on every request. The heavier multilingual transformer normalization
 * lives in the optional Python enrichment layer (backend/modules/nc).
 */

const TELUGU_RANGE = /[\u0C00-\u0C7F]/;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
// Emoji + pictographs (broad, intentionally conservative).
const EMOJI =
  /[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * Canonical slang / transliteration map. Keys are matched as whole tokens
 * (case-insensitive). Extend freely — this is intentionally data-driven so the
 * lexicon can grow without code changes.
 */
const SLANG_MAP: Record<string, string> = {
  // transliteration variants -> canonical
  fakeu: "fake",
  fek: "fake",
  ovaraction: "overaction",
  overacting: "overaction",
  oveaction: "overaction",
  cheats: "cheat",
  cheating: "cheat",
  chesthundi: "doing",
  chesthunnadu: "doing",
  chestunnadu: "doing",
  chestunnaru: "doing",
  paisa: "money",
  paid: "paid",
  sabbu: "soap", // common dismissive slang
  // intensifier slang frequently attached to attacks
  ra: "",
  rey: "",
  bro: "",
  anna: "",
};

const MULTISPACE = /\s+/g;
const REPEAT_CHARS = /(.)\1{2,}/g; // "fakeeee" -> "fakee"

export interface NormalizedText {
  /** Lowercased, de-noised text used for matching/scoring. */
  normalized: string;
  /** Whitespace-tokenized terms after slang folding (no empties). */
  tokens: string[];
  /** True if any Telugu-script codepoints were present. */
  hasTelugu: boolean;
  /** True if both Latin and Telugu scripts appear (code-mixed). */
  isCodeMixed: boolean;
}

export function normalizeText(raw: string): NormalizedText {
  const source = raw ?? "";
  const hasTelugu = TELUGU_RANGE.test(source);
  const hasLatin = /[a-zA-Z]/.test(source);

  const s = source
    .replace(ZERO_WIDTH, "")
    .replace(EMOJI, " ")
    .toLowerCase()
    .replace(REPEAT_CHARS, "$1$1") // collapse 3+ repeats to 2
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // strip punctuation, keep letters/numbers
    .replace(MULTISPACE, " ")
    .trim();

  // Slang / transliteration folding, token by token.
  const tokens: string[] = [];
  for (const tok of s.split(" ")) {
    if (!tok) continue;
    const mapped = SLANG_MAP[tok];
    if (mapped === undefined) {
      tokens.push(tok);
    } else if (mapped !== "") {
      tokens.push(mapped);
    }
    // mapped === "" drops the filler token entirely
  }

  return {
    normalized: tokens.join(" "),
    tokens,
    hasTelugu,
    isCodeMixed: hasTelugu && hasLatin,
  };
}

/** Convenience: register additional slang at runtime (e.g. from DB lexicon). */
export function registerSlang(entries: Record<string, string>): void {
  Object.assign(SLANG_MAP, entries);
}
