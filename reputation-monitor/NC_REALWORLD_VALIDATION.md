# NC Real-World Validation Report — Telugu YouTube

**Scope requested:** 50 Telugu channels, 500–1000 real videos, real captions/
transcripts, via the production pipeline. No synthetic data, no estimates, no
fabricated metrics. Every metric labelled ✓ VERIFIED or ✗ NOT VERIFIED.

---

## EXECUTIVE FINDING (read first)

**Real-world validation could NOT be executed in this environment, so every
required metric below is ✗ NOT VERIFIED.** This is reported honestly rather than
filled with synthetic or estimated numbers, exactly as the brief mandates.

### Why — verified environment evidence (measured, not assumed)

| Check | Result | Meaning |
| --- | --- | --- |
| `GET googleapis.com/youtube/v3/search` | **HTTP 403** | YouTube Data API egress-blocked → cannot collect videos |
| `GET video.google.com/timedtext` | **HTTP 403** | caption endpoint blocked → cannot fetch captions |
| `YOUTUBE_API_KEY` env | **absent** | no credentials to call the API |
| `import faster_whisper` | **ModuleNotFoundError** | no Whisper backend |
| HuggingFace model cache | **absent** | no model weights for transcription/embeddings |

With no network to YouTube, no API key, and no model weights, **zero real
videos, captions, or transcripts can be collected here.** Per the brief ("only
report metrics directly measured from the collected dataset"), there is no
collected dataset, therefore no measured metrics.

### What was delivered instead (so the metrics become ✓ VERIFIED when run)

A real, typechecked **validation runner** built on the existing production
pipeline that performs the full collection + measurement and emits all 10
reports from real data:

- `frontend/scripts/realworld/nc_validation_runner.ts` — collects via
  `collectYouTubeVideos` (+ Telugu `expandTarget`), fetches real captions via the
  new source-aware `fetchTranscriptsWithSourcesForVideos`, then runs
  `runFullAudit` + `buildNCIntelligence` and writes `<out>.json` + `<out>.md`.
- `frontend/scripts/realworld/channels.telugu.json` — configurable 50-channel
  Telugu seed (news / entertainment / commentary / fan / influencer).

**Run it where the data exists:**
```bash
cd frontend
npm i -D tsx                      # one-time
export YOUTUBE_API_KEY=...        # + YOUTUBE_API_KEY_2..N for more quota
npx tsx scripts/realworld/nc_validation_runner.ts --min 500 --max 1000 \
    --out ../NC_REALWORLD_RESULTS
```
It refuses to emit a report if 0 videos are collected (no empty/fake metrics).
Whisper coverage for caption-less videos requires the backend faster-whisper
pipeline on a GPU host; the runner marks those as `none` until that runs.

---

## PRIMARY VALIDATION QUESTIONS

| # | Question | Status | How it is produced |
| --- | --- | --- | --- |
| 1 | Videos detected only via transcript | ✗ NOT VERIFIED | `discovery.transcriptOnly` from the runner |
| 2 | Channels missed if title-only | ✗ NOT VERIFIED | `transcriptOnlyChannels.channels.length` |
| 3 | Additional intelligence from transcript | ✗ NOT VERIFIED | `discovery.transcriptDriven` share of flagged |

The **measurement mechanism for all three is implemented and unit-verified**
(`__tests__/ncAudit.test.ts`, 9/9; 26/26 NC tests overall) — only the real-data
*values* are unverified, because no real data could be collected here.

---

## THE 10 REQUIRED REPORTS

Each report's real-data metrics are ✗ NOT VERIFIED (no collected dataset). The
producing code path is named so the result is reproducible the moment the runner
executes with credentials.

| # | Report | Real metrics | Code path that measures it |
| --- | --- | --- | --- |
| 1 | Transcript Coverage (official/auto/whisper/none %) | ✗ NOT VERIFIED | `transcriptCoverageReport` |
| 2 | Discovery Source (TITLE_ONLY / TRANSCRIPT_ONLY / …) | ✗ NOT VERIFIED | `discoverySourceReport` |
| 3 | Transcript-Only Discoveries (channel/video/ts/snippet) | ✗ NOT VERIFIED | `transcriptOnlyChannelReport` |
| 4 | Channels Missed by Title Analysis | ✗ NOT VERIFIED | `transcriptOnlyChannelReport` (A vs B) |
| 5 | False Positives (title-flagged, no transcript support) | ✗ NOT VERIFIED | `falsePositiveReport` |
| 6 | False Negatives (manual sample inspection) | ✗ NOT VERIFIED | `signals[]` export for manual review |
| 7 | Telugu Intelligence Accuracy | ✗ NOT VERIFIED (real audio) | `targetExpansion` + `preprocess` + Whisper |
| 8 | Narrative Quality (size/confidence/contribution) | ✗ NOT VERIFIED | `buildNCIntelligence.narratives` + `signals` |
| 9 | Channel Attribution (transcript/title/comment/OCR %) | ✗ NOT VERIFIED | per-video `titleTox/commentTox/transcriptTox` |
| 10 | Transcript-First Readiness | ✗ NOT VERIFIED (real data) | `readinessAssessment` |

### Report 6 note (false negatives)
The runner exports the full `signals[]` array (every video's per-source scores
and flag decision). False-negative inspection = filter `flagged === false` with a
high `transcriptTox`, then manually confirm. This requires the real collected
sample; it cannot be done on data that does not exist.

### Report 10 — Readiness verdict
**✗ NOT VERIFIED on real data.** The transcript-first *logic* is VERIFIED in code
(weighting 60%, spoken-content flag gate, transcript evidence, the full audit;
26/26 tests). But the brief asks for a readiness level **measured on real Telugu
YouTube data**, and no such measurement exists here. Declaring any level (1–5)
for real-world operation would be an estimate — explicitly prohibited — so it is
withheld. The runner computes the data-backed level automatically:
Level 4 if measured coverage ≥ 50% and transcript-driven share ≥ 30%; Level 5 if
≥ 70% and ≥ 50%.

---

## INTEGRITY STATEMENT

- ✗ **NOT VERIFIED** is reported for every real-world metric, because no real
  Telugu YouTube data could be collected in this sandbox (HTTP 403 to the API and
  caption endpoints; no API key; no model weights — all verified above).
- **No synthetic data** is presented as real results in this report.
- **No metrics are estimated or fabricated.**
- The runner is the instrument that converts every ✗ above into ✓ VERIFIED when
  executed with YouTube API credentials, network access, and (for full Whisper
  coverage) the backend faster-whisper pipeline.

### Remaining gaps to a verified Level-4/5 declaration
1. Execute `nc_validation_runner.ts` with API keys + network on the 50-channel
   seed to collect 500–1000 real videos and real captions.
2. Run the backend faster-whisper (large-v3) pipeline over caption-less videos on
   a GPU host; persist `nc_transcript_segments` to lift Whisper coverage from 0.
3. Feed both into the runner to obtain the measured Reports 1–10 and a data-backed
   readiness level.
