"""
api/rag.py — Campus Assistant RAG Pipeline & Chat API Router
============================================================
Encapsulates campus record embedding generation, caching, vector retrieval,
context building, and Gemini response generation.
"""

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from dotenv import load_dotenv
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.exists():
        load_dotenv(dotenv_path=env_file)
    else:
        load_dotenv()
except ImportError:
    pass

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api.data_loader import Record, load_records
import api.gemini_client as gemini_client
from api.gemini_client import EMBEDDING_MODEL
from api.retrieval import (
    CONFIDENT_THRESHOLD,
    WEAK_THRESHOLD,
    Retriever,
    classify_match,
    find_last_entity_record,
    find_structured_matches,
    has_explicit_target,
    is_followup_query,
    resolve_contextual_query,
)

DATA_JS_PATH = Path(__file__).resolve().parent.parent / "js" / "data.js"
CACHE_PATH = Path(__file__).resolve().parent / "embeddings_cache.json"

_state: dict = {"retriever": None}


def embed_texts(texts: List[str]) -> List[List[float]]:
    try:
        import api.main as m
        if hasattr(m, "embed_texts") and m.embed_texts is not embed_texts:
            return m.embed_texts(texts)
    except ImportError:
        pass
    return gemini_client.embed_texts(texts)


def embed_query(text: str) -> List[float]:
    try:
        import api.main as m
        if hasattr(m, "embed_query") and m.embed_query is not embed_query:
            return m.embed_query(text)
    except ImportError:
        pass
    return gemini_client.embed_query(text)


def generate_reply(
    question: str,
    context_records: List[Dict[str, Any]],
    match_quality: str,
    history: Optional[List[Dict[str, Any]]] = None,
) -> str:
    try:
        import api.main as m
        if hasattr(m, "generate_reply") and m.generate_reply is not generate_reply:
            try:
                return m.generate_reply(question, context_records, match_quality, history=history)
            except TypeError:
                return m.generate_reply(question, context_records, match_quality)
    except ImportError:
        pass
    try:
        return gemini_client.generate_reply(question, context_records, match_quality, history=history)
    except TypeError:
        return gemini_client.generate_reply(question, context_records, match_quality)


def _compute_hash(records: List[Record], model: str) -> str:
    h = hashlib.sha256(model.encode("utf-8"))
    for r in records:
        h.update(f"{r.id}:{r.blob}\n".encode("utf-8"))
    return h.hexdigest()


_DEFAULT_EMBED_TEXTS = embed_texts


def get_or_create_embeddings(records: List[Record], cache_path: Path = CACHE_PATH) -> List[List[float]]:
    try:
        import api.main as m
        if hasattr(m, "embed_texts") and m.embed_texts is not embed_texts and m.embed_texts is not gemini_client.embed_texts:
            return m.embed_texts([r.blob for r in records])
    except ImportError:
        pass

    if embed_texts is not _DEFAULT_EMBED_TEXTS or os.environ.get("DISABLE_EMBEDDING_CACHE"):
        return embed_texts([r.blob for r in records])

    data_hash = _compute_hash(records, EMBEDDING_MODEL)

    if cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("hash") == data_hash and cached.get("model") == EMBEDDING_MODEL:
                embs = cached.get("embeddings", [])
                if (
                    len(embs) == len(records)
                    and all(len(vector) == gemini_client.EMBEDDING_DIMENSION for vector in embs)
                ):
                    return embs
        except Exception:
            pass

    embeddings = embed_texts([r.blob for r in records])
    if len(embeddings) != len(records) or any(
        len(vector) != gemini_client.EMBEDDING_DIMENSION for vector in embeddings
    ):
        raise RuntimeError("Gemini returned an invalid campus embedding cache.")
    cache_data = {
        "hash": data_hash,
        "model": EMBEDDING_MODEL,
        "count": len(records),
        "embeddings": embeddings,
    }
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache_data, f)

    return embeddings


def init_rag(data_js_path: Path = DATA_JS_PATH, cache_path: Path = CACHE_PATH):
    records = load_records(data_js_path)
    embeddings = get_or_create_embeddings(records, cache_path)
    _state["retriever"] = Retriever(records, embeddings)


def shutdown_rag():
    _state.clear()


def get_retriever() -> Optional[Retriever]:
    return _state.get("retriever")


class ChatMessage(BaseModel):
    role: str
    content: str


class EntityContext(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None


class ChatRequest(BaseModel):
    message: str
    history: Optional[List[ChatMessage]] = None
    last_entity: Optional[EntityContext] = Field(default=None, alias="lastEntity")

    model_config = {"populate_by_name": True}


class ChatResponse(BaseModel):
    reply: str
    locationId: Optional[str] = None
    title: Optional[str] = None
    chips: Optional[List[str]] = None


CAN_HELP_WITH = "buildings, auditoriums, hostels, food, offices, placement cell (TPC), and departments on campus"

GREETING_WORDS = {
    "hi", "hello", "hey", "heyy", "heyyy", "howdy", "greetings", "yo", "sup",
    "goodmorning", "goodafternoon", "goodevening", "bye", "goodbye",
    "thanks", "thankyou"
}


def is_greeting_or_chitchat(text: str) -> bool:
    cleaned = re.sub(r"[^\w\s]", "", text.strip().lower())
    words = cleaned.split()
    if not words:
        return False
    if len(words) == 1 and words[0] in GREETING_WORDS:
        return True
    if len(words) <= 3:
        if words[0] in GREETING_WORDS:
            return True
        if words in [["good", "morning"], ["good", "afternoon"], ["good", "evening"], ["good", "day"]]:
            return True
        if words in [["how", "are", "you"], ["what", "is", "up"], ["whats", "up"], ["who", "are", "you"]]:
            return True
        if words in [["thank", "you"], ["thanks", "a", "lot"]]:
            return True
    return False


router = APIRouter()


@router.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    raw_question = req.message.strip()
    if not raw_question:
        raise HTTPException(status_code=400, detail="message must not be empty")

    history_payload = [m.model_dump() for m in (req.history or [])]

    # Greetings and general pleasantries do not ask for a map location
    if is_greeting_or_chitchat(raw_question):
        try:
            reply = generate_reply(raw_question, [], match_quality="none", history=history_payload)
        except Exception:
            reply = "Hello! 😊 I'm your LPUNavix Campus Assistant ✨ How can I help you find buildings, placement cell (TPC), faculty cabins, or departments today? 🏢📍"
        return ChatResponse(reply=reply, locationId=None, title=None)

    retriever: Optional[Retriever] = _state.get("retriever")
    if retriever is None:
        init_rag()
        retriever = _state.get("retriever")
    if retriever is None:
        raise HTTPException(status_code=503, detail="Assistant is still starting up, try again shortly.")

    # Contextual query resolution
    search_query, priority_record = resolve_contextual_query(
        raw_question,
        req.history,
        req.last_entity,
        retriever.records,
    )

    try:
        query_embedding = embed_query(search_query)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Gemini embeddings are unavailable.") from exc
    ranked = retriever.rank(query_embedding, query_text=search_query)

    if priority_record:
        # Prioritize the contextual target entity at the top
        ranked = [(priority_record, 1.0)] + [pair for pair in ranked if pair[0].id != priority_record.id]

    if not ranked:
        try:
            reply = generate_reply(
                search_query,
                [],
                match_quality="none",
                history=history_payload,
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Gemini could not generate a reply.") from exc
        return ChatResponse(reply=reply, locationId=None, title=None)

    top_record, top_score = ranked[0]
    tier = classify_match(top_score)

    context_records = [r.context | {"id": r.id, "name": r.name} for r, _ in ranked if classify_match(_) != "none"]

    try:
        reply = generate_reply(search_query, context_records, match_quality=tier, history=history_payload)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Gemini could not generate a reply.") from exc

    # Check if the generated reply explicitly states no information is available
    fallback_negative_phrases = (
        "i don't have",
        "i do not have",
        "no information",
        "no relevant records",
        "cannot find",
        "could not find",
        "couldn't find",
        "can't find",
        "not in my records",
        "not present in my records",
        "don't have any campus data",
        "do not have any campus data",
        "no records available",
        "no matching",
    )
    is_negative_reply = any(phrase in reply.lower() for phrase in fallback_negative_phrases)

    # Never surface a map location if the match is weak/none or the model replied that no info is available
    if tier != "confident" or is_negative_reply:
        return ChatResponse(reply=reply, locationId=None, title=None)

    return ChatResponse(reply=reply, locationId=top_record.id, title=top_record.name)
