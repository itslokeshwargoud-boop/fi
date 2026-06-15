"""Observability for the NC module: structured logging, inference timing, and
in-process metrics.

Deliberately dependency-free (stdlib only) so it always runs. Metrics are kept
in a process-local registry and can be scraped via :func:`snapshot` or exposed
through the API. A ``@timed`` decorator records call latency for sync and async
callables; counters track successes/failures/retries per pipeline stage.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from threading import Lock
from typing import Any, Callable

logger = logging.getLogger("nc")


# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------

def log_event(event: str, level: int = logging.INFO, **fields: Any) -> None:
    """Emit a single structured log line (JSON payload after the event name)."""
    try:
        payload = json.dumps(fields, default=str, ensure_ascii=False)
    except Exception:
        payload = str(fields)
    logger.log(level, "nc_event=%s %s", event, payload)


# ---------------------------------------------------------------------------
# Metrics registry
# ---------------------------------------------------------------------------

@dataclass
class _Timer:
    count: int = 0
    total_ms: float = 0.0
    max_ms: float = 0.0

    def observe(self, ms: float) -> None:
        self.count += 1
        self.total_ms += ms
        self.max_ms = max(self.max_ms, ms)

    @property
    def avg_ms(self) -> float:
        return round(self.total_ms / self.count, 2) if self.count else 0.0


@dataclass
class _Metrics:
    counters: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    timers: dict[str, _Timer] = field(default_factory=lambda: defaultdict(_Timer))
    _lock: Lock = field(default_factory=Lock)

    def incr(self, name: str, by: int = 1) -> None:
        with self._lock:
            self.counters[name] += by

    def observe(self, name: str, ms: float) -> None:
        with self._lock:
            self.timers[name].observe(ms)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "counters": dict(self.counters),
                "timers": {
                    k: {"count": t.count, "avg_ms": t.avg_ms, "max_ms": round(t.max_ms, 2)}
                    for k, t in self.timers.items()
                },
            }

    def reset(self) -> None:
        with self._lock:
            self.counters.clear()
            self.timers.clear()


METRICS = _Metrics()


def incr(name: str, by: int = 1) -> None:
    METRICS.incr(name, by)


def snapshot() -> dict[str, Any]:
    return METRICS.snapshot()


def timed(metric_name: str | None = None) -> Callable:
    """Decorator recording wall-clock latency into the metrics registry.

    Works on both sync and async functions.
    """

    def decorator(fn: Callable) -> Callable:
        name = metric_name or f"{fn.__module__}.{fn.__name__}"

        if asyncio.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def awrapper(*args: Any, **kwargs: Any) -> Any:
                start = time.perf_counter()
                ok = True
                try:
                    return await fn(*args, **kwargs)
                except Exception:
                    ok = False
                    raise
                finally:
                    ms = (time.perf_counter() - start) * 1000.0
                    METRICS.observe(name, ms)
                    METRICS.incr(f"{name}.{'ok' if ok else 'error'}")

            return awrapper

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            start = time.perf_counter()
            ok = True
            try:
                return fn(*args, **kwargs)
            except Exception:
                ok = False
                raise
            finally:
                ms = (time.perf_counter() - start) * 1000.0
                METRICS.observe(name, ms)
                METRICS.incr(f"{name}.{'ok' if ok else 'error'}")

        return wrapper

    return decorator
