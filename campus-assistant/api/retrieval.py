"""
In-memory semantic search over the normalized campus records.
No vector DB — the dataset is small enough that a linear scan over
NumPy arrays is effectively instant.
"""

import os

import numpy as np

from api.data_loader import Record

# Cosine-similarity thresholds that decide the fallback tier.
# Gemini embedding similarity for genuinely related short texts is
# usually well above 0.6; unrelated text usually sits below 0.45.
# These are starting points — tune them once you see real query
# traffic against your full dataset. Override via env vars if needed.
CONFIDENT_THRESHOLD = float(os.environ.get("RETRIEVAL_CONFIDENT_THRESHOLD", 0.54))
WEAK_THRESHOLD = float(os.environ.get("RETRIEVAL_WEAK_THRESHOLD", 0.45))

TOP_K = int(os.environ.get("RETRIEVAL_TOP_K", 8))


class Retriever:
    def __init__(self, records: list[Record], embeddings: list[list[float]]):
        assert len(records) == len(embeddings), "records/embeddings length mismatch"
        self.records = records
        matrix = np.array(embeddings, dtype=np.float32)
        # Pre-normalize so similarity is a plain dot product.
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1e-8
        self._normed = matrix / norms

    def rank(self, query_embedding: list[float], top_k: int = TOP_K) -> list[tuple[Record, float]]:
        q = np.array(query_embedding, dtype=np.float32)
        q_norm = np.linalg.norm(q)
        if q_norm == 0:
            q_norm = 1e-8
        q = q / q_norm

        scores = self._normed @ q  # cosine similarity for every record
        order = np.argsort(-scores)[:top_k]
        return [(self.records[i], float(scores[i])) for i in order]


def classify_match(top_score: float) -> str:
    """Return "confident" | "weak" | "none" based on the top similarity score."""
    if top_score >= CONFIDENT_THRESHOLD:
        return "confident"
    if top_score >= WEAK_THRESHOLD:
        return "weak"
    return "none"
