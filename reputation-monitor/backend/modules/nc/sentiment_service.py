"""Multilingual sentiment for the NC module.

Replaces the previous "toxicity-as-negative-sentiment" proxy with a real
sentiment pipeline that emits five dimensions the risk engine consumes:
``positive``, ``neutral``, ``negative``, ``aggressive``, ``inflammatory``.

Two tiers, both real:

1. **Model tier** — XLM-R / multilingual-RoBERTa sentiment via the shared model
   registry (lazy, batched, GPU/CPU aware). Long inputs (transcripts) are
   chunked and aggregated.
2. **Deterministic tier** — a multilingual valence lexicon (Telugu, romanized
   Telugu, English) that always runs. ``aggressive`` is driven by
   imperative/call-to-action cues, ``inflammatory`` by high-arousal negativity.
   This is materially better than the old toxicity proxy and guarantees the
   pipeline produces sentiment even with no model installed.

The model tier only ever *refines* the deterministic tier; if it is absent the
system degrades cleanly.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from modules.nc import model_registry
from modules.nc.preprocessing import normalize_text, tokenize

logger = logging.getLogger("nc")

_MODEL_KEY = "nc_sentiment_xlmr"
_MODEL_NAME = "cardiffnlp/twitter-xlm-roberta-base-sentiment"
_CHUNK_TOKENS = 128

# --- Deterministic multilingual valence lexicon (extensible) ---
_NEGATIVE = {
    "fake", "fraud", "flop", "worst", "bad", "boring", "waste", "cheap",
    "overaction", "nonsense", "trash", "disaster", "pathetic", "shameless",
    "చెత్త", "దారుణం", "మోసం", "ఫట్", "నాసిరకం",
}
_POSITIVE = {
    "great", "best", "blockbuster", "superb", "amazing", "love", "loved",
    "excellent", "mass", "hit", "wonderful", "fantastic", "నచ్చింది",
    "అద్భుతం", "సూపర్", "హిట్",
}
_AGGRESSIVE = {
    "boycott", "ban", "destroy", "expose", "leak", "get out", "teach lesson",
    "kick", "throw", "బహిష్కరించండి", "తరిమికొట్టండి",
}
_INFLAMMATORY = {
    "shameless", "characterless", "traitor", "anti", "shame", "disgusting",
    "hate", "నీచుడు", "దేశద్రోహి",
}
_INTENSIFIERS = re.compile(r"!{2,}|[A-Z]{4,}")


@dataclass
class SentimentScores:
    positive: float
    neutral: float
    negative: float
    aggressive: float
    inflammatory: float
    source: str  # "model" | "lexicon"

    @property
    def negativity(self) -> float:
        """Single 0..1 negativity signal for the risk engine."""
        return max(self.negative, 0.6 * self.aggressive + 0.4 * self.inflammatory)


def _register_model() -> None:
    def _loader():
        from transformers import pipeline as hf_pipeline  # type: ignore

        return hf_pipeline(
            "sentiment-analysis",
            model=_MODEL_NAME,
            device=model_registry.device_index(),
            truncation=True,
            max_length=256,
            batch_size=16,
        )

    model_registry.register(_MODEL_KEY, _loader)


_register_model()


def _chunk(text: str, size: int = _CHUNK_TOKENS) -> list[str]:
    toks = tokenize(text)
    if len(toks) <= size:
        return [normalize_text(text)] if text.strip() else []
    return [" ".join(toks[i : i + size]) for i in range(0, len(toks), size)]


def _lexicon_sentiment(text: str) -> SentimentScores:
    norm = normalize_text(text)
    tokens = set(tokenize(text))
    if not norm:
        return SentimentScores(0.0, 1.0, 0.0, 0.0, 0.0, "lexicon")

    def _hits(lex: set[str]) -> int:
        n = 0
        for term in lex:
            if " " in term:
                n += 1 if term in norm else 0
            else:
                n += 1 if term in tokens else 0
        return n

    neg = _hits(_NEGATIVE)
    pos = _hits(_POSITIVE)
    agg = _hits(_AGGRESSIVE)
    inf = _hits(_INFLAMMATORY)
    intensifier = 0.15 if _INTENSIFIERS.search(text or "") else 0.0

    total = neg + pos + 1e-6
    negative = min(1.0, neg / max(1, neg + pos) + intensifier) if (neg or pos) else 0.0
    positive = min(1.0, pos / max(1, neg + pos)) if (neg or pos) else 0.0
    neutral = max(0.0, 1.0 - negative - positive)
    aggressive = min(1.0, agg / 2.0)
    inflammatory = min(1.0, (inf / 2.0) + intensifier)

    return SentimentScores(
        round(positive, 4), round(neutral, 4), round(negative, 4),
        round(aggressive, 4), round(inflammatory, 4), "lexicon",
    )


def analyze(text: str, use_model: bool = True) -> SentimentScores:
    """Analyze a single text (chunk-aggregated for long inputs)."""
    base = _lexicon_sentiment(text)
    if not use_model or not text or not text.strip():
        return base

    pipe = model_registry.get(_MODEL_KEY)
    if pipe is None:
        return base  # graceful: lexicon only

    try:
        chunks = _chunk(text)
        if not chunks:
            return base
        preds = pipe(chunks)
        # Aggregate chunk predictions (mean of class probabilities).
        agg = {"positive": 0.0, "neutral": 0.0, "negative": 0.0}
        label_map = {"positive": "positive", "neutral": "neutral", "negative": "negative"}
        for p in preds:
            lbl = label_map.get(str(p.get("label", "")).lower(), "neutral")
            agg[lbl] += float(p.get("score", 0.0))
        n = max(1, len(preds))
        positive, neutral, negative = (agg["positive"] / n, agg["neutral"] / n, agg["negative"] / n)
        model_registry.note_inference(_MODEL_KEY, len(chunks))
        # Keep deterministic aggressive/inflammatory (model doesn't emit them),
        # but let the model set the valence dimensions.
        return SentimentScores(
            round(positive, 4), round(neutral, 4), round(negative, 4),
            base.aggressive, base.inflammatory, "model",
        )
    except Exception as exc:  # pragma: no cover
        logger.debug("XLM-R sentiment failed, lexicon kept: %s", exc)
        return base


def analyze_batch(texts: list[str], use_model: bool = True) -> list[SentimentScores]:
    return [analyze(t, use_model=use_model) for t in texts]
