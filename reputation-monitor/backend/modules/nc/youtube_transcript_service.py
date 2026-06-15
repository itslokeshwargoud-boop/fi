"""YouTube transcript ingestion for the NC module.

Resolves a usable transcript for a video using a priority chain, so the
expensive Whisper path is only used when free captions don't exist:

  1. Official (manually-created) captions  — most accurate
  2. Auto-generated captions               — usually available
  3. Whisper transcription                 — fallback (model-optional)

Telugu is preferred, then Telugu-English, then any available language (recorded
as the transcript source/language for downstream handling). Output is
normalized and de-duplicated (caption tracks frequently repeat lines across
overlapping cues).

Uses ``youtube-transcript-api`` for captions (no API key, no model). The Whisper
fallback is delegated to :mod:`transcript_service` and is fully optional.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from modules.nc.preprocessing import normalize_text, detect_language

logger = logging.getLogger("nc")

_PREFERRED_LANGS = ["te", "te-en", "en"]


@dataclass
class IngestedTranscript:
    video_id: str
    available: bool
    source: str            # official_caption | auto_caption | whisper | none
    language: str
    full_text: str = ""
    segments: list[dict] = field(default_factory=list)  # {start, text}
    confidence: float = 0.0
    reason: str | None = None


def _dedup_segments(segments: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for seg in segments:
        norm = normalize_text(seg.get("text", ""))
        if not norm or norm in seen:
            continue
        seen.add(norm)
        out.append({"start": float(seg.get("start", 0.0)), "text": norm})
    return out


def _fetch_captions(video_id: str) -> IngestedTranscript | None:
    """Try official then auto captions via youtube-transcript-api."""
    try:
        from youtube_transcript_api import (  # type: ignore
            YouTubeTranscriptApi,
            TranscriptsDisabled,
            NoTranscriptFound,
        )
    except Exception as exc:  # pragma: no cover - env dependent
        logger.debug("youtube-transcript-api unavailable: %s", exc)
        return None

    try:
        listing = YouTubeTranscriptApi.list_transcripts(video_id)
    except (TranscriptsDisabled, NoTranscriptFound):
        return IngestedTranscript(video_id, False, "none", "unknown",
                                  reason="captions_disabled_or_absent")
    except Exception as exc:
        logger.debug("caption listing failed for %s: %s", video_id, exc)
        return None

    # 1) Manually-created captions (preferred languages first).
    for source, finder in (
        ("official_caption", listing.find_manually_created_transcript),
        ("auto_caption", listing.find_generated_transcript),
    ):
        try:
            tr = finder(_PREFERRED_LANGS)
        except Exception:
            tr = None
        if tr is None:
            # accept any language if preferred not present
            try:
                tr = next(iter(listing), None)
            except Exception:
                tr = None
        if tr is not None:
            try:
                raw = tr.fetch()
            except Exception:
                continue
            segments = _dedup_segments(
                [{"start": r.get("start", 0.0), "text": r.get("text", "")} for r in raw]
            )
            full = normalize_text(" ".join(s["text"] for s in segments))
            if full:
                lang = getattr(tr, "language_code", None) or detect_language(full)
                # Official captions are high-confidence; auto somewhat lower.
                conf = 0.95 if source == "official_caption" else 0.8
                return IngestedTranscript(
                    video_id, True, source, lang, full, segments, conf
                )
    return IngestedTranscript(video_id, False, "none", "unknown",
                              reason="no_usable_caption_track")


def ingest_transcript(
    video_id: str,
    video_url: str | None = None,
    allow_whisper: bool = True,
) -> IngestedTranscript:
    """Resolve a transcript via the caption->Whisper priority chain."""
    captions = _fetch_captions(video_id)
    if captions and captions.available:
        logger.info("NC transcript %s via %s (%s)", video_id, captions.source, captions.language)
        return captions

    if not allow_whisper or not video_url:
        return captions or IngestedTranscript(
            video_id, False, "none", "unknown", reason="no_captions_no_whisper"
        )

    # Whisper fallback (model-optional; returns unavailable if not installed).
    from modules.nc.transcript_service import TranscriptService
    import os
    import tempfile

    ts = TranscriptService.get_instance()
    with tempfile.TemporaryDirectory() as tmp:
        audio = os.path.join(tmp, "a.wav")
        if ts.extract_audio(video_url, audio) and os.path.exists(audio):
            res = ts.transcribe(audio, video_id)
            if res.available:
                segments = [
                    {"start": s.start, "text": s.text} for s in res.segments
                ]
                return IngestedTranscript(
                    video_id, True, "whisper", res.language,
                    res.full_text, _dedup_segments(segments),
                    confidence=getattr(res, "confidence", 0.7),
                )

    return IngestedTranscript(
        video_id, False, "none", "unknown", reason="all_sources_failed"
    )
