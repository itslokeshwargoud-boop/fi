# NC Production AI Enrichment Layers

This document covers the production AI layers added on top of the deterministic
NC engine documented in `NC_MODULE.md`. **Every layer here is optional and
degrades gracefully** — the deterministic pipeline runs with none of these
installed. Heavy models are lazy-loaded through a shared registry, never forced,
and never block the request path on failure.

## Two execution realities (read this first)

* **Deterministic layers run everywhere and are verified executing**:
  multilingual valence sentiment (fallback), toxicity lexicon, context
  classification (false-positive reduction), risk calibration, the safety gate,
  narrative TF-IDF/cosine clustering, and the FAISS index mechanics. Benchmarked
  at ~6.7k video-assessments/sec on a single CPU core (p95 ≈ 0.19 ms).
* **Model-backed layers are real integration code that requires weights**:
  Whisper, EasyOCR, Detoxify, sentence-transformers, and the XLM-R sentiment
  model. They are wired correctly and load through the registry, but obviously
  require their packages + weights to be installed to perform inference. When
  absent, each contributes no signal and the deterministic fallback is used.

## New modules (`backend/modules/nc/`)

| Module | Purpose | Model | Fallback |
| --- | --- | --- | --- |
| `model_registry.py` | Lazy singleton loading, GPU/CPU detection, health, memory cleanup, inference counters | — | — |
| `observability.py` | Structured logging, metrics registry, `@timed` decorator | — | — |
| `sentiment_service.py` | 5-dim multilingual sentiment (pos/neutral/neg/aggressive/inflammatory) | XLM-R | valence lexicon |
| `context_classifier.py` | **False-positive reduction**: news/satire/criticism vs harassment/abuse | — | (deterministic) |
| `risk_calibration.py` | Dynamic bands, engagement normalization, channel baselines, confidence intervals | — | (deterministic) |
| `safety_gate.py` | Evidence + confidence requirements before HIGH/CRITICAL; non-defamatory statements | — | (deterministic) |
| `embeddings_service.py` | Cached multilingual embeddings + persistent FAISS index (incremental) | sentence-transformers + FAISS | hashing-TF-IDF + brute-force cosine |
| `youtube_transcript_service.py` | Caption priority chain: official → auto → Whisper | youtube-transcript-api / Whisper | unavailable (no raise) |
| `scoring_pipeline.py` | Orchestrator composing all layers into one calibrated, gated assessment | — | — |

`transcript_service.py` and `ocr_service.py` were extended in place (additive,
API-compatible): GPU detection, model-size switching (`NC_WHISPER_SIZE`),
ffmpeg validation, Whisper confidence scoring; OCR preprocessing/upscaling,
per-detection confidence + bounding boxes, and batching.

## Scoring flow

```
raw signals
  → sentiment (XLM-R | valence)               5 dimensions
  → unified toxicity (Detoxify | lexicon, content·0.7 + audience·0.3)
  → narrative intensity (embeddings | TF-IDF)
  → context classification                    → risk penalty (FP reduction)
  → weighted risk (risk_service)
  → calibration (engagement / baseline / dynamic bands / confidence interval)
  → safety gate (evidence + confidence; non-defamatory statement)
```

The Celery worker (`pipeline/tasks/nc_tasks.py`) calls `assess_video(...)` per
video, persisting the calibrated score, confidence, context label, transcript
provenance, and a rich `analysis_metadata` JSON (migration `003`).

## False-positive reduction & legal safety (verified)

* A negative **film review** → LOW risk, `context=criticism`, non-defamatory
  low-confidence statement.
* A **harassment campaign** with timestamped evidence → HIGH risk,
  `context=harassment`, framed as "AI-detected repeated … amplification pattern".
* The safety gate downgrades CRITICAL→HIGH (etc.) when confidence is low, fewer
  than the required evidence items exist, or no citable (timestamp/quote)
  evidence is present, attaching uncertainty markers.

## Model setup (to enable the heavy layers)

System packages (see `infrastructure/Dockerfile.backend`):

```
apt-get install -y ffmpeg libgl1 libglib2.0-0      # Whisper + EasyOCR
```

Python extras (see the optional block at the bottom of `requirements.txt`):

```
pip install openai-whisper yt-dlp easyocr detoxify sentence-transformers faiss-cpu
```

Environment (all optional):

| Var | Default | Meaning |
| --- | --- | --- |
| `NC_WHISPER_SIZE` | `small` | Whisper model size (`base`/`small`/`medium`) |
| `NC_EMBEDDING_MODEL` | `paraphrase-multilingual-MiniLM-L12-v2` | sentence-transformers model |
| `NC_EMBED_CACHE` | _(unset)_ | on-disk embedding cache path |

**GPU**: `model_registry.resolve_device()` auto-detects CUDA once and shares the
decision across Whisper/OCR/embeddings. Base the image on an `nvidia/cuda`
runtime and install `faiss-gpu` to use it; otherwise everything runs CPU-only.

## Operational endpoints

* `GET /api/nc/health` — device + per-model load state, last error, load time,
  inference counts (from the model registry).
* `GET /api/nc/metrics` — pipeline counters (assessments, safety downgrades,
  per-context tallies) and inference timers.

## Validation & benchmarking

```
# Validation (precision/recall/F1/FP/FN + confusion matrix + tuning recs)
python -m scripts.nc_validation --dataset labeled.jsonl --report out/report
python -m scripts.nc_validation            # bundled SYNTHETIC smoke sample

# Benchmark (deterministic throughput is real; model timings only if installed)
python -m scripts.nc_benchmark --n 3000
python -m scripts.nc_benchmark --n 500 --use-models
```

### Honesty note on validation

The validation harness is real and dataset-agnostic, but this repository ships
**only a small synthetic sample** for smoke-testing it. No precision/recall
numbers in this codebase were measured on real Telugu YouTube videos — that
requires fetching and hand-labeling real content, which must be done in your
environment with network + YouTube access. The synthetic run is explicitly
labeled as such in its own report and is intended only to prove the harness
computes metrics correctly (it does, including correctly surfacing a
false-negative and emitting the matching tuning recommendation).
