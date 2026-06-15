"""Central model registry for the NC module.

Solves the problems the brief calls out: duplicate model loading, memory leaks,
worker crashes, and unmanaged GPU memory. Every heavy model (Whisper, EasyOCR,
Detoxify, sentence-transformers) registers a *loader* here and is then accessed
through :func:`get`, which guarantees:

* **lazy, once-only loading** (singleton per key, thread-safe),
* **fault tolerance** — a failed load is recorded and returns ``None`` instead
  of raising, so the deterministic fallback path stays alive,
* **health introspection** — :func:`health` reports load state, last error,
  load time and inference counters,
* **device selection** — :func:`resolve_device` detects CUDA once and lets the
  whole module share one CPU/GPU decision,
* **memory cleanup** — :func:`unload` / :func:`unload_all` drop references and
  free CUDA cache when torch is present.

This module never *requires* torch or any model; it only uses them if present.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from modules.nc.observability import log_event

logger = logging.getLogger("nc")

_lock = threading.RLock()


@dataclass
class _Entry:
    loader: Callable[[], Any]
    instance: Any = None
    loaded: bool = False
    failed: bool = False
    last_error: str | None = None
    load_time_s: float = 0.0
    inferences: int = 0


_REGISTRY: dict[str, _Entry] = {}
_DEVICE: str | None = None


# ---------------------------------------------------------------------------
# Device detection (once)
# ---------------------------------------------------------------------------

def resolve_device(prefer_gpu: bool = True) -> str:
    """Return 'cuda' or 'cpu', detected once and cached. Never raises."""
    global _DEVICE
    if _DEVICE is not None:
        return _DEVICE
    device = "cpu"
    if prefer_gpu:
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                device = "cuda"
        except Exception:
            device = "cpu"
    _DEVICE = device
    log_event("nc_device_resolved", device=device)
    return device


def device_index() -> int:
    """Convenience for libraries that take an int device id (-1 == CPU)."""
    return 0 if resolve_device() == "cuda" else -1


# ---------------------------------------------------------------------------
# Registration & access
# ---------------------------------------------------------------------------

def register(key: str, loader: Callable[[], Any]) -> None:
    """Register a lazy loader under ``key`` (idempotent)."""
    with _lock:
        if key not in _REGISTRY:
            _REGISTRY[key] = _Entry(loader=loader)


def get(key: str) -> Any | None:
    """Return the loaded model for ``key``, loading lazily on first use.

    Returns ``None`` (never raises) if the model is unregistered or its load
    failed — callers then use their deterministic fallback.
    """
    with _lock:
        entry = _REGISTRY.get(key)
        if entry is None:
            return None
        if entry.loaded:
            return entry.instance
        if entry.failed:
            return None
        start = time.perf_counter()
        try:
            entry.instance = entry.loader()
            entry.loaded = True
            entry.load_time_s = round(time.perf_counter() - start, 3)
            log_event("nc_model_loaded", key=key, load_time_s=entry.load_time_s,
                      device=resolve_device())
        except Exception as exc:  # pragma: no cover - env dependent
            entry.failed = True
            entry.last_error = str(exc)
            log_event("nc_model_load_failed", level=logging.WARNING, key=key,
                      error=str(exc))
            return None
        return entry.instance


def note_inference(key: str, n: int = 1) -> None:
    with _lock:
        entry = _REGISTRY.get(key)
        if entry:
            entry.inferences += n


def is_available(key: str) -> bool:
    """True if the model can be obtained (loads it lazily to find out)."""
    return get(key) is not None


# ---------------------------------------------------------------------------
# Health & cleanup
# ---------------------------------------------------------------------------

def health() -> dict[str, Any]:
    with _lock:
        return {
            "device": resolve_device(),
            "models": {
                key: {
                    "registered": True,
                    "loaded": e.loaded,
                    "failed": e.failed,
                    "last_error": e.last_error,
                    "load_time_s": e.load_time_s,
                    "inferences": e.inferences,
                }
                for key, e in _REGISTRY.items()
            },
        }


def unload(key: str) -> None:
    with _lock:
        entry = _REGISTRY.get(key)
        if entry:
            entry.instance = None
            entry.loaded = False
    _free_cuda()


def unload_all() -> None:
    with _lock:
        for entry in _REGISTRY.values():
            entry.instance = None
            entry.loaded = False
    _free_cuda()


def _free_cuda() -> None:
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
