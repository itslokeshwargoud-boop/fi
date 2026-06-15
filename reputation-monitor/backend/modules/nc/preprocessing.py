"""Text preprocessing for the NC module.

Handles the Telugu / transliterated-Telugu / Telugu-English code-mixed text
that dominates this ecosystem: Unicode normalization, emoji stripping, slang
expansion and light romanization cleanup. This is real, deterministic logic
(no model dependency) and mirrors the frontend ``lib/nc/preprocess.ts`` so the
offline pipeline and the live engine normalize text the same way.
"""

from __future__ import annotations

import re
import unicodedata

# Telugu Unicode block.
_TELUGU_RANGE = re.compile(r"[\u0C00-\u0C7F]")
_EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F0FF]",
    flags=re.UNICODE,
)
_MULTISPACE = re.compile(r"\s+")
_URL = re.compile(r"https?://\S+|www\.\S+")
_REPEAT_CHAR = re.compile(r"(.)\1{2,}")  # "fakeeee" -> "fakee"

# Extensible slang / transliteration normalization map. Keys are matched as
# whole words, case-insensitively. Register more at runtime via ``register_slang``.
_SLANG: dict[str, str] = {
    "ra": "ra",
    "rey": "ra",
    "bro": "bro",
    "anna": "anna",
    "chestundi": "chestundi",
    "chesthundi": "chestundi",
    "chestunnadu": "chestunnadu",
    "chesthunnadu": "chestunnadu",
    "overaction": "overaction",
    "over": "over",
    "fkng": "fucking",
    "fk": "fuck",
    "fake": "fake",
    "fke": "fake",
}


def register_slang(mapping: dict[str, str]) -> None:
    """Extend the slang/transliteration normalization map at runtime."""
    _SLANG.update({k.lower(): v.lower() for k, v in mapping.items()})


def has_telugu(text: str) -> bool:
    return bool(_TELUGU_RANGE.search(text or ""))


def detect_language(text: str) -> str:
    """Coarse language tag used for routing/storage.

    Returns ``te`` (Telugu script present), ``te-en`` (mixed: Telugu + ASCII
    words), or ``en``. Intentionally lightweight — not a substitute for a
    proper language identifier, just enough to route transcription/sentiment.
    """
    if not text:
        return "en"
    telugu = has_telugu(text)
    ascii_words = bool(re.search(r"[A-Za-z]{2,}", text))
    if telugu and ascii_words:
        return "te-en"
    if telugu:
        return "te"
    return "en"


def normalize_text(text: str) -> str:
    """Return a normalized form suitable for lexical + semantic analysis."""
    if not text:
        return ""
    # Canonical Unicode form (composes Telugu matras consistently).
    out = unicodedata.normalize("NFKC", text)
    out = _URL.sub(" ", out)
    out = _EMOJI.sub(" ", out)
    out = out.lower()
    out = _REPEAT_CHAR.sub(r"\1\1", out)

    # Word-level slang expansion (only affects romanized tokens).
    def _swap(m: re.Match[str]) -> str:
        return _SLANG.get(m.group(0), m.group(0))

    out = re.sub(r"[a-z]+", _swap, out)
    out = _MULTISPACE.sub(" ", out).strip()
    return out


def tokenize(text: str) -> list[str]:
    """Tokenize normalized text into Telugu + romanized word tokens."""
    norm = normalize_text(text)
    # Keep Telugu runs and ascii word runs as tokens.
    return re.findall(r"[\u0C00-\u0C7F]+|[a-z]{2,}", norm)
