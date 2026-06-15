"""NC performance benchmark.

Measures throughput and latency of the NC scoring pipeline. The **deterministic**
path (sentiment fallback + toxicity lexicon + context classification + risk
calibration + safety gate) runs anywhere and is benchmarked for real here.
Model-backed layers (Whisper/OCR/embeddings/Detoxify) are benchmarked only when
their weights are installed; otherwise they are reported as "not loaded" rather
than producing fabricated timings.

Usage:
    python -m scripts.nc_benchmark --n 2000
    python -m scripts.nc_benchmark --n 500 --use-models   # if models installed
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.nc.scoring_pipeline import assess_video  # noqa: E402
from modules.nc.evidence_service import EvidenceItem  # noqa: E402
from modules.nc import model_registry  # noqa: E402

_SAMPLES = [
    ("BOYCOTT this shameless cheat EXPOSED fraud",
     ["boycott him", "shameless", "destroy his career"]),
    ("Movie review: direction was boring and weak",
     ["fair point", "agree the screenplay dragged"]),
    ("According to sources the director responded officially", ["thanks"]),
    ("fake fraud paid actor expose the truth", ["boycott", "fraud", "shameless"]),
    ("funny parody comedy skit haha meme", ["lol", "so funny"]),
]


def bench_pipeline(n: int, use_models: bool) -> dict:
    ev = [EvidenceItem("transcript_segment", "x", "high", 0.8, "01:00"),
          EvidenceItem("repeated_phrase", "y", "high", 0.7)]
    latencies = []
    start = time.perf_counter()
    for i in range(n):
        title, comments = _SAMPLES[i % len(_SAMPLES)]
        t0 = time.perf_counter()
        assess_video(
            title=title, comments=comments, views=100000 + i,
            narrative_intensity=0.5, narrative_label="harassment",
            evidence_items=ev, use_models=use_models,
        )
        latencies.append((time.perf_counter() - t0) * 1000.0)
    total = time.perf_counter() - start
    latencies.sort()
    return {
        "n": n,
        "total_s": round(total, 3),
        "throughput_per_s": round(n / total, 1) if total else 0.0,
        "latency_ms_avg": round(statistics.fmean(latencies), 3),
        "latency_ms_p50": round(latencies[len(latencies) // 2], 3),
        "latency_ms_p95": round(latencies[int(len(latencies) * 0.95)], 3),
        "latency_ms_max": round(latencies[-1], 3),
    }


def model_status() -> dict:
    """Report which model layers are actually loadable (no fake timings)."""
    keys = {
        "sentiment_xlmr": "nc_sentiment_xlmr",
        "embeddings_st": "nc_embeddings_st",
    }
    status = {"device": model_registry.resolve_device()}
    for label, key in keys.items():
        status[label] = "loadable" if model_registry.is_available(key) else "not_installed"
    # Whisper / EasyOCR / Detoxify are import-gated; report import availability.
    for label, mod in (("whisper", "whisper"), ("easyocr", "easyocr"),
                        ("detoxify", "detoxify")):
        try:
            __import__(mod)
            status[label] = "import_ok"
        except Exception:
            status[label] = "not_installed"
    return status


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--use-models", action="store_true")
    args = ap.parse_args()

    print("=== NC pipeline benchmark ===")
    det = bench_pipeline(args.n, use_models=False)
    print("Deterministic path (always-on):")
    for k, v in det.items():
        print(f"  {k}: {v}")

    if args.use_models:
        print("\nModel-backed path:")
        mb = bench_pipeline(min(args.n, 200), use_models=True)
        for k, v in mb.items():
            print(f"  {k}: {v}")

    print("\nModel availability (no fabricated timings for absent models):")
    for k, v in model_status().items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
