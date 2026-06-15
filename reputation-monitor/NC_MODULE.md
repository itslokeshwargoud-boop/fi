# NC — Narrative Control / Negative Channels Intelligence

NC detects and explains YouTube channels that repeatedly amplify negative
narratives about a tracked subject (the Telugu film ecosystem in this build:
trolling, controversy farming, fan-war/harassment narratives). It produces
**explainable, confidence-scored, evidence-backed** findings — never
defamatory assertions.

> **Framing policy (enforced in the UI):** every finding is presented as an
> *"AI-detected repeated negative narrative amplification pattern"* with a
> confidence score and supporting evidence. The product never states that a
> channel "spreads lies" — findings are analytical signals, not factual
> determinations.

## Where it lives in the app

* Sidebar: **NC**, between *Talk* and *Alerts*.
* Route: `/reputation-os/nc` (`activeModule="nc"` → "Narrative Control").
* Surfaces: 6 metric cards, Negative Spreaders table, Narrative Clusters,
  Risk Timeline, Viral Shorts Tracker, and a per-channel Evidence Drawer.

## Two execution paths (by design)

1. **Live path (always on).** Like every other Reputation-OS module, the
   console computes intelligence on demand in the Next.js/TypeScript engine:

   ```
   pages/reputation-os/nc.tsx
     → hooks/useNc.ts
       → lib/nc/ncClient.ts
         → pages/api/reputation-os/[tenant]/nc/intelligence.ts
           → lib/nc/ncService.ts → ingestData() + lib/nc/ncEngine.ts
   ```

   `lib/nc/` contains the real engine: Telugu/transliterated preprocessing, an
   extensible toxicity lexicon, TF-IDF + cosine narrative clustering,
   configurable weighted risk scoring, and evidence extraction. This path needs
   no Python workers and runs on data the app already has (videos, comments,
   sentiment, bot scores).

   REST slices are also exposed under `pages/api/nc/*`
   (channels/narratives/timeline/shorts/evidence) with pagination/filter/sort.

2. **Offline enrichment path (backend).** A genuine Python pipeline deepens the
   signal when run:

   * Models: `nc_channels`, `nc_videos`, `nc_evidence`, `nc_narratives`
     (Alembic `002_nc_module`).
   * Services: `backend/modules/nc/` — `preprocessing`, `toxicity_service`,
     `transcript_service`, `ocr_service`, `narrative_service`, `risk_service`,
     `evidence_service`, `channel_intelligence_service`.
   * API: `backend/api/routes/nc.py` → `/api/nc/...`.
   * Workers: `backend/pipeline/tasks/nc_tasks.py` (queue `nc`).

## Honesty about model-optional layers

Deterministic logic — preprocessing, lexicon toxicity, risk weighting, evidence
extraction, and the TF-IDF/cosine clustering fallback — **always runs** and is
covered by functional tests.

The heavy layers are **real but optional** and degrade gracefully when their
weights/libraries are absent (the service contributes no signal instead of
failing):

| Service               | Preferred backend            | Graceful fallback                     |
| --------------------- | ---------------------------- | ------------------------------------- |
| `transcript_service`  | Whisper (+ yt-dlp/ffmpeg)    | skip transcript evidence              |
| `ocr_service`         | EasyOCR (te+en)              | skip OCR evidence                     |
| `toxicity_service`    | Detoxify multilingual        | extensible Telugu/transliit. lexicon  |
| `narrative_service`   | sentence-transformers + FAISS + DBSCAN | sklearn TF-IDF+DBSCAN → hashing-TF-IDF + greedy cosine |

Install the optional extras listed at the bottom of
`backend/requirements.txt` to enable the full pipeline.
