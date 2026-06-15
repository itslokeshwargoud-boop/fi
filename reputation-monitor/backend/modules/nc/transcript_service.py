"""Transcript extraction for the NC module (Whisper-based).

Pipeline: YouTube video -> audio extraction -> Whisper transcription ->
cleaned, timestamped transcript. Designed for async/worker execution so it
never blocks the API.

Whisper + ffmpeg are heavy, GPU-friendly dependencies that are not present in
every deployment. This service therefore:

* loads the model lazily and only once (singleton),
* degrades gracefully — if Whisper or its audio backend is unavailable,
  ``available`` is False and callers fall back to title/description/comment
  signals instead of crashing,
* returns segments with ``[mm:ss]`` timestamps so the evidence engine can cite
  exact moments in the drawer.

It is honest about being model-optional: nothing here fabricates a transcript.
If the model can't run, it returns an explicit "unavailable" result.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from modules.nc.preprocessing import normalize_text

logger = logging.getLogger(__name__)


def _fmt_ts(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


@dataclass
class TranscriptSegment:
    start: float
    end: float
    text: str

    @property
    def timestamp(self) -> str:
        return _fmt_ts(self.start)


@dataclass
class TranscriptResult:
    video_id: str
    language: str
    available: bool
    segments: list[TranscriptSegment] = field(default_factory=list)
    full_text: str = ""
    reason: str | None = None  # populated when available is False
    confidence: float = 0.0    # 0..1 transcript quality (Whisper logprobs)
    source: str = "whisper"
    device: str = "cpu"
    model_size: str = ""


class TranscriptService:
    """Lazy Whisper wrapper with graceful degradation."""

    _instance: "TranscriptService | None" = None
    # Preferred model for Telugu quality (faster-whisper). Override via
    # NC_WHISPER_SIZE (e.g. large-v3 | medium | small | base).
    MODEL_SIZE = "large-v3"

    def __init__(self) -> None:
        self._model = None
        self._tried_load = False
        self.available = False
        self.device = "cpu"
        self.model_size = ""
        self.backend = ""  # "faster-whisper" | "whisper"

    @classmethod
    def get_instance(cls) -> "TranscriptService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @staticmethod
    def ffmpeg_available() -> bool:
        """Validate ffmpeg presence (required by Whisper for decoding)."""
        import shutil

        return shutil.which("ffmpeg") is not None

    def _ensure_model(self) -> None:
        if self._tried_load:
            return
        self._tried_load = True
        import os

        # Default to large-v3 for Telugu quality; override via NC_WHISPER_SIZE.
        size = os.getenv("NC_WHISPER_SIZE", self.MODEL_SIZE)
        try:
            from modules.nc.model_registry import resolve_device

            self.device = resolve_device()
        except Exception:
            self.device = "cpu"

        # 1) Preferred backend: faster-whisper (CTranslate2 — faster, lower mem).
        try:
            from faster_whisper import WhisperModel  # type: ignore

            compute_type = "float16" if self.device == "cuda" else "int8"
            self._model = WhisperModel(size, device=self.device, compute_type=compute_type)
            self.backend = "faster-whisper"
            self.model_size = size
            self.available = True
            logger.info(
                "faster-whisper '%s' loaded on %s (%s).", size, self.device, compute_type
            )
            return
        except Exception as exc:  # pragma: no cover - env dependent
            logger.info("faster-whisper unavailable (%s); trying openai-whisper.", exc)

        # 2) Fallback backend: openai-whisper.
        try:
            import whisper  # type: ignore

            # openai-whisper uses different size ids; map large-v3 sensibly.
            owsize = size if size in {"tiny", "base", "small", "medium", "large"} else "medium"
            self._model = whisper.load_model(owsize, device=self.device)
            self.backend = "whisper"
            self.model_size = owsize
            self.available = True
            logger.info("openai-whisper '%s' loaded on %s.", owsize, self.device)
        except Exception as exc:  # pragma: no cover - env dependent
            logger.warning("No Whisper backend available for NC transcription: %s", exc)
            self._model = None
            self.available = False

    def transcribe(self, audio_path: str, video_id: str) -> TranscriptResult:
        """Transcribe a local audio file. Telugu + code-mixed aware.

        Supports both faster-whisper and openai-whisper backends transparently.
        """
        self._ensure_model()
        if self._model is None:
            return TranscriptResult(
                video_id=video_id,
                language="unknown",
                available=False,
                reason="whisper_not_installed",
            )
        try:
            if getattr(self, "backend", "whisper") == "faster-whisper":
                return self._transcribe_faster(audio_path, video_id)
            return self._transcribe_openai(audio_path, video_id)
        except Exception as exc:  # pragma: no cover
            logger.error("Whisper transcription failed for %s: %s", video_id, exc)
            return TranscriptResult(
                video_id=video_id, language="unknown", available=False,
                reason=f"transcription_error: {exc}",
            )

    def _transcribe_faster(self, audio_path: str, video_id: str) -> TranscriptResult:
        # faster-whisper streams segments; vad_filter trims silence/noise.
        seg_iter, info = self._model.transcribe(
            audio_path, task="transcribe", vad_filter=True, beam_size=5,
        )
        segments, logprobs = [], []
        for s in seg_iter:
            text = normalize_text(getattr(s, "text", ""))
            if not text:
                continue
            segments.append(
                TranscriptSegment(
                    start=float(getattr(s, "start", 0.0)),
                    end=float(getattr(s, "end", 0.0)),
                    text=text,
                )
            )
            if getattr(s, "avg_logprob", None) is not None:
                logprobs.append(float(s.avg_logprob))
        import math as _m

        confidence = round(
            min(1.0, max(0.0, _m.exp(sum(logprobs) / len(logprobs)))) if logprobs else 0.5,
            4,
        )
        return TranscriptResult(
            video_id=video_id,
            language=getattr(info, "language", "te") or "te",
            available=bool(segments),
            segments=segments,
            full_text=" ".join(s.text for s in segments),
            confidence=confidence,
            source="faster-whisper",
            device=self.device,
            model_size=self.model_size,
            reason=None if segments else "empty_transcript",
        )

    def _transcribe_openai(self, audio_path: str, video_id: str) -> TranscriptResult:
        # task='transcribe' keeps original-language output (Telugu stays Telugu).
        result = self._model.transcribe(
            audio_path, task="transcribe", fp16=(self.device == "cuda")
        )
        raw_segments = [
            s for s in result.get("segments", []) if s.get("text", "").strip()
        ]
        segments = [
            TranscriptSegment(
                start=float(s.get("start", 0.0)),
                end=float(s.get("end", 0.0)),
                text=normalize_text(s.get("text", "")),
            )
            for s in raw_segments
        ]
        confidence = self._score_confidence(raw_segments)
        return TranscriptResult(
            video_id=video_id,
            language=result.get("language", "te"),
            available=True,
            segments=segments,
            full_text=normalize_text(result.get("text", "")),
            confidence=confidence,
            source="whisper",
            device=self.device,
            model_size=self.model_size,
        )

    @staticmethod
    def _score_confidence(raw_segments: list[dict]) -> float:
        """Derive a 0..1 transcript-quality score from Whisper diagnostics.

        Combines mean segment log-probability (mapped to a probability) with the
        no-speech probability so noisy/empty audio scores low.
        """
        if not raw_segments:
            return 0.0
        import math as _m

        logps, nospeech = [], []
        for s in raw_segments:
            if "avg_logprob" in s:
                logps.append(float(s["avg_logprob"]))
            if "no_speech_prob" in s:
                nospeech.append(float(s["no_speech_prob"]))
        prob = _m.exp(sum(logps) / len(logps)) if logps else 0.5
        speech = 1.0 - (sum(nospeech) / len(nospeech) if nospeech else 0.0)
        return round(max(0.0, min(1.0, 0.6 * prob + 0.4 * speech)), 4)

    @staticmethod
    def extract_audio(video_url: str, out_path: str) -> bool:
        """Extract audio to ``out_path`` using yt-dlp + ffmpeg if available.

        Returns True on success, False (no raise) if the toolchain is missing —
        again keeping the pipeline non-blocking and honest about availability.
        """
        try:
            import yt_dlp  # type: ignore

            opts = {
                "format": "bestaudio/best",
                "outtmpl": out_path,
                "quiet": True,
                "postprocessors": [
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": "wav",
                        "preferredquality": "192",
                    }
                ],
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([video_url])
            return True
        except Exception as exc:  # pragma: no cover - env dependent
            logger.warning("Audio extraction unavailable (%s).", exc)
            return False
