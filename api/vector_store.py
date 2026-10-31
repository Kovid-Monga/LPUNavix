"""
api/vector_store.py — High-Dimensional In-Memory Vector Search for LPUNavix
=============================================================================
Treats js/data.js as the SINGLE SOURCE OF TRUTH via api.data_loader.
Embeds campus records using high-dimensional semantic embeddings (3,072 dimensions,
gemini-embedding-001) with subword BPE tokenization.
Implements incremental caching with SHA-256 text hashes and atomic .npy persistence.
Regenerates embeddings only for new/modified records; removes stale vectors.
Never persists zero vectors on embedding service failure.
Pre-normalizes the embedding matrix for sub-millisecond dot-product retrieval.
"""

import hashlib
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from api.data_loader import CampusDataLoader, Record, get_campus_data_loader

logger = logging.getLogger("LPUNavix.VectorStore")
logger.setLevel(logging.INFO)

from api import gemini_client

EMBED_MODEL = gemini_client.EMBEDDING_MODEL
EXPECTED_DIM = gemini_client.EMBEDDING_DIMENSION
CONFIDENT_THRESHOLD = 0.495
WEAK_THRESHOLD = 0.45

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
VECTORS_PATH = DATA_DIR / "campus_vectors.npy"
META_PATH = DATA_DIR / "campus_vector_meta.json"

_STOPWORDS = {
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
    "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
    "below", "between", "both", "but", "by", "can", "can't", "cannot", "could",
    "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down",
    "during", "each", "few", "for", "from", "further", "had", "hadn't", "has",
    "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her",
    "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's",
    "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it",
    "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my",
    "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or",
    "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "same",
    "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so",
    "some", "such", "than", "that", "that's", "the", "their", "theirs", "them",
    "themselves", "then", "there", "there's", "these", "they", "they'd", "they'll",
    "they're", "they've", "this", "those", "through", "to", "too", "under",
    "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're",
    "we've", "were", "weren't", "what", "what's", "when", "when's", "where",
    "where's", "which", "while", "who", "who's", "whom", "why", "why's", "with",
    "won't", "would", "wouldn't", "you", "you'd", "you'll", "you're", "you've",
    "your", "yours", "yourself", "yourselves", "tell", "show", "give", "please",
    "want", "need", "find", "get", "go", "going", "take", "help", "like", "just",
    "know", "today", "now", "hey", "hello", "hi", "howdy", "sup",
    "block", "blocks", "building", "buildings", "hall", "room", "rooms", "near", "nearest"
}


def get_embedding(text: str) -> np.ndarray:
    """Return a Gemini query embedding or fail; never mix embedding spaces."""
    if not text or not text.strip():
        raise ValueError("Cannot embed an empty query.")

    vector = np.asarray(gemini_client.embed_query(text.strip()), dtype=np.float32)
    if vector.ndim != 1 or vector.shape[0] != EXPECTED_DIM:
        raise RuntimeError(
            f"Gemini returned an embedding with shape {vector.shape}; expected ({EXPECTED_DIM},)."
        )
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm == 0:
        raise RuntimeError("Gemini returned an invalid zero or non-finite embedding.")
    return vector / norm


def build_searchable_text(record: Dict[str, Any], collection: str) -> str:
    """Builds deterministic searchable text using existing data.js fields only."""
    parts = []
    if record.get("name"):
        parts.append(f"Name: {record['name']}")
    if record.get("type"):
        parts.append(f"Type: {record['type']}")
    if record.get("category"):
        parts.append(f"Category: {record['category']}")
    if record.get("role"):
        parts.append(f"Role: {record['role']}")
    if record.get("department_or_subject"):
        parts.append(f"Department: {record['department_or_subject']}")
    if record.get("designation"):
        parts.append(f"Designation: {record['designation']}")
    if record.get("location_notation"):
        parts.append(f"Cabin / Notation: {record['location_notation']}")
    if record.get("floor"):
        parts.append(f"Floor: {record['floor']}")
    if record.get("desc"):
        parts.append(f"Description: {record['desc']}")
    if record.get("facilities"):
        facs = record["facilities"]
        fac_str = ", ".join(facs) if isinstance(facs, list) else str(facs)
        parts.append(f"Facilities: {fac_str}")
    if record.get("tags"):
        tags = record["tags"]
        tag_str = ", ".join(tags) if isinstance(tags, list) else str(tags)
        parts.append(f"Tags: {tag_str}")
    if record.get("hours"):
        parts.append(f"Hours: {record['hours']}")
    if record.get("blocks"):
        blks = record["blocks"]
        blk_str = ", ".join(blks) if isinstance(blks, list) else str(blks)
        parts.append(f"Blocks: {blk_str}")
    if record.get("parentBlockIds"):
        parents = record["parentBlockIds"]
        p_str = ", ".join(parents) if isinstance(parents, list) else str(parents)
        parts.append(f"Parent Blocks: {p_str}")
    if record.get("how"):
        parts.append(f"Connection: {record['how']}")

    return " | ".join(parts)


class CampusVectorStore:
    def __init__(self, data_loader: Optional[CampusDataLoader] = None):
        self.data_loader = data_loader or get_campus_data_loader()
        self.documents: List[Dict[str, Any]] = []
        self.embeddings: Optional[np.ndarray] = None
        self._normed: Optional[np.ndarray] = None
        self._initialize_store()

    def _extract_documents(self) -> List[Dict[str, Any]]:
        """Constructs document models directly from data_loader collections."""
        if not hasattr(self, "data_loader") or self.data_loader is None:
            self.data_loader = get_campus_data_loader()

        docs: List[Dict[str, Any]] = []

        # 1. Groups
        for g in self.data_loader.groups:
            doc_id = f"CAMPUS_GROUPS::{g.get('id', '')}"
            text = build_searchable_text(g, "CAMPUS_GROUPS")
            docs.append({
                "id": g.get("id", ""),
                "doc_id": doc_id,
                "source_collection": "CAMPUS_GROUPS",
                "source_id": g.get("id", ""),
                "name": g.get("name", ""),
                "category": g.get("category", "zone"),
                "type": g.get("type", "Group"),
                "text": text,
                "text_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "data": g,
            })

        # 2. Locations (Hostels, Academic Blocks, Healthcare, Sports, Parking)
        for loc in self.data_loader.locations:
            doc_id = f"CAMPUS_LOCATIONS::{loc.get('id', '')}"
            text = build_searchable_text(loc, "CAMPUS_LOCATIONS")
            docs.append({
                "id": loc.get("id", ""),
                "doc_id": doc_id,
                "source_collection": "CAMPUS_LOCATIONS",
                "source_id": loc.get("id", ""),
                "name": loc.get("name", ""),
                "category": loc.get("category", "location"),
                "type": loc.get("type", "Location"),
                "text": text,
                "text_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "data": loc,
            })

        # 3. Offices (Administrative Office, Tuck Shops, Student Centers)
        for off in self.data_loader.offices:
            doc_id = f"CAMPUS_OFFICES::{off.get('id', '')}"
            text = build_searchable_text(off, "CAMPUS_OFFICES")
            docs.append({
                "id": off.get("id", ""),
                "doc_id": doc_id,
                "source_collection": "CAMPUS_OFFICES",
                "source_id": off.get("id", ""),
                "name": off.get("name", ""),
                "category": off.get("category", "offices"),
                "type": off.get("type", "Office"),
                "text": text,
                "text_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "data": off,
            })

        # 4. Persons (Faculty, HODs, Leadership)
        for p in self.data_loader.persons:
            doc_id = f"CAMPUS_PERSONS::{p.get('id', '')}"
            text = build_searchable_text(p, "CAMPUS_PERSONS")
            docs.append({
                "id": p.get("id", ""),
                "doc_id": doc_id,
                "source_collection": "CAMPUS_PERSONS",
                "source_id": p.get("id", ""),
                "name": p.get("name", ""),
                "category": p.get("category", "personnel"),
                "type": p.get("type", "Person"),
                "text": text,
                "text_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "data": p,
            })

        # 5. Block Connections (Skywalks, Indoor Corridors)
        for conn in self.data_loader.connections:
            doc_id = f"CAMPUS_BLOCK_CONNECTIONS::{conn.get('id', '')}"
            text = build_searchable_text(conn, "CAMPUS_BLOCK_CONNECTIONS")
            docs.append({
                "doc_id": doc_id,
                "source_collection": "CAMPUS_BLOCK_CONNECTIONS",
                "source_id": conn.get("id", ""),
                "name": f"Connection {conn.get('id', '')}",
                "category": "connections",
                "type": "Block Connection",
                "text": text,
                "text_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "data": conn,
            })

        return docs

    def _initialize_store(self):
        """Load a compatible Gemini cache or rebuild it from Gemini embeddings."""
        current_docs = self._extract_documents()
        if not current_docs:
            raise RuntimeError("No campus records were loaded; refusing to build an empty vector index.")

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        cached_vectors_by_id: Dict[str, np.ndarray] = {}

        if VECTORS_PATH.exists() and META_PATH.exists():
            try:
                with open(META_PATH, "r", encoding="utf-8") as f:
                    cached_meta = json.load(f)
                loaded = np.load(str(VECTORS_PATH), allow_pickle=False)
                cached_docs = cached_meta.get("documents", [])
                cache_is_gemini = (
                    cached_meta.get("embedding_model") == EMBED_MODEL
                    and cached_meta.get("vector_dimension") == EXPECTED_DIM
                    and loaded.ndim == 2
                    and loaded.shape == (len(cached_docs), EXPECTED_DIM)
                )
                if cache_is_gemini:
                    current_by_id = {d["doc_id"]: d for d in current_docs}
                    for index, cached_doc in enumerate(cached_docs):
                        current_doc = current_by_id.get(cached_doc.get("doc_id"))
                        if current_doc and cached_doc.get("text_hash") == current_doc["text_hash"]:
                            cached_vectors_by_id[current_doc["doc_id"]] = loaded[index]
                    logger.info(
                        "[VectorStore] Reusing %d compatible Gemini vectors.",
                        len(cached_vectors_by_id),
                    )
                else:
                    logger.info("[VectorStore] Ignoring cache with a different model or dimension.")
            except Exception as e:
                logger.warning("[VectorStore] Ignoring unreadable or stale vector cache: %s", e)

        missing_docs = [d for d in current_docs if d["doc_id"] not in cached_vectors_by_id]
        if missing_docs:
            vectors = gemini_client.embed_texts([d["text"] for d in missing_docs])
            if len(vectors) != len(missing_docs):
                raise RuntimeError("Gemini returned an incomplete campus embedding batch.")
            for doc, raw_vector in zip(missing_docs, vectors):
                vector = np.asarray(raw_vector, dtype=np.float32)
                if vector.ndim != 1 or vector.shape[0] != EXPECTED_DIM:
                    raise RuntimeError(
                        f"Gemini returned an invalid vector for {doc['doc_id']} (shape {vector.shape})."
                    )
                norm = float(np.linalg.norm(vector))
                if not np.isfinite(norm) or norm == 0:
                    raise RuntimeError(f"Gemini returned an invalid vector for {doc['doc_id']}.")
                cached_vectors_by_id[doc["doc_id"]] = vector / norm

        self.documents = current_docs
        self.embeddings = np.stack([cached_vectors_by_id[d["doc_id"]] for d in current_docs]).astype(np.float32)
        self._update_normed_matrix()

        meta_to_save = {
            "embedding_model": EMBED_MODEL,
            "vector_dimension": EXPECTED_DIM,
            "version": "3.0",
            "count": len(self.documents),
            "documents": [
                {
                    "doc_id": d["doc_id"],
                    "source_collection": d["source_collection"],
                    "source_id": d["source_id"],
                    "name": d["name"],
                    "category": d["category"],
                    "text_hash": d["text_hash"],
                    "text": d["text"],
                    "data": d["data"],
                }
                for d in self.documents
            ],
        }

        tmp_vectors = VECTORS_PATH.with_name("campus_vectors.tmp.npy")
        tmp_meta = META_PATH.with_suffix(".tmp")
        try:
            np.save(str(tmp_vectors), self.embeddings, allow_pickle=False)
            with open(tmp_meta, "w", encoding="utf-8") as f:
                json.dump(meta_to_save, f, indent=2, ensure_ascii=False)
            os.replace(tmp_vectors, VECTORS_PATH)
            os.replace(tmp_meta, META_PATH)
            logger.info(
                "[VectorStore] Saved %d %s embeddings (%d dimensions).",
                len(self.documents), EMBED_MODEL, EXPECTED_DIM,
            )
        except Exception as e:
            for temp_path in (tmp_vectors, tmp_meta):
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise RuntimeError("Could not persist the Gemini campus vector index.") from e

    def _update_normed_matrix(self):
        if self.embeddings is not None and len(self.embeddings) > 0:
            norms = np.linalg.norm(self.embeddings, axis=1, keepdims=True)
            norms[norms == 0] = 1e-8
            self._normed = self.embeddings / norms
        else:
            self._normed = None

    def search(
        self,
        query: str,
        top_k: int = 5,
        threshold: float = WEAK_THRESHOLD,
    ) -> List[Tuple[Dict[str, Any], float]]:
        """
        Calculates cosine similarity between query and campus documents.
        Returns matched documents with score >= threshold.
        """
        if self._normed is None or len(self.documents) == 0:
            return []

        q_vec = get_embedding(query)
        if q_vec is None:
            return []

        # If query embedding dimension matches matrix
        if len(q_vec) != self._normed.shape[1]:
            logger.warning(f"[VectorStore] Query dim ({len(q_vec)}) != index dim ({self._normed.shape[1]}).")
            return []

        scores = self._normed @ q_vec

        # Subword and fuzzy token boost for typos / exact concept terms
        is_conn_query = bool(re.search(r"\b(connect(?:ed|ion|ions)?|corridor|bridge|walkway|skywalk|passage|pathway)\b", query.lower()))
        q_tokens = [w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) > 2 and w not in _STOPWORDS]
        if q_tokens:
            for idx, doc in enumerate(self.documents):
                # Never artificially boost connection documents unless the user specifically asked for connections/walkways
                if doc.get("source_collection") == "CAMPUS_BLOCK_CONNECTIONS" and not is_conn_query:
                    continue
                doc_text = doc["text"].lower()
                matched_score = 0.0
                for tok in q_tokens:
                    if tok in doc_text:
                        matched_score += 1.0
                    elif len(tok) >= 4:
                        grams = [tok[i:i+3] for i in range(len(tok)-2)]
                        if grams and sum(1 for g in grams if g in doc_text) / len(grams) >= 0.5:
                            matched_score += 0.8
                ratio = matched_score / len(q_tokens)
                if ratio >= 0.8 and (scores[idx] >= 0.20 or matched_score >= 1.5 or len(q_tokens[0]) >= 5):
                    scores[idx] = max(scores[idx], 0.65 + 0.25 * ratio)
                elif ratio >= 0.5 and (scores[idx] >= 0.20 or matched_score >= 1.0):
                    scores[idx] = max(scores[idx], 0.50 + 0.15 * ratio)

        top_indices = np.argsort(scores)[::-1][:top_k]

        results = []
        for idx in top_indices:
            score = float(scores[idx])
            if score >= threshold:
                results.append((self.documents[idx], score))

        return results


_vector_store_instance: Optional[CampusVectorStore] = None


def get_campus_vector_store() -> CampusVectorStore:
    """Returns singleton CampusVectorStore instance."""
    global _vector_store_instance
    if _vector_store_instance is None:
        _vector_store_instance = CampusVectorStore()
    return _vector_store_instance
