"""NC validation harness.

Runs the NC scoring pipeline over a *labeled* dataset and computes
classification quality: precision, recall, F1, false-positive / false-negative
rates, and a confusion matrix over risk bands. Produces a JSON + Markdown
report and risk-tuning recommendations.

The harness is real and reusable. It is dataset-agnostic: point it at a JSONL
file of labeled videos and it reports metrics. To benchmark on **real Telugu
YouTube content**, supply a JSONL you have labeled (the repo ships only a small
clearly-marked *synthetic* sample for smoke-testing the harness — no fabricated
real-world metrics).

Dataset format (one JSON object per line):
    {
      "video_id": "abc",
      "title": "...",
      "description": "...",
      "transcript": "...",          # optional
      "comments": ["...", "..."],   # optional
      "views": 12345,                # optional
      "narrative_intensity": 0.4,    # optional
      "narrative_label": "harassment",
      "evidence_count": 3,           # optional, simulates available evidence
      "label_is_abusive": true,      # ground truth: is this genuine abuse/harassment?
      "label_level": "HIGH"          # optional ground-truth band
    }

Usage:
    python -m scripts.nc_validation --dataset path/to/labeled.jsonl --report out/report
    python -m scripts.nc_validation            # runs the bundled synthetic sample
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field

# Allow running as a script from the backend root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.nc.scoring_pipeline import assess_video  # noqa: E402
from modules.nc.evidence_service import EvidenceItem  # noqa: E402

_BANDS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
_ABUSIVE_BANDS = {"HIGH", "CRITICAL"}


@dataclass
class Metrics:
    tp: int = 0
    fp: int = 0
    tn: int = 0
    fn: int = 0
    confusion: dict = field(default_factory=dict)

    @property
    def precision(self) -> float:
        d = self.tp + self.fp
        return round(self.tp / d, 4) if d else 0.0

    @property
    def recall(self) -> float:
        d = self.tp + self.fn
        return round(self.tp / d, 4) if d else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return round(2 * p * r / (p + r), 4) if (p + r) else 0.0

    @property
    def fp_rate(self) -> float:
        d = self.fp + self.tn
        return round(self.fp / d, 4) if d else 0.0

    @property
    def fn_rate(self) -> float:
        d = self.fn + self.tp
        return round(self.fn / d, 4) if d else 0.0


def _mk_evidence(n: int) -> list:
    """Synthesize n citable evidence items so the safety gate can engage."""
    items = []
    for i in range(max(0, n)):
        etype = "transcript_segment" if i == 0 else "repeated_phrase"
        items.append(EvidenceItem(etype, f"evidence {i}", "high", 0.8,
                                  "01:00" if i == 0 else None))
    return items


def evaluate(records: list[dict], use_models: bool = False) -> tuple[Metrics, list[dict]]:
    m = Metrics()
    m.confusion = {a: {b: 0 for b in _BANDS} for a in _BANDS}
    rows = []
    for rec in records:
        a = assess_video(
            title=rec.get("title", ""),
            description=rec.get("description", ""),
            transcript=rec.get("transcript", ""),
            comments=rec.get("comments", []),
            views=int(rec.get("views", 0) or 0),
            narrative_intensity=float(rec.get("narrative_intensity", 0.0) or 0.0),
            narrative_label=rec.get("narrative_label"),
            evidence_items=_mk_evidence(int(rec.get("evidence_count", 0) or 0)),
            use_models=use_models,
        )
        pred_abusive = a.risk_level in _ABUSIVE_BANDS
        truth_abusive = bool(rec.get("label_is_abusive", False))

        if pred_abusive and truth_abusive:
            m.tp += 1
        elif pred_abusive and not truth_abusive:
            m.fp += 1
        elif not pred_abusive and truth_abusive:
            m.fn += 1
        else:
            m.tn += 1

        truth_band = rec.get("label_level")
        if truth_band in _BANDS:
            m.confusion[truth_band][a.risk_level] += 1

        rows.append({
            "video_id": rec.get("video_id"),
            "predicted_level": a.risk_level,
            "predicted_risk": a.risk_score,
            "confidence": a.confidence,
            "context": a.context_label,
            "gated": a.gated,
            "truth_abusive": truth_abusive,
            "correct": pred_abusive == truth_abusive,
        })
    return m, rows


def recommendations(m: Metrics) -> list[str]:
    recs = []
    if m.fp_rate > 0.2:
        recs.append(
            "High false-positive rate: increase context penalties or raise the "
            "HIGH/CRITICAL confidence thresholds in safety_gate."
        )
    if m.fn_rate > 0.2:
        recs.append(
            "High false-negative rate: lower MEDIUM/HIGH band cutoffs or increase "
            "toxicity/narrative weights in risk_service."
        )
    if m.precision and m.recall and abs(m.precision - m.recall) > 0.25:
        recs.append("Precision/recall imbalance: revisit dynamic_bands tuning.")
    if not recs:
        recs.append("Metrics within target ranges; no tuning changes indicated.")
    return recs


def render_markdown(m: Metrics, rows: list[dict], synthetic: bool) -> str:
    lines = ["# NC Validation Report", ""]
    if synthetic:
        lines += [
            "> **NOTE:** Computed on the bundled **synthetic** sample dataset. "
            "These numbers validate that the harness works; they are **not** "
            "real-world performance metrics. Run with `--dataset` on a labeled "
            "real Telugu YouTube set to obtain meaningful metrics.",
            "",
        ]
    lines += [
        f"- Samples: **{len(rows)}**",
        f"- Precision: **{m.precision}**",
        f"- Recall: **{m.recall}**",
        f"- F1: **{m.f1}**",
        f"- False-positive rate: **{m.fp_rate}**",
        f"- False-negative rate: **{m.fn_rate}**",
        f"- TP/FP/TN/FN: {m.tp}/{m.fp}/{m.tn}/{m.fn}",
        "",
        "## Recommendations",
    ]
    lines += [f"- {r}" for r in recommendations(m)]
    return "\n".join(lines)


# Synthetic, clearly-labeled sample. NOT real YouTube data.
SYNTHETIC_SAMPLE = [
    {"video_id": "s1", "title": "BOYCOTT this shameless cheat EXPOSED fraud",
     "comments": ["boycott him", "shameless", "destroy his career", "characterless"],
     "views": 300000, "narrative_intensity": 0.8, "narrative_label": "harassment",
     "evidence_count": 3, "label_is_abusive": True, "label_level": "HIGH"},
    {"video_id": "s2", "title": "Movie review: direction was boring and weak",
     "comments": ["fair point", "agree the screenplay dragged"], "views": 50000,
     "narrative_intensity": 0.3, "narrative_label": "controversy_farming",
     "evidence_count": 1, "label_is_abusive": False, "label_level": "LOW"},
    {"video_id": "s3", "title": "According to sources the director responded officially",
     "comments": ["thanks for the update"], "views": 20000,
     "narrative_intensity": 0.2, "narrative_label": "general_negative",
     "evidence_count": 1, "label_is_abusive": False, "label_level": "LOW"},
    {"video_id": "s4", "title": "fake fraud paid actor expose the truth boycott now",
     "comments": ["boycott", "fraud", "shameless", "expose him"], "views": 220000,
     "narrative_intensity": 0.75, "narrative_label": "authenticity_attack",
     "evidence_count": 3, "label_is_abusive": True, "label_level": "HIGH"},
    {"video_id": "s5", "title": "funny parody comedy skit haha meme edit",
     "comments": ["lol", "so funny"], "views": 90000, "narrative_intensity": 0.2,
     "narrative_label": "general_negative", "evidence_count": 0,
     "label_is_abusive": False, "label_level": "LOW"},
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", help="Path to labeled JSONL dataset")
    ap.add_argument("--report", default="nc_validation_report",
                    help="Output path prefix (writes .json and .md)")
    ap.add_argument("--use-models", action="store_true",
                    help="Enable model-backed inference if available")
    args = ap.parse_args()

    if args.dataset:
        with open(args.dataset, "r", encoding="utf-8") as fh:
            records = [json.loads(line) for line in fh if line.strip()]
        synthetic = False
    else:
        records = SYNTHETIC_SAMPLE
        synthetic = True

    m, rows = evaluate(records, use_models=args.use_models)

    report = {
        "synthetic": synthetic,
        "samples": len(rows),
        "precision": m.precision,
        "recall": m.recall,
        "f1": m.f1,
        "fp_rate": m.fp_rate,
        "fn_rate": m.fn_rate,
        "counts": {"tp": m.tp, "fp": m.fp, "tn": m.tn, "fn": m.fn},
        "confusion": m.confusion,
        "recommendations": recommendations(m),
        "rows": rows,
    }
    with open(f"{args.report}.json", "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    with open(f"{args.report}.md", "w", encoding="utf-8") as fh:
        fh.write(render_markdown(m, rows, synthetic))

    print(render_markdown(m, rows, synthetic))


if __name__ == "__main__":
    main()
