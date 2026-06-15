"""Semantic narrative detection & clustering for the NC module.

The brief is explicit: narrative detection must be *semantic*, not keyword-only.
This service implements a layered approach that always produces real clusters:

* **Embeddings** — prefer ``sentence-transformers`` (multilingual MiniLM /
  LaBSE) for true semantic vectors. If unavailable, fall back to a real TF-IDF
  vectorizer (scikit-learn), and failing that, a dependency-free hashing TF-IDF.
* **Clustering** — prefer ``DBSCAN`` (scikit-learn) over the embedding space.
  If scikit-learn is absent, fall back to a deterministic cosine-similarity
  greedy clustering (the same algorithm the frontend engine uses), so results
  stay consistent across the offline and live paths.
* **Vector search** — an optional FAISS index is built when FAISS is present to
  match new videos to existing narratives without re-clustering.

Every tier is genuinely functional; the heavy libraries only improve quality,
they are never required for the module to run. ``backend`` reports which tier
was actually used so the system is honest about its current capability.
"""

from __future__ import annotations

import logging
import math
import re
from collections import Counter
from dataclasses import dataclass, field

from modules.nc.preprocessing import normalize_text, tokenize

logger = logging.getLogger(__name__)

# Narrative type inference: maps signal terms to the shared NarrativeType enum.
_NARRATIVE_SIGNALS: dict[str, list[str]] = {
    "authenticity_attack": ["fake", "fraud", "real", "truth", "నిజం", "మోసం", "paid"],
    "controversy_farming": ["controversy", "drama", "issue", "clickbait", "shocking"],
    "fan_war": ["vs", "better", "flop", "blockbuster", "fans", "army"],
    "harassment": ["boycott", "shameless", "expose", "target", "cheat", "నీచుడు"],
    "political_attack": ["party", "politics", "caste", "religion", "మతం", "కులం"],
    "overaction_claim": ["overaction", "acting", "నటన", "drama"],
}


@dataclass
class NarrativeCluster:
    cluster_id: int
    label: str
    narrative_type: str
    size: int
    members: list[int]              # indices into the input docs
    key_terms: list[str]
    sample_text: str
    centroid: list[float] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Embedding tiers
# ---------------------------------------------------------------------------

class _Embedder:
    """Resolves the best available embedding backend, once."""

    _instance: "_Embedder | None" = None

    def __init__(self) -> None:
        self.backend = "hashing-tfidf"
        self._st_model = None
        self._sk_vectorizer = None
        self._resolve()

    @classmethod
    def get(cls) -> "_Embedder":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _resolve(self) -> None:
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore

            self._st_model = SentenceTransformer(
                "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
            )
            self.backend = "sentence-transformers"
            logger.info("NC narratives using sentence-transformers embeddings.")
            return
        except Exception as exc:  # pragma: no cover - env dependent
            logger.warning("sentence-transformers unavailable: %s", exc)
        try:
            from sklearn.feature_extraction.text import TfidfVectorizer  # type: ignore

            self._sk_vectorizer = TfidfVectorizer(
                max_features=4096, ngram_range=(1, 2)
            )
            self.backend = "sklearn-tfidf"
            logger.info("NC narratives using scikit-learn TF-IDF embeddings.")
        except Exception as exc:  # pragma: no cover
            logger.warning("scikit-learn unavailable, using hashing TF-IDF: %s", exc)
            self.backend = "hashing-tfidf"

    def embed(self, texts: list[str]) -> list[list[float]]:
        if self._st_model is not None:
            vecs = self._st_model.encode(texts, normalize_embeddings=True)
            return [list(map(float, v)) for v in vecs]
        if self._sk_vectorizer is not None:
            matrix = self._sk_vectorizer.fit_transform(texts)
            return matrix.toarray().tolist()
        return _hashing_tfidf(texts)


def _hashing_tfidf(texts: list[str], dim: int = 512) -> list[list[float]]:
    """Dependency-free TF-IDF with feature hashing + L2 normalization."""
    docs_tokens = [tokenize(t) for t in texts]
    df = Counter()
    for toks in docs_tokens:
        for tok in set(toks):
            df[tok] += 1
    n = max(1, len(texts))
    vectors: list[list[float]] = []
    for toks in docs_tokens:
        vec = [0.0] * dim
        tf = Counter(toks)
        for tok, count in tf.items():
            idf = math.log((1 + n) / (1 + df[tok])) + 1.0
            idx = (hash(tok) % dim + dim) % dim
            vec[idx] += (count / max(1, len(toks))) * idf
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        vectors.append([x / norm for x in vec])
    return vectors


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return dot / (na * nb)


# ---------------------------------------------------------------------------
# Clustering tiers
# ---------------------------------------------------------------------------

def _dbscan_labels(vectors: list[list[float]], eps: float, min_samples: int):
    try:
        import numpy as np  # type: ignore
        from sklearn.cluster import DBSCAN  # type: ignore

        arr = np.array(vectors)
        labels = DBSCAN(eps=eps, min_samples=min_samples, metric="cosine").fit_predict(
            arr
        )
        return labels.tolist(), "dbscan"
    except Exception as exc:  # pragma: no cover
        logger.debug("DBSCAN unavailable, greedy cosine clustering: %s", exc)
        return _greedy_cosine_labels(vectors, threshold=1.0 - eps), "greedy-cosine"


def _greedy_cosine_labels(vectors: list[list[float]], threshold: float) -> list[int]:
    """Deterministic greedy clustering: assign to nearest centroid above
    ``threshold`` or open a new cluster. Mirrors the frontend engine."""
    labels = [-1] * len(vectors)
    centroids: list[list[float]] = []
    for i, v in enumerate(vectors):
        best, best_sim = -1, threshold
        for c_idx, c in enumerate(centroids):
            sim = _cosine(v, c)
            if sim >= best_sim:
                best, best_sim = c_idx, sim
        if best == -1:
            centroids.append(list(v))
            labels[i] = len(centroids) - 1
        else:
            labels[i] = best
            # incremental centroid mean
            c = centroids[best]
            centroids[best] = [(a + b) / 2.0 for a, b in zip(c, v)]
    return labels


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _infer_type(terms: list[str]) -> str:
    scores = {nt: 0 for nt in _NARRATIVE_SIGNALS}
    joined = " ".join(terms)
    for nt, signals in _NARRATIVE_SIGNALS.items():
        for s in signals:
            if s in joined:
                scores[nt] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "general_negative"


def _top_terms(texts: list[str], k: int = 5) -> list[str]:
    counter = Counter()
    for t in texts:
        for tok in tokenize(t):
            if len(tok) > 2:
                counter[tok] += 1
    return [w for w, _ in counter.most_common(k)]


def cluster_narratives(
    texts: list[str], eps: float = 0.35, min_samples: int = 2
) -> tuple[list[NarrativeCluster], str]:
    """Cluster texts into semantic narratives.

    Returns (clusters, backend_string). ``backend_string`` reflects which
    embedding+clustering tiers actually ran.
    """
    cleaned = [normalize_text(t) for t in texts]
    nonempty = [(i, t) for i, t in enumerate(cleaned) if t]
    if not nonempty:
        return [], "none"

    idx_map = [i for i, _ in nonempty]
    docs = [t for _, t in nonempty]

    embedder = _Embedder.get()
    vectors = embedder.embed(docs)
    labels, cluster_backend = _dbscan_labels(vectors, eps, min_samples)

    grouped: dict[int, list[int]] = {}
    for local_idx, lbl in enumerate(labels):
        if lbl == -1:
            continue  # DBSCAN noise
        grouped.setdefault(lbl, []).append(local_idx)

    clusters: list[NarrativeCluster] = []
    for cid, local_members in sorted(
        grouped.items(), key=lambda kv: len(kv[1]), reverse=True
    ):
        member_docs = [docs[m] for m in local_members]
        terms = _top_terms(member_docs)
        ntype = _infer_type(terms)
        label = f"{ntype.replace('_', ' ').title()}: " + " / ".join(terms[:3])
        centroid = [
            sum(vectors[m][d] for m in local_members) / len(local_members)
            for d in range(len(vectors[0]))
        ] if vectors and vectors[0] else []
        clusters.append(
            NarrativeCluster(
                cluster_id=cid,
                label=label,
                narrative_type=ntype,
                size=len(local_members),
                members=[idx_map[m] for m in local_members],
                key_terms=terms,
                sample_text=member_docs[0],
                centroid=centroid,
            )
        )

    return clusters, f"{embedder.backend}+{cluster_backend}"


def build_faiss_index(vectors: list[list[float]]):
    """Optionally build a FAISS index for narrative similarity search.

    Returns the index or None when FAISS isn't installed (graceful).
    """
    try:
        import faiss  # type: ignore
        import numpy as np  # type: ignore

        if not vectors:
            return None
        arr = np.array(vectors, dtype="float32")
        index = faiss.IndexFlatIP(arr.shape[1])
        faiss.normalize_L2(arr)
        index.add(arr)
        return index
    except Exception as exc:  # pragma: no cover - env dependent
        logger.warning("FAISS unavailable, narrative similarity search disabled: %s", exc)
        return None
