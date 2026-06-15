/**
 * NC narrative engine — semantic narrative clustering.
 *
 * The brief is explicit: detection must NOT be keyword-only. So this builds a
 * TF-IDF vector space over the (normalized) corpus and groups items by cosine
 * similarity — i.e. items cluster by *shared distinctive vocabulary*, not by a
 * single hard-coded keyword. Cluster labels are generated from each cluster's
 * top TF-IDF terms, and a coarse NarrativeType is inferred from those terms.
 *
 * This mirrors the TF-IDF narrative clustering already used elsewhere in the
 * platform. The optional Python layer (narrative_service.py) can replace these
 * vectors with sentence-transformer embeddings + FAISS/DBSCAN at scale; the
 * output contract (NCNarrativeCluster) is identical either way.
 */

import { normalizeText } from "./preprocess";
import type { NarrativeType, NCNarrativeCluster } from "./types";

export interface NarrativeDoc {
  id: string;
  text: string;
  sentiment: number; // -1..1
  toxicity: number; // 0..1
  channel: string;
  publishedAt: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "this", "that", "and", "or", "but",
  "to", "of", "in", "on", "for", "with", "he", "she", "it", "they", "you",
  "i", "we", "me", "my", "his", "her", "so", "not", "no", "yes", "very",
  "doing", "money", "soap", "video", "channel", "youtube",
]);

/** Terms that signpost each narrative family (used only for *labelling*). */
const TYPE_SIGNALS: Record<Exclude<NarrativeType, "other">, string[]> = {
  authenticity_attack: ["fake", "lipsync", "paid", "cheat", "duplicate"],
  overaction_criticism: ["overaction", "drama", "acting", "expression"],
  industry_politics: ["industry", "politics", "lobby", "group", "camp"],
  controversy_amplification: ["controversy", "issue", "scandal", "leaked"],
  troll_targeting: ["expose", "exposed", "troll", "target"],
  fan_war: ["fan", "vs", "war", "hero", "fans"],
  harassment: ["shameless", "beggar", "boycott", "ban"],
};

const MIN_DF = 2; // term must appear in >= 2 docs to matter
const SIM_THRESHOLD = 0.18; // cosine threshold to join a cluster
const MAX_CLUSTERS = 8;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

interface Vector {
  doc: NarrativeDoc;
  terms: string[];
  weights: Map<string, number>;
  norm: number;
}

function buildVectors(docs: NarrativeDoc[]): Vector[] {
  const tokenized = docs.map((d) => ({
    doc: d,
    terms: normalizeText(d.text).tokens.filter(
      (t) => t.length > 2 && !STOPWORDS.has(t),
    ),
  }));

  // Document frequency
  const df = new Map<string, number>();
  for (const { terms } of tokenized) {
    for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const N = docs.length || 1;
  const vectors: Vector[] = [];

  for (const { doc, terms } of tokenized) {
    const tf = new Map<string, number>();
    for (const t of terms) {
      if ((df.get(t) ?? 0) < MIN_DF) continue;
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    const weights = new Map<string, number>();
    let sq = 0;
    for (const [t, c] of tf) {
      const idf = Math.log(N / (df.get(t) ?? 1)) + 1;
      const w = c * idf;
      weights.set(t, w);
      sq += w * w;
    }
    vectors.push({
      doc,
      terms: [...tf.keys()],
      weights,
      norm: Math.sqrt(sq) || 1,
    });
  }
  return vectors;
}

function cosine(a: Vector, b: Vector): number {
  // iterate the smaller term set
  const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small.weights) {
    const ow = large.weights.get(t);
    if (ow) dot += w * ow;
  }
  return dot / (a.norm * b.norm);
}

function inferType(keyTerms: string[]): NarrativeType {
  let best: NarrativeType = "other";
  let bestScore = 0;
  for (const [type, signals] of Object.entries(TYPE_SIGNALS) as [
    Exclude<NarrativeType, "other">,
    string[],
  ][]) {
    const score = keyTerms.filter((t) =>
      signals.some((s) => t.includes(s) || s.includes(t)),
    ).length;
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
  }
  return best;
}

function labelFromTerms(keyTerms: string[], type: NarrativeType): string {
  if (keyTerms.length === 0) return "Unclassified narrative";
  const pretty = keyTerms.slice(0, 3).join(" / ");
  const typeName: Record<NarrativeType, string> = {
    authenticity_attack: "Authenticity attack",
    overaction_criticism: "Performance criticism",
    industry_politics: "Industry politics",
    controversy_amplification: "Controversy amplification",
    troll_targeting: "Targeted trolling",
    fan_war: "Fan-war",
    harassment: "Harassment",
    other: "Narrative",
  };
  return `${typeName[type]}: ${pretty}`;
}

/**
 * Greedy single-pass clustering: assign each doc to the most similar existing
 * cluster centroid above SIM_THRESHOLD, else start a new cluster. O(n·k),
 * which is appropriate for the per-request volumes in the Next layer. (The
 * Python layer uses DBSCAN for batch-scale clustering.)
 */
export function clusterNarratives(docs: NarrativeDoc[]): NCNarrativeCluster[] {
  if (docs.length === 0) return [];
  const vectors = buildVectors(docs);

  const clusters: { members: Vector[]; centroidTerms: Map<string, number> }[] = [];

  for (const v of vectors) {
    if (v.weights.size === 0) continue;
    let bestIdx = -1;
    let bestSim = SIM_THRESHOLD;
    for (let i = 0; i < clusters.length; i++) {
      // represent centroid by its best member for sim (cheap, stable)
      const rep = clusters[i].members[0];
      const sim = cosine(v, rep);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      clusters.push({ members: [v], centroidTerms: new Map(v.weights) });
    } else {
      clusters[bestIdx].members.push(v);
      for (const [t, w] of v.weights) {
        clusters[bestIdx].centroidTerms.set(
          t,
          (clusters[bestIdx].centroidTerms.get(t) ?? 0) + w,
        );
      }
    }
  }

  const totalMembers = clusters.reduce((s, c) => s + c.members.length, 0) || 1;
  const now = Date.now();

  const out: NCNarrativeCluster[] = clusters
    .filter((c) => c.members.length >= 1)
    .map((c, idx) => {
      const keyTerms = [...c.centroidTerms.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t]) => t);
      const type = inferType(keyTerms);

      const size = c.members.length;
      const sentiment =
        c.members.reduce((s, m) => s + m.doc.sentiment, 0) / size;
      const toxicity =
        c.members.reduce((s, m) => s + m.doc.toxicity, 0) / size;

      const recent = c.members.filter(
        (m) => now - new Date(m.doc.publishedAt).getTime() < MS_PER_WEEK,
      ).length;
      const recentRatio = recent / size;
      const trend: NCNarrativeCluster["trend"] =
        recentRatio > 0.5 ? "growing" : recentRatio < 0.2 ? "declining" : "stable";

      return {
        id: `nc_narr_${idx}`,
        label: labelFromTerms(keyTerms, type),
        type,
        size,
        percentage: parseFloat(((size / totalMembers) * 100).toFixed(1)),
        sentiment: parseFloat(sentiment.toFixed(3)),
        toxicity: parseFloat(toxicity.toFixed(3)),
        trend,
        keyTerms,
        sampleTexts: c.members.slice(0, 4).map((m) => m.doc.text.slice(0, 220)),
        relatedChannels: [...new Set(c.members.map((m) => m.doc.channel))].slice(0, 8),
      };
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_CLUSTERS);

  return out;
}
