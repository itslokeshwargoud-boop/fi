# NC Transcript-First — Production Validation (10 Reports)

**Purpose:** answer whether NC truly operates as a transcript-driven narrative
intelligence engine, or is still title/metadata-dependent.

## How to read this document (epistemic status)

Every figure below is tagged:

- ✅ **VERIFIED** — produced by running real code paths (`lib/nc/transcriptAudit.ts`)
  and asserted by tests (`__tests__/ncAudit.test.ts`, 9/9 passing; 26/26 NC tests overall).
- 🧪 **SYNTHETIC-DEMO** — the audit harness run on a **constructed** 40-video
  dataset. These prove the harness computes correctly; they are **not**
  real-world metrics.
- ⛔ **UNVERIFIED / REQUIRES REAL DATA** — cannot be measured in this environment
  (no YouTube network, no model weights, no real Telugu videos, no GPU). Not estimated, not fabricated.

> **Bottom line up front:** the transcript-first *logic* is implemented and
> VERIFIED in code. NC's transcript-first *operational readiness on real data*
> is **UNVERIFIED** here, because no real videos have been collected or
> transcribed in this environment. We therefore do **not** declare
> "Transcript-First Intelligence achieved" on real-world data — see Report 10.

The audit harness (`runFullAudit(data, transcriptSources?)`) generates all ten
reports from an `IngestedData` payload. On real backend data (videos +
`nc_transcript_segments`) it yields real metrics; the numbers shown under
🧪 below come from a synthetic dataset used only to validate the harness.

---

## Report 1 — Transcript Coverage

**Code path:** `transcriptCoverageReport()`. Caption-type breakdown
(official/auto/whisper/none) is only computable when the backend supplies a
`transcriptSources` map from `nc_transcript_segments.source`.

🧪 SYNTHETIC-DEMO (40-video harness run):

| Metric | Value |
| --- | --- |
| Total videos | 40 |
| With transcript | 32 (80.0%) |
| Official captions | 16 (40%) |
| Auto captions | 8 (20%) |
| Whisper required | 8 (20%) |
| No transcript | 8 (20%) |

⛔ Real coverage % is **UNVERIFIED** — it depends on running caption fetch +
faster-whisper over a real collected set. The harness will report it for real
once that data exists.

---

## Report 2 — Discovery Source

**Code path:** `discoverySourceReport()` over `extractSignals()`. Each flagged
video is classified by which source(s) independently exceed the negativity
threshold (`SIGNAL_FLAG_THRESHOLD = 0.45`, mirroring the engine's spoken gate).

🧪 SYNTHETIC-DEMO:

| Source | Count |
| --- | --- |
| TITLE_ONLY | 8 |
| TRANSCRIPT_ONLY | 8 |
| TITLE_AND_TRANSCRIPT | 8 |
| COMMENT_ONLY / others | 0 |
| **Total flagged** | **24** |

- Title-driven (would flag on title alone): 16
- **Transcript-driven (title would MISS): 8**
- Transcript-only: 8

✅ VERIFIED mechanism: `ncAudit.test.ts` asserts a neutral-title/toxic-transcript
video classifies as `TRANSCRIPT_ONLY`, a toxic-title/no-transcript video as
`TITLE_ONLY`, and both as `TITLE_AND_TRANSCRIPT`.

### Primary question — "how many discovered via transcript that title-only would miss?"

- **Mechanism: VERIFIED.** `discovery.missedByTitleOnly` = flagged videos where
  the title does not independently flag = exactly the transcript/comment-driven
  discoveries that title-only analysis loses.
- **Real count: ⛔ UNVERIFIED.** In the synthetic demo it is **8 of 24 (33%)**.
  The real figure requires a real transcription run; the harness will compute it
  deterministically when real transcripts are present.

---

## Report 3 — Transcript-Only Channels

**Code path:** `transcriptOnlyChannelReport()` — channels where **every** flagged
video is transcript-driven (no title/comment flag), i.e. the channel would
disappear from NC entirely if transcripts were removed. Rows include channel,
video, timestamp, transcript snippet, and toxicity.

🧪 SYNTHETIC-DEMO: 2 such channels surfaced (e.g. a channel whose only signal is
`[02:14] "audience ni mosam chestunnadu"`).

✅ VERIFIED mechanism (`ncAudit.test.ts`): a channel flagged only via transcript
is listed; a title-flagged channel is excluded; the row carries the correct
timestamp + snippet.

⛔ Real transcript-only channel list: REQUIRES REAL DATA.

---

## Report 4 — Speech-Only Negativity

**Code path:** `speechOnlyReport()` — videos with neutral title **and** neutral
comments (< 0.4) but a negative transcript (≥ 0.45).

🧪 SYNTHETIC-DEMO: 8 videos (33.3% of flagged), across 8 channels, each with a
timestamped spoken snippet, e.g.:

```
[02:14] audience ni mosam chestunnadu
[04:51] industry lo fake behavior cheat
```

✅ VERIFIED mechanism. ⛔ Real prevalence: REQUIRES REAL DATA.

---

## Report 5 — Telugu Intelligence

**Code paths:** `targetExpansion.ts` (discovery), `preprocess.ts` (`hasTelugu`,
transliteration), `toxicityLexicon.ts` (Telugu terms).

✅ VERIFIED (`ncTelugu.test.ts`):
- Target extraction: alias/Telugu/transliterated expansion + reverse lookup.
- Target identification across Telugu-script, transliterated, and code-mixed titles.
- Narrative/toxicity extraction on romanized Telugu (`mosam`, `cheat
  chestunnadu`, `fake behavior`) clears the flag threshold.

⛔ Transcript extraction success on real Telugu **audio** (faster-whisper
large-v3) is UNVERIFIED — no weights/GPU here.

---

## Report 6 — Title vs Transcript Comparison

**Code path:** `titleVsTranscriptReport()` — per flagged video, title-based vs
transcript-based risk, plus false-negatives-prevented (transcript caught what
title missed) and false-positive-candidates (title flagged, transcript doesn't
corroborate).

🧪 SYNTHETIC-DEMO: false-negatives prevented by transcript = 8;
false-positive candidates = 8; mean (transcript − title) risk delta = −12 pts
(synthetic mix skews title-heavy by construction).

✅ VERIFIED mechanism. ⛔ Real deltas: REQUIRES REAL DATA.

---

## Report 7 — Narrative Detection Quality

**Code paths:** `narrativeEngine.clusterNarratives` + the engine's per-video
narrative typing. Cluster size and per-cluster membership are ✅ VERIFIED to
compute (covered by prior-phase tests and `buildNCIntelligence`).

⛔ Per-cluster **transcript-vs-title contribution** attribution is **not yet a
first-class output** of the clusterer and, more importantly, requires real
transcript text to be meaningful. Status: REQUIRES REAL DATA + a small clusterer
extension. Honestly flagged as a remaining gap rather than estimated.

---

## Report 8 — Channel Intelligence Attribution

**Code path:** `extractSignals()` exposes per-video `titleTox`, `commentTox`,
`transcriptTox`; aggregating these per channel yields the share of a channel's
risk attributable to each source. OCR attribution is backend-only (live path has
no OCR).

🧪 SYNTHETIC-DEMO: for transcript-only channels, 100% of the flagging signal is
transcript-attributed (by construction). ✅ VERIFIED mechanism via the per-video
signal breakdown. ⛔ Real per-channel attribution: REQUIRES REAL DATA.

---

## Report 9 — False Positive Audit

**Code path:** `falsePositiveReport()` — videos flagged by a sensational title
with **no** corroborating transcript (either transcript present but non-negative,
or no transcript at all).

🧪 SYNTHETIC-DEMO: 8 candidates (the title-only flags), each labeled with the
reason ("no transcript available to corroborate" / "transcript present but not
negative"). These are confidence-reduction opportunities — title-only flags that
transcript evidence neither supports nor exists for.

✅ VERIFIED mechanism (`ncAudit.test.ts`). ⛔ Real FP rate: REQUIRES REAL DATA.

---

## Report 10 — Transcript-First Readiness Assessment

**Code path:** `readinessAssessment()` — conservative, evidence-based level from
coverage % and transcript-driven share.

### Verdict

| Dimension | Status |
| --- | --- |
| Transcript-first **logic** (weighting 60%, spoken-content flag gate, transcript evidence, discovery-source audit) | ✅ **VERIFIED in code** (26/26 NC tests) |
| Transcript-first **operation on real data** (coverage, transcript-driven share) | ⛔ **UNVERIFIED** (no real videos/transcripts here) |

**Readiness level: LEVEL 3 — Transcript-Assisted Intelligence (VERIFIED).**
Level 4 (Transcript-First) logic is fully implemented and unit-proven, but
declaring Level 4/5 on real-world operation is **not supported by evidence in
this environment** and is therefore withheld.

> The synthetic harness run returns Level 4 for its constructed 80%-coverage /
> 33%-transcript-driven mix — but that is a property of the synthetic input, not
> of NC in production. Per the brief, we only declare a level the evidence
> supports: on real data, the level is currently **unmeasured**.

### Justification
- Implemented + verified: transcript-primary weighting, spoken-content flagging
  of neutral-title videos, timestamped transcript evidence with deep links, the
  full discovery-source/coverage/speech-only/FP audit, faster-whisper +
  `nc_transcript_segments` storage code.
- Missing for a real Level-4 declaration: an actual transcription run over a real
  collected set, producing measured coverage % and a measured transcript-driven
  discovery share.

### Remaining gaps
1. ⛔ Real transcript coverage % (needs caption fetch + faster-whisper on real videos).
2. ⛔ Real transcript-driven discovery share (the primary-question number).
3. Report 7 per-cluster transcript/title contribution needs a clusterer extension.
4. Live full-intelligence pass transcribes per-channel (bounded); full-scale
   speech-first surfacing is the backend Celery pipeline's job.

### Recommended next actions
1. Run the backend pipeline (faster-whisper large-v3) over a real collected set
   on a GPU host; persist `nc_transcript_segments` with `source`.
2. Feed that data to `runFullAudit(data, transcriptSources)` to obtain the **real**
   Reports 1–9 and a data-backed readiness level.
3. If measured coverage ≥ 70% and transcript-driven share ≥ 50%, Level 5 is
   justified; if coverage ≥ 50% and share ≥ 30%, Level 4 is justified.

---

## Verified vs estimated vs unverified — summary

- ✅ **Verified (code/tests):** audit harness and all classification mechanics;
  discovery-source logic; coverage counting; transcript-only & speech-only
  detection; FP detection; Telugu discovery/lexical extraction; transcript-first
  weighting + flagging; transcript-segment storage schema.
- 🧪 **Synthetic-demo only (not real metrics):** every numeric table above
  (coverage 80%, 24 flagged, 8 transcript-only, etc.) — these validate the
  harness on constructed input.
- ⛔ **Unverified (requires real data/models):** all real-world coverage,
  discovery-source counts, FP rates, narrative attribution, and the final
  real-data readiness level. None of these are estimated or fabricated.
