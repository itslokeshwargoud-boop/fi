"""NC (Narrative Control / Negative Channels Intelligence) backend services.

Each service is independently importable and degrades gracefully when its
optional heavy dependency (Whisper, EasyOCR, Detoxify, sentence-transformers,
FAISS, scikit-learn) is not installed. Deterministic services (preprocessing,
risk, evidence, channel intelligence) always run.
"""

from modules.nc import (
    preprocessing,
    toxicity_service,
    transcript_service,
    ocr_service,
    narrative_service,
    risk_service,
    evidence_service,
    channel_intelligence_service,
    observability,
    model_registry,
    context_classifier,
    risk_calibration,
    safety_gate,
    sentiment_service,
    embeddings_service,
    youtube_transcript_service,
    scoring_pipeline,
)

__all__ = [
    "preprocessing",
    "toxicity_service",
    "transcript_service",
    "ocr_service",
    "narrative_service",
    "risk_service",
    "evidence_service",
    "channel_intelligence_service",
    "observability",
    "model_registry",
    "context_classifier",
    "risk_calibration",
    "safety_gate",
    "sentiment_service",
    "embeddings_service",
    "youtube_transcript_service",
    "scoring_pipeline",
]
