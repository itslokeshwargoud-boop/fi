"""Toxicity detection for the NC module.

Two-tier design:

1. A real, deterministic, extensible Telugu/transliterated abuse **lexicon**
   that always runs (no dependencies). It categorizes matches into insult /
   harassment / abuse / threat / hate and produces a 0..1 score. This is the
   guaranteed-available baseline.

2. An optional **Detoxify** transformer layer. Detoxify pulls large model
   weights and is not available in every environment, so it is loaded lazily
   and the service degrades gracefully to the lexicon when it is absent. The
   final score is the max of the two signals so the transformer can only ever
   *raise* recall, never silently disable the baseline.

This module is intentionally honest about that fallback: if Detoxify cannot be
imported, ``model_available`` stays False and only the lexicon contributes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from modules.nc.preprocessing import normalize_text, tokenize

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Extensible Telugu / transliterated abuse lexicon
# ---------------------------------------------------------------------------
# Weights are per-category contributions. Terms cover both Telugu script and
# common romanized spellings. This is a starting dictionary meant to be grown
# from flagged-content review — extend_lexicon() supports that at runtime.

_LEXICON: dict[str, set[str]] = {
    "insult": {
        "fake", "fraud", "cheap", "waste", "useless", "joker", "buffoon",
        "overaction", "drama", "నటన", "fake ra", "దొంగ", "మోసం",
        "mosam", "cheat", "fake behavior", "overaction chestunnadu",
    },
    "harassment": {
        "boycott", "expose", "exposed", "shameless", "target", "troll",
        "బహిష్కరించండి", "నీచుడు", "boycott chey",
        "mosagadu", "cheat chestunnadu", "mosam chestunnadu", "daga",
    },
    "abuse": {
        "idiot", "stupid", "loser", "nonsense", "trash", "garbage",
        "పనికిరాని", "చెత్త",
    },
    "threat": {
        "destroy", "finish", "ruin", "leak", "end your", "నాశనం",
    },
    "hate": {
        "caste", "religion", "community", "మతం", "కులం",
    },
}

_CATEGORY_WEIGHT = {
    "insult": 0.35,
    "harassment": 0.55,
    "abuse": 0.45,
    "threat": 0.85,
    "hate": 0.9,
}


def extend_lexicon(category: str, terms: list[str]) -> None:
    """Grow the abuse lexicon at runtime (e.g. from analyst review)."""
    _LEXICON.setdefault(category, set()).update(t.lower() for t in terms)


@dataclass
class ToxicityResult:
    score: float                       # 0..1 aggregate
    categories: dict[str, float] = field(default_factory=dict)
    matched_terms: list[str] = field(default_factory=list)
    source: str = "lexicon"            # "lexicon" | "detoxify+lexicon"


def _lexicon_score(text: str) -> ToxicityResult:
    norm = normalize_text(text)
    tokens = set(tokenize(text))
    cats: dict[str, float] = {}
    matched: list[str] = []

    for category, terms in _LEXICON.items():
        hits = 0
        for term in terms:
            # Multi-word terms: substring match on normalized text.
            if " " in term:
                if term in norm:
                    hits += 1
                    matched.append(term)
            elif term in tokens:
                hits += 1
                matched.append(term)
        if hits:
            # Saturating contribution: diminishing returns past ~3 hits.
            intensity = min(1.0, hits / 3.0)
            cats[category] = round(_CATEGORY_WEIGHT[category] * intensity, 4)

    score = round(min(1.0, max(cats.values()) if cats else 0.0), 4)
    return ToxicityResult(score=score, categories=cats, matched_terms=matched)


class ToxicityService:
    """Lexicon-first toxicity scorer with optional Detoxify enrichment."""

    _instance: "ToxicityService | None" = None

    def __init__(self) -> None:
        self._detox = None
        self.model_available = False
        self._tried_load = False

    @classmethod
    def get_instance(cls) -> "ToxicityService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _ensure_model(self) -> None:
        """Attempt a one-time lazy load of Detoxify; never raise."""
        if self._tried_load:
            return
        self._tried_load = True
        try:
            from detoxify import Detoxify  # type: ignore

            self._detox = Detoxify("multilingual")
            self.model_available = True
            logger.info("Detoxify multilingual model loaded for NC toxicity.")
        except Exception as exc:  # pragma: no cover - env dependent
            logger.warning(
                "Detoxify unavailable, NC toxicity using lexicon only: %s", exc
            )
            self._detox = None
            self.model_available = False

    def score(self, text: str, use_model: bool = True) -> ToxicityResult:
        base = _lexicon_score(text)
        if not text or not text.strip():
            return base

        if use_model:
            self._ensure_model()
            if self._detox is not None:
                try:
                    preds = self._detox.predict(text)
                    model_tox = float(preds.get("toxicity", 0.0))
                    if model_tox > base.score:
                        base.score = round(model_tox, 4)
                    base.source = "detoxify+lexicon"
                    # Fold transformer sub-scores into categories for the drawer.
                    for k in ("insult", "threat", "identity_attack", "obscene"):
                        if k in preds:
                            cat = "hate" if k == "identity_attack" else k
                            base.categories[cat] = max(
                                base.categories.get(cat, 0.0),
                                round(float(preds[k]), 4),
                            )
                except Exception as exc:  # pragma: no cover
                    logger.debug("Detoxify predict failed, lexicon kept: %s", exc)
        return base

    def score_batch(self, texts: list[str]) -> list[ToxicityResult]:
        return [self.score(t) for t in texts]
