"""Evidence extraction for the NC module.

Turns raw signals (transcript segments, OCR text, comments, titles) into the
explainable, citable evidence items the dashboard drawer renders. Each item
carries a timestamp (where applicable), type, severity and confidence so the UI
can *justify* a finding instead of asserting a conclusion.

This is deterministic logic that runs regardless of which heavy models are
available; it simply consumes whatever the transcript/OCR/toxicity services
produced (which themselves degrade gracefully).
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

from modules.nc.preprocessing import normalize_text, tokenize
from modules.nc.toxicity_service import ToxicityService
from modules.nc.transcript_service import TranscriptResult
from modules.nc.ocr_service import OCRResult


@dataclass
class EvidenceItem:
    evidence_type: str          # transcript_segment | ocr_text | toxic_comment |
    #                             repeated_phrase | title_claim
    content: str
    severity: str               # low | medium | high
    confidence_score: float     # 0..1
    timestamp: str | None = None


def _severity_from_score(score: float) -> str:
    if score >= 0.66:
        return "high"
    if score >= 0.33:
        return "medium"
    return "low"


def from_transcript(result: TranscriptResult, max_items: int = 8) -> list[EvidenceItem]:
    """Pick the most toxic transcript segments as timestamped evidence."""
    if not result.available or not result.segments:
        return []
    tox = ToxicityService.get_instance()
    scored = []
    for seg in result.segments:
        t = tox.score(seg.text)
        if t.score > 0.2:
            scored.append((t.score, seg))
    scored.sort(key=lambda x: x[0], reverse=True)
    items = []
    for score, seg in scored[:max_items]:
        items.append(
            EvidenceItem(
                evidence_type="transcript_segment",
                content=seg.text,
                severity=_severity_from_score(score),
                confidence_score=round(score, 4),
                timestamp=seg.timestamp,
            )
        )
    return items


def from_ocr(result: OCRResult) -> list[EvidenceItem]:
    if not result.available or not result.texts:
        return []
    items = []
    for text in result.texts:
        is_framing = any(f in text for f in result.framing_hits)
        score = 0.7 if is_framing else 0.35
        items.append(
            EvidenceItem(
                evidence_type="ocr_text",
                content=text,
                severity=_severity_from_score(score),
                confidence_score=score,
            )
        )
    return items


def from_comments(comments: list[str], max_items: int = 10) -> list[EvidenceItem]:
    tox = ToxicityService.get_instance()
    scored = []
    for c in comments:
        t = tox.score(c)
        if t.score > 0.3:
            scored.append((t.score, normalize_text(c)))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [
        EvidenceItem(
            evidence_type="toxic_comment",
            content=text,
            severity=_severity_from_score(score),
            confidence_score=round(score, 4),
        )
        for score, text in scored[:max_items]
    ]


def from_title(title: str) -> list[EvidenceItem]:
    tox = ToxicityService.get_instance()
    t = tox.score(title)
    if t.score <= 0.25:
        return []
    return [
        EvidenceItem(
            evidence_type="title_claim",
            content=normalize_text(title),
            severity=_severity_from_score(t.score),
            confidence_score=round(t.score, 4),
        )
    ]


def repeated_phrases(
    texts: list[str], min_count: int = 3, n: int = 2
) -> list[EvidenceItem]:
    """Detect repeated targeting phrases (n-grams) across many texts."""
    counter: Counter = Counter()
    for text in texts:
        toks = tokenize(text)
        for i in range(len(toks) - n + 1):
            gram = " ".join(toks[i : i + n])
            counter[gram] += 1
    items = []
    for gram, count in counter.most_common(10):
        if count < min_count:
            break
        # Confidence scales with how often the phrase recurs.
        conf = min(1.0, count / 10.0)
        items.append(
            EvidenceItem(
                evidence_type="repeated_phrase",
                content=f'"{gram}" (repeated {count}x)',
                severity=_severity_from_score(conf),
                confidence_score=round(conf, 4),
            )
        )
    return items
