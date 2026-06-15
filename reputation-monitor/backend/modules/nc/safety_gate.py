"""Safety / legal gate for the NC module.

Final guard before any severe classification leaves the system. Enforces the
legal posture the brief mandates:

* A channel/video may only be presented as HIGH or CRITICAL when it is backed by
  **explainable evidence** (with at least one timestamped/quoted item) and a
  **minimum confidence**. Otherwise it is capped at MEDIUM and marked uncertain.
* Output is always phrased as an *AI-detected pattern*, never a factual
  accusation. :func:`finding_statement` produces the non-defamatory language.
* Every gated finding carries explicit uncertainty markers when confidence is
  low or context is ambiguous.

Pure-Python, deterministic, always-on.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Evidence + confidence requirements per severity.
_MIN_CONFIDENCE = {"CRITICAL": 0.6, "HIGH": 0.45}
_MIN_EVIDENCE = {"CRITICAL": 3, "HIGH": 2}
# Severe labels additionally require at least one *citable* (timestamp/quote) item.
_CITABLE_TYPES = {"transcript_segment", "ocr_text", "repeated_phrase", "title_claim"}

_SEVERITY_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]


@dataclass
class EvidenceSummary:
    total: int
    citable: int
    types: list[str] = field(default_factory=list)


@dataclass
class GatedFinding:
    level: str                   # possibly downgraded from proposed
    proposed_level: str
    gated: bool                  # True if it was downgraded
    confidence: float
    uncertainty_markers: list[str]
    statement: str               # non-defamatory finding text
    reasons: list[str] = field(default_factory=list)


def _downgrade(level: str) -> str:
    idx = _SEVERITY_ORDER.index(level)
    return _SEVERITY_ORDER[max(0, idx - 1)]


def summarize_evidence(evidence_items: list) -> EvidenceSummary:
    """Accepts items with ``.evidence_type`` (or dicts) and summarizes them."""
    types: list[str] = []
    citable = 0
    for it in evidence_items:
        etype = getattr(it, "evidence_type", None)
        if etype is None and isinstance(it, dict):
            etype = it.get("evidence_type")
        if etype:
            types.append(etype)
            if etype in _CITABLE_TYPES:
                citable += 1
    return EvidenceSummary(total=len(evidence_items), citable=citable, types=types)


def finding_statement(level: str, narrative_label: str | None, confidence: float) -> str:
    """Return non-defamatory, evidence-framed finding language."""
    narrative = (narrative_label or "negative narrative").replace("_", " ")
    if level in ("HIGH", "CRITICAL"):
        return (
            f"AI-detected repeated {narrative} amplification pattern "
            f"({level.lower()} signal, confidence {confidence:.0%}). "
            "Based on explainable evidence; not a factual determination."
        )
    if level == "MEDIUM":
        return (
            f"Possible {narrative} amplification signal detected "
            f"(medium, confidence {confidence:.0%}). Review evidence before action."
        )
    return (
        f"Low-confidence {narrative} signal "
        f"(confidence {confidence:.0%}); insufficient for escalation."
    )


def apply_gate(
    proposed_level: str,
    *,
    confidence: float,
    ambiguity: float,
    evidence: EvidenceSummary,
    narrative_label: str | None = None,
) -> GatedFinding:
    """Enforce evidence/confidence requirements; downgrade if unmet."""
    level = proposed_level
    reasons: list[str] = []
    gated = False

    for severe in ("CRITICAL", "HIGH"):
        if level == severe:
            if confidence < _MIN_CONFIDENCE[severe]:
                reasons.append(
                    f"confidence {confidence:.2f} < {_MIN_CONFIDENCE[severe]} for {severe}"
                )
                level = _downgrade(level)
                gated = True
            elif evidence.total < _MIN_EVIDENCE[severe]:
                reasons.append(
                    f"evidence {evidence.total} < {_MIN_EVIDENCE[severe]} for {severe}"
                )
                level = _downgrade(level)
                gated = True
            elif evidence.citable < 1:
                reasons.append(f"no citable (timestamp/quote) evidence for {severe}")
                level = _downgrade(level)
                gated = True
            break  # only evaluate the originally-proposed severe tier once

    markers: list[str] = []
    if confidence < 0.5:
        markers.append("low_confidence")
    if ambiguity >= 0.5:
        markers.append("ambiguous_context")
    if evidence.citable < 1:
        markers.append("no_timestamped_proof")
    if gated:
        markers.append("auto_downgraded")

    return GatedFinding(
        level=level,
        proposed_level=proposed_level,
        gated=gated,
        confidence=round(confidence, 3),
        uncertainty_markers=markers,
        statement=finding_statement(level, narrative_label, confidence),
        reasons=reasons,
    )
