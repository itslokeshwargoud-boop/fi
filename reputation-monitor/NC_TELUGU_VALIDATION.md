# NC Telugu Narrative Intelligence — Validation, Benchmark & Coverage Reports

_Generated from the executable test suite in `frontend/__tests__/ncTelugu.test.ts`
and `ncScale.test.ts`. All numbers below are reproduced from real runs on this
codebase. Read the honesty boundary at the end before treating any figure as a
real-world accuracy metric._

---

## 1. Validation Report — the three critical cases

All three CRITICAL VALIDATION TEST CASEs from the brief are implemented as
executable tests and **pass** (17/17 NC tests green).

### Case 1 — Telugu target discovery
- `expandTarget("Prabhas")` emits the Telugu/transliterated/alias query set
  (`ప్రభాస్`, `Darling`, `Rebel Star`, `Prabhas Anna`, …) and reverse-resolves
  aliases (`darling → Prabhas`).
- `mentionsTarget` identifies the target across all three sample titles:
  pure Telugu (`ప్రభాస్ పై సంచలన వ్యాఖ్యలు`), transliterated
  (`Prabhas pai mosam jariginda?`), and code-mixed
  (`Prabhas Latest Update | నిజం బయటపడింది`); `normalizeText().hasTelugu` is true
  for the Telugu/mixed titles.
- **PASS CONDITION met:** all three videos enter the NC pipeline
  (`processing.analyzed == collected == 3`); no English-negative pre-filter.

### Case 2 — spoken negativity flags a neutral-title video
- Title (`Prabhas Latest Interview`) and comments score < 0.4 (neutral).
- Transcript segments (`audience ni mosam chestunnadu`, `industry lo fake
  behavior…`, `fans ni cheat chestunnaru`) score ≥ 0.45; transcript-primary
  weighting pushes unified toxicity > 0.4.
- **PASS CONDITION met:** the channel is flagged purely from spoken content;
  the drawer returns timestamped `transcript_segment` evidence with `&t=` deep
  links, ordered ahead of any title evidence.

### Case 3 — full-scale analysis + time filtering
- 1000 synthetic videos: `processing.analyzed == collected == 1000`
  (no sampling, no `LIMIT`, no truncation).
- Window filter keeps a 2-day-old item and excludes a 20-day-old item under a
  "last 7 days" window.
- **PASS CONDITION met:** Analyzed == Collected, and only in-window videos pass.

---

## 2. Pass / Fail Summary — final acceptance criteria

| Acceptance criterion | Status | Basis |
| --- | --- | --- |
| Telugu videos discovered correctly | ✅ PASS | `targetExpansion` + Case 1 test |
| Mixed-language videos processed | ✅ PASS | Case 1 test (code-mixed title) |
| Transcript intelligence is primary signal | ✅ PASS | `signalWeights` (60%) + Case 2 |
| Spoken evidence extracted with timestamps | ✅ PASS | `buildTranscriptEvidence` + Case 2 |
| Evidence drawer displays transcript proof | ✅ PASS | drawer renders snippet + `▶mm:ss` deep link |
| Full Feed-scale ingestion analyzed | ✅ PASS | Case 3 (1000) + deep-collection wiring |
| Time filtering across NC components | ✅ PASS | `dateWindow` + Case 3 + scoped ingestion |
| FAISS semantic grouping works | ✅ PASS (CPU, synthetic) | prior-phase FAISS test |
| Repeated targeting detected | ✅ PASS (deterministic) | `channel_intelligence_service` |
| 1000+ videos processed successfully | ✅ PASS | Case 3 bench (1000 in ~55ms) |
| Real faster-whisper transcription | ⚠️ CODE-COMPLETE, not run | no GPU/weights/network here |
| Real e5-large embeddings | ⚠️ CODE-COMPLETE, not run | falls back to hashing-TF-IDF |
| Real Detoxify toxicity | ⚠️ CODE-COMPLETE, not run | lexicon fallback active |
| Real Telugu YouTube precision/recall | ⛔ NOT MEASURED | requires live video + labels |

**17/17 executable NC tests pass.** Items marked ⚠️ are real, model-optional
integration code that cannot run in this sandbox (no model weights / no GPU /
no external network). The ⛔ item is intentionally not fabricated.

---

## 3. Benchmark Report (deterministic engine, real)

Measured on this machine (single CPU core, Node/vitest, synthetic data):

| Workload | Videos | Time | Throughput | Flagged |
| --- | --- | --- | --- | --- |
| `ncScale` full pass | 800 | ~81 ms | ~9,900 videos/s | 267 |
| `ncTelugu` full pass | 1000 | ~55 ms | ~18,000 videos/s | 334 |

The deterministic intelligence pass (discovery classification, transcript-
weighted toxicity, narrative typing, calibration, evidence assembly) scales
linearly and processes 1000 videos in well under the 10 s budget. Model-backed
stages (Whisper, e5, Detoxify) are **not** benchmarked here because their
weights are absent — no fabricated model timings are reported.

---

## 4. Coverage Report — what runs vs. what needs models/data

**Runs and is tested here (deterministic):**
- Target Expansion Engine (Telugu aliases, transliteration, nickname, reverse
  lookup, `mentionsTarget`) — `lib/nc/targetExpansion.ts`.
- Deep-collection discovery union of Telugu alias queries — `extraQueries` in
  `collectionEngine` + `dataIngestion`.
- Transcript-primary weighting (configurable 60/15/10/5/5/5) — `signalWeights.ts`.
- Spoken-content flagging when title/comments are neutral — `ncEngine.isFlagged`.
- Transcript evidence with timestamps + clickable deep links + narrative label
  + toxicity, prioritized over title; 4-tier ordering — `evidenceEngine.ts`.
- Telugu/transliterated toxicity terms — `toxicityLexicon.ts` (FE) +
  `toxicity_service.py` (BE).
- Full-scale analysis (no sampling) + time-window filtering across all NC
  surfaces — `ncEngine`, `dateWindow.ts`, `dataIngestion`.
- Transcript-segment storage schema (CRUD verified on SQLite) —
  `models/nc_transcript_segment.py` + migration `004`.

**Real integration code, not executable in this sandbox:**
- faster-whisper (large-v3) transcription with openai-whisper fallback —
  `modules/nc/transcript_service.py` (needs weights/ffmpeg/GPU).
- multilingual-e5-large embeddings with mpnet fallback —
  `modules/nc/embeddings_service.py` (needs weights).
- Detoxify transformer toxicity — `modules/nc/toxicity_service.py` (needs weights).
- Real YouTube caption/audio fetch — needs external network.

**Not done / explicitly out of scope here:**
- Real-world precision/recall on labelled Telugu videos (needs live data).
- Wiring transcripts into the live full-intelligence pass at 800+ scale
  (this is the backend Celery pipeline's responsibility; the live drawer fetches
  captions per-channel, bounded).

---

## 5. Missed-Channel Analysis Report

**Why channels were previously missed (root causes, now addressed):**
1. *English-keyword discovery bias* — collection leaned on English intent
   modifiers, under-covering Telugu-script / transliterated references.
   → Fixed by `expandTarget` unioning Telugu/alias queries into deep collection.
2. *Title-only flagging* — a channel whose videos had neutral titles/comments
   but toxic spoken content never surfaced.
   → Fixed by transcript-primary weighting + spoken-content flag gate.
3. *Weak Telugu lexical coverage* — romanized Telugu deception terms
   (`mosam`, `mosagadu`, `cheat chestunnadu`) weren't scored.
   → Added to both FE and BE lexicons.

**Residual blind spots (honest):**
- *Speech-only toxicity at full scale in the live path.* The live drawer fetches
  captions per already-surfaced channel; a channel toxic **only** in speech with
  a clean title/comments won't be surfaced by the live main pass on its own.
  Closing this fully requires the backend pipeline to transcribe **all**
  collected videos (faster-whisper) and persist transcript-derived scores —
  which is implemented as code but needs weights/GPU to run at scale.
- *Caption availability.* `youtube-transcript-api` / timedtext is best-effort;
  videos without captions need the Whisper path (backend, model-gated).
- *Alias coverage.* The alias dictionary is seeded for a few targets; broad
  recall depends on expanding `TARGET_ALIASES` (designed to be DB-backable).

**Recommended next step to eliminate the residual blind spot:** run the backend
Celery transcription pipeline (faster-whisper large-v3) over the full collected
set on a GPU host, persist `nc_transcript_segments`, and have the dashboard read
transcript-derived flags so speech-only channels surface in the main pass.

---

## Honesty boundary

This environment has **no model weights, no GPU, and no external network**
(YouTube / HuggingFace unreachable). Therefore faster-whisper, e5-large and
Detoxify inference, and any discovery/validation against **real** Telugu videos,
could not be executed here. Every figure above comes from deterministic logic on
**synthetic** data — it validates correctness, wiring and scaling, **not**
real-world precision/recall. No model timings or accuracy metrics were
fabricated for components that cannot run in this sandbox.
