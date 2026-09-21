"""
rag.py — Campus Assistant RAG Pipeline & Chat API Router
========================================================
Encapsulates campus record embedding generation, caching, vector retrieval,
context building, and Gemini response generation.
"""

import hashlib
import json
import os
import re
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.data_loader import Record, load_records
import api.gemini_client as gemini_client
from api.gemini_client import EMBEDDING_MODEL
from api.retrieval import Retriever, classify_match

DATA_JS_PATH = Path(__file__).resolve().parent.parent / "js" / "data.js"
CACHE_PATH = Path(__file__).resolve().parent / "embeddings_cache.json"

_state: dict = {"retriever": None}


def embed_texts(texts: list[str]) -> list[list[float]]:
    try:
        import api.main as m
        if hasattr(m, "embed_texts") and m.embed_texts is not embed_texts:
            return m.embed_texts(texts)
    except ImportError:
        pass
    return gemini_client.embed_texts(texts)


def embed_query(text: str) -> list[float]:
    try:
        import api.main as m
        if hasattr(m, "embed_query") and m.embed_query is not embed_query:
            return m.embed_query(text)
    except ImportError:
        pass
    return gemini_client.embed_query(text)


def generate_reply(question: str, context_records: list[dict], match_quality: str) -> str:
    try:
        import api.main as m
        if hasattr(m, "generate_reply") and m.generate_reply is not generate_reply:
            return m.generate_reply(question, context_records, match_quality)
    except ImportError:
        pass
    return gemini_client.generate_reply(question, context_records, match_quality)


def _compute_hash(records: list[Record], model: str) -> str:
    h = hashlib.sha256(model.encode("utf-8"))
    for r in records:
        h.update(f"{r.id}:{r.blob}\n".encode("utf-8"))
    return h.hexdigest()


def get_or_create_embeddings(records: list[Record], cache_path: Path = CACHE_PATH) -> list[list[float]]:
    if os.environ.get("PYTEST_CURRENT_TEST") or os.environ.get("DISABLE_EMBEDDING_CACHE"):
        return embed_texts([r.blob for r in records])

    data_hash = _compute_hash(records, EMBEDDING_MODEL)

    if cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("hash") == data_hash and cached.get("model") == EMBEDDING_MODEL:
                embs = cached.get("embeddings", [])
                if len(embs) == len(records):
                    print(f"[cache] Loaded {len(embs)} embeddings from cache ({cache_path.name}).")
                    return embs
        except Exception as e:
            print(f"[cache] Warning: failed reading cache ({e}), regenerating...")

    print(f"[cache] Generating embeddings for {len(records)} records via Gemini API...")
    embeddings = embed_texts([r.blob for r in records])

    try:
        cache_data = {
            "hash": data_hash,
            "model": EMBEDDING_MODEL,
            "count": len(records),
            "embeddings": embeddings,
        }
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(cache_data, f)
        print(f"[cache] Saved embeddings cache to {cache_path.name}.")
    except Exception as e:
        print(f"[cache] Warning: failed writing cache ({e}).")

    return embeddings


def init_rag(data_js_path: Path = DATA_JS_PATH, cache_path: Path = CACHE_PATH):
    records = load_records(data_js_path)
    embeddings = get_or_create_embeddings(records, cache_path)
    _state["retriever"] = Retriever(records, embeddings)
    print(f"[startup] Indexed {len(records)} campus records for retrieval.")


def shutdown_rag():
    _state.clear()


class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    reply: str
    locationId: Optional[str] = None
    title: Optional[str] = None


CAN_HELP_WITH = "buildings, hostels, food, offices, and departments on campus"

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
    question = req.message.strip()
    if not question:
        raise HTTPException(status_code=400, detail="message must not be empty")

    # Greetings and general pleasantries do not ask for a map location
    if is_greeting_or_chitchat(question):
        try:
            reply = generate_reply(question, [], match_quality="none")
        except Exception:
            reply = "Hello! 😊 I'm your LPUNavix Campus Assistant. How can I help you find buildings, faculty cabins, or departments today?"
        return ChatResponse(reply=reply, locationId=None, title=None)

    retriever: Optional[Retriever] = _state.get("retriever")
    if retriever is None:
        raise HTTPException(status_code=503, detail="Assistant is still starting up, try again shortly.")

    query_embedding = embed_query(question)
    ranked = retriever.rank(query_embedding, query_text=question)

    if not ranked:
        reply = (
            f"Hmm, I don't have any campus data loaded to answer that yet. "
            f"Once it's set up I can help with {CAN_HELP_WITH}."
        )
        return ChatResponse(reply=reply, locationId=None, title=None)

    top_record, top_score = ranked[0]
    tier = classify_match(top_score)

    context_records = [r.context | {"id": r.id, "name": r.name} for r, _ in ranked if classify_match(_) != "none"]

    try:
        reply = generate_reply(question, context_records, match_quality=tier)
    except Exception:
        try:
            from api.gemini_client import _format_grounded_fallback
            reply = _format_grounded_fallback(question, context_records, match_quality=tier)
        except Exception:
            reply = f"I couldn't reach the assistant service right now, but I can help you find campus blocks, faculty offices, and departments."

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
