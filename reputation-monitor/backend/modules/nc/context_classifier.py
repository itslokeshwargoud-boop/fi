"""Context classification for false-positive reduction.

The base NC engine is risk-sensitive: it flags negative + toxic + repeated
content. That over-flags legitimate speech — news reporting, satire, film
reviews, and fair criticism all look "negative" lexically. This module
distinguishes those contexts from genuine harassment/abuse and emits a
**confidence penalty** that down-weights risk for non-abusive contexts.

It is deterministic (lexical + structural signals over normalized text), so it
always runs and is fully testable. It is intentionally conservative: when
signals are weak it returns ``unknown`` with high ambiguity rather than forcing
a label, and it never *raises* risk — it can only attenuate it.

Output contract (:class:`ContextAssessment`):
* ``label``         — news | satire | commentary | criticism | harassment |
                      abuse | unknown
* ``is_abusive``    — True only for harassment/abuse
* ``ambiguity``     — 0..1 (1 = very unclear; drives uncertainty markers)
* ``risk_penalty``  — 0..1 multiplier to apply to a raw risk score
                      (1.0 = no reduction, 0.4 = strong reduction)
* ``signals``       — the matched cues, for explainability
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from modules.nc.preprocessing import normalize_text, tokenize
from modules.nc.toxicity_service import ToxicityService

# --- Signal lexicons (normalized, lowercase; Telugu + romanized) ---

_NEWS_SIGNALS = {
    "report", "reported", "reports", "according", "sources", "statement",
    "press", "media", "news", "clarification", "responds", "official",
    "వార్త", "విలేఖరి", "ప్రకటన",
}
_ATTRIBUTION = {"according", "sources", "quoted", "said", "stated", "అన్నారు"}

_SATIRE_SIGNALS = {
    "satire", "parody", "spoof", "comedy", "skit", "meme", "fun", "joke",
    "troll", "మీమ్", "కామెడీ", "సరదా",
}

_REVIEW_SIGNALS = {
    "review", "analysis", "breakdown", "reaction", "opinion", "rating",
    "scene", "performance", "screenplay", "direction", "boxoffice",
    "collections", "verdict", "రివ్యూ", "విశ్లేషణ", "నటన",
}

# Targets a *work/decision* (criticism) rather than a *person* (abuse).
_WORK_TARGETS = {
    "movie", "film", "scene", "story", "script", "direction", "song",
    "trailer", "teaser", "remake", "సినిమా", "పాట", "కథ",
}

# Calls to coordinated action / personal attacks => abuse/harassment.
_HARASSMENT_SIGNALS = {
    "boycott", "ban", "destroy", "expose", "leak", "teach lesson", "get out",
    "shameless", "characterless", "బహిష్కరించండి", "నీచుడు",
}

_OPINION_HEDGES = {
    "i think", "in my opinion", "imo", "personally", "i feel", "maybe",
    "నా అభిప్రాయం",
}

_LAUGH = re.compile(r"\b(ha){2,}\b|\blol\b|\brofl\b|\blmao\b")


@dataclass
class ContextAssessment:
    label: str
    is_abusive: bool
    ambiguity: float
    risk_penalty: float
    signals: list[str] = field(default_factory=list)


def _count(tokens: set[str], norm: str, lexicon: set[str]) -> tuple[int, list[str]]:
    hits = []
    for term in lexicon:
        if " " in term:
            if term in norm:
                hits.append(term)
        elif term in tokens:
            hits.append(term)
    return len(hits), hits


def classify_context(text: str, toxicity: float | None = None) -> ContextAssessment:
    """Classify the speech context of ``text`` for FP reduction.

    ``toxicity`` may be supplied to avoid recomputation; otherwise the lexicon
    toxicity scorer is used.
    """
    norm = normalize_text(text)
    if not norm:
        return ContextAssessment("unknown", False, 1.0, 1.0, [])

    tokens = set(tokenize(text))
    tox = (
        toxicity
        if toxicity is not None
        else ToxicityService.get_instance().score(text).score
    )

    news_n, news_h = _count(tokens, norm, _NEWS_SIGNALS)
    attr_n, _ = _count(tokens, norm, _ATTRIBUTION)
    satire_n, satire_h = _count(tokens, norm, _SATIRE_SIGNALS)
    review_n, review_h = _count(tokens, norm, _REVIEW_SIGNALS)
    work_n, _ = _count(tokens, norm, _WORK_TARGETS)
    harass_n, harass_h = _count(tokens, norm, _HARASSMENT_SIGNALS)
    hedge_n, _ = _count(tokens, norm, _OPINION_HEDGES)
    laughs = 1 if _LAUGH.search(norm) else 0

    signals: list[str] = []

    # --- Decision logic (ordered by specificity) ---

    # Harassment: explicit coordinated-action / personal-attack cues + toxicity.
    if harass_n >= 1 and tox >= 0.45:
        signals += [f"harassment:{h}" for h in harass_h[:3]]
        return ContextAssessment("harassment", True, 0.1, 1.0, signals)

    # Abuse: high toxicity with no mitigating context.
    if tox >= 0.6 and (news_n + satire_n + review_n) == 0:
        return ContextAssessment("abuse", True, 0.15, 1.0, [f"toxicity:{tox:.2f}"])

    # News/journalism: reporting + attribution, low toxicity.
    if news_n >= 1 and attr_n >= 1 and tox < 0.5:
        signals += [f"news:{h}" for h in news_h[:3]]
        # Strong penalty — reporting negative facts is not amplification.
        return ContextAssessment("news", False, 0.25, 0.45, signals)

    # Satire/comedy: parody cues or laughter, modest toxicity.
    if (satire_n >= 1 or laughs) and tox < 0.6:
        signals += [f"satire:{h}" for h in satire_h[:3]] or ["satire:laughter"]
        return ContextAssessment("satire", False, 0.4, 0.55, signals)

    # Criticism: review framing OR opinion hedges targeting a *work*, low tox.
    if (review_n >= 1 or hedge_n >= 1) and work_n >= 1 and tox < 0.5:
        signals += [f"review:{h}" for h in review_h[:3]]
        return ContextAssessment("criticism", False, 0.35, 0.6, signals)

    # Commentary: review framing without a clear personal target, modest tox.
    if review_n >= 1 and tox < 0.55:
        signals += [f"commentary:{h}" for h in review_h[:3]]
        return ContextAssessment("commentary", False, 0.5, 0.7, signals)

    # Ambiguous negative: some toxicity but mixed/insufficient signals.
    if tox >= 0.35:
        # Mild penalty + high ambiguity so the safety gate demands evidence.
        return ContextAssessment("unknown", False, 0.7, 0.85, [f"toxicity:{tox:.2f}"])

    return ContextAssessment("unknown", False, 0.8, 0.9, [])
