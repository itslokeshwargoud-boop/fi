"""Thumbnail OCR for the NC module (EasyOCR-based).

Extracts overlaid text from video thumbnails ("EXPOSED", "FAKE", "OVERACTION",
Telugu equivalents) which is a strong signal for controversy/clickbait framing.

EasyOCR pulls model weights and a torch backend, so it is loaded lazily and the
service degrades gracefully: if EasyOCR is unavailable, ``available`` is False
and the pipeline simply contributes no OCR evidence rather than failing. Nothing
here invents OCR text.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from modules.nc.preprocessing import normalize_text

logger = logging.getLogger(__name__)

# Framing keywords that, when found in thumbnail text, indicate controversy
# packaging. Used to weight OCR evidence severity.
_FRAMING_TERMS = {
    "exposed", "expose", "fake", "fraud", "shocking", "truth", "reality",
    "overaction", "boycott", "warning", "leaked", "నిజం", "మోసం", "బట్టబయలు",
}


@dataclass
class OCRResult:
    video_id: str
    available: bool
    texts: list[str] = field(default_factory=list)
    framing_hits: list[str] = field(default_factory=list)
    reason: str | None = None
    confidence: float = 0.0
    boxes: list[dict] = field(default_factory=list)  # {text, conf, bbox}


class OCRService:
    """Lazy EasyOCR wrapper (Telugu + English) with graceful degradation."""

    _instance: "OCRService | None" = None
    # Thumbnails are upscaled to this min width before OCR for small overlay text.
    MIN_WIDTH = 640

    def __init__(self) -> None:
        self._reader = None
        self._tried_load = False
        self.available = False
        self.device = "cpu"

    @classmethod
    def get_instance(cls) -> "OCRService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _ensure_reader(self) -> None:
        if self._tried_load:
            return
        self._tried_load = True
        try:
            import easyocr  # type: ignore

            # Share module-wide device decision (GPU when available).
            gpu = False
            try:
                from modules.nc.model_registry import resolve_device

                self.device = resolve_device()
                gpu = self.device == "cuda"
            except Exception:
                gpu = False
            self._reader = easyocr.Reader(["te", "en"], gpu=gpu)
            self.available = True
            logger.info("EasyOCR (te,en) loaded for NC thumbnail OCR on %s.", self.device)
        except Exception as exc:  # pragma: no cover - env dependent
            logger.warning("EasyOCR unavailable for NC OCR: %s", exc)
            self._reader = None
            self.available = False

    @staticmethod
    def _preprocess(image_path: str) -> str:
        """Upscale small thumbnails for better small-text recall. Returns a path
        (original if preprocessing libs are unavailable). Never raises."""
        try:
            from PIL import Image  # type: ignore
            import tempfile
            import os

            img = Image.open(image_path).convert("RGB")
            if img.width < OCRService.MIN_WIDTH:
                scale = OCRService.MIN_WIDTH / img.width
                img = img.resize((OCRService.MIN_WIDTH, int(img.height * scale)))
                out = os.path.join(tempfile.gettempdir(), "nc_ocr_tmp.png")
                img.save(out)
                return out
        except Exception:
            pass
        return image_path

    def extract(self, image_path: str, video_id: str) -> OCRResult:
        self._ensure_reader()
        if self._reader is None:
            return OCRResult(
                video_id=video_id, available=False, reason="easyocr_not_installed"
            )
        try:
            path = self._preprocess(image_path)
            # detail=1 returns (bbox, text, confidence) per detection.
            raw = self._reader.readtext(path, detail=1)
            texts, boxes, confs = [], [], []
            for det in raw:
                try:
                    bbox, text, conf = det
                except Exception:
                    continue
                norm = normalize_text(text)
                if not norm:
                    continue
                texts.append(norm)
                confs.append(float(conf))
                boxes.append(
                    {"text": norm, "conf": round(float(conf), 4),
                     "bbox": [[int(x), int(y)] for x, y in bbox]}
                )
            framing = sorted(
                {term for t in texts for term in _FRAMING_TERMS if term in t}
            )
            overall = round(sum(confs) / len(confs), 4) if confs else 0.0
            return OCRResult(
                video_id=video_id,
                available=True,
                texts=texts,
                framing_hits=framing,
                confidence=overall,
                boxes=boxes,
            )
        except Exception as exc:  # pragma: no cover
            logger.error("EasyOCR failed for %s: %s", video_id, exc)
            return OCRResult(
                video_id=video_id, available=False, reason=f"ocr_error: {exc}"
            )

    def extract_batch(self, items: list[tuple[str, str]]) -> list[OCRResult]:
        """Batch OCR over (image_path, video_id) pairs."""
        return [self.extract(path, vid) for path, vid in items]
