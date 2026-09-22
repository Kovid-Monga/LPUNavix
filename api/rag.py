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
from pydantic import BaseModel, Field

from api.data_loader import Record, load_records
import api.gemini_client as gemini_client
from api.gemini_client import EMBEDDING_MODEL
from api.retrieval import Retriever, classify_match, find_structured_matches

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


def generate_reply(
    question: str,
    context_records: list[dict],
    match_quality: str,
    history: list[dict] | None = None,
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


def has_explicit_target(question: str, records: list[Record]) -> bool:
    """Detect if the query explicitly names a specific location, block, person, UID, or department."""
    clean_q = re.sub(r"[^\w\s\-\/]", " ", question.lower()).strip()

    # 1. Structured match in records (UID, notation, person name, HOD dept, block+room, role)
    if find_structured_matches(question, records):
        return True

    # 2. Explicit block mention (e.g. "block 34", "block 28", "b-34", "b34")
    if re.search(r"\b(?:block|b)[\s-]*\d{1,2}\b", clean_q, re.I):
        return True

    # 3. Known campus landmark keywords
    known_landmarks = [
        "library", "central library", "unimall", "uni mall", "health center",
        "hospital", "dispensary", "food court", "main gate", "gate 1", "gate 2",
        "gate 3", "gate 4", "bh-1", "bh-2", "bh-3", "bh-4", "bh-5", "gh-1",
        "gh-2", "gh-3", "gh-4", "gh-5", "swimming pool", "stadium", "auditorium",
        "shanti devi mittal", "baldev raj mittal"
    ]
    for kw in known_landmarks:
        if re.search(r"\b" + re.escape(kw) + r"\b", clean_q, re.I):
            return True

    return False


def is_followup_query(question: str) -> bool:
    """Detect if a user query is an anaphoric or elliptical follow-up."""
    clean_q = re.sub(r"[^\w\s\-\/]", " ", question.lower()).strip()
    words = clean_q.split()

    # Anaphoric pronouns
    pronouns = {"it", "its", "there", "his", "her", "their", "that", "this"}
    if any(w in pronouns for w in words):
        return True

    # Common elliptical / follow-up phrases lacking an explicit target subject
    followup_patterns = [
        r"\b(?:opening|closing)?\s*(?:hours|timings|time)\b",
        r"\b(?:when|is it)\s*(?:open|closed)\b",
        r"\b(?:show|view|take me|locate)\s*(?:it\s*)?(?:on\s*(?:the\s*)?map)?\b",
        r"\b(?:directions|route|path|how to reach|how to go|how do i get there)\b",
        r"\b(?:what\s*)?(?:facilities|amenities|services)\b",
        r"\bwho\s*(?:sits|works|is)\s*(?:there|inside|in there)\b",
        r"\b(?:contact|phone|phone number|call)\b",
        r"\b(?:which|what)\s*(?:floor|room|cabin)\b",
        r"\b(?:tell me more|more details|more info)\b",
    ]
    for pattern in followup_patterns:
        if re.search(pattern, clean_q, re.I):
            return True

    if len(words) <= 4 and any(w in words for w in ["hours", "timings", "map", "directions", "reach", "floor", "cabin", "room"]):
        return True

    return False


def find_last_entity_record(
    last_entity: Optional[EntityContext],
    history: Optional[List[ChatMessage]],
    records: list[Record],
) -> Optional[Record]:
    """Find the verified Record corresponding to the last confirmed entity or previous conversation topic."""
    if last_entity:
        if last_entity.id:
            for r in records:
                if r.id == last_entity.id:
                    return r
        if last_entity.name:
            target_name = last_entity.name.lower().strip()
            for r in records:
                if r.name and r.name.lower().strip() == target_name:
                    return r
            for r in records:
                if r.name and target_name in r.name.lower():
                    return r

    # If no explicit last_entity, scan history from newest to oldest
    if history:
        for msg in reversed(history):
            content = msg.content
            matches = find_structured_matches(content, records)
            if matches:
                return matches[0]
            b_m = re.search(r"\b(?:block|b)[\s-]*(\d{1,2})\b", content, re.I)
            if b_m:
                b_num = b_m.group(1)
                for r in records:
                    if r.block == b_num and not r.uid:
                        return r
                    if r.block == b_num:
                        return r
            for r in records:
                if r.name and len(r.name) > 3 and r.name.lower() in content.lower():
                    return r

    return None


def resolve_contextual_query(
    question: str,
    history: Optional[List[ChatMessage]],
    last_entity: Optional[EntityContext],
    records: list[Record],
) -> tuple[str, Optional[Record]]:
    """Resolve query taking conversational context into account.
    
    Returns:
        (resolved_search_query, priority_record)
    """
    # Requirement 4: Explicit location/person in current message takes strict priority over previous context
    if has_explicit_target(question, records):
        return question, None

    # Requirement 2 & 3: Resolve follow-up query if a reliable earlier entity exists
    if is_followup_query(question):
        prev_record = find_last_entity_record(last_entity, history, records)
        if prev_record:
            entity_name = prev_record.name
            q_clean = question.lower().strip()

            if any(w in q_clean for w in ["hour", "timing", "open", "close"]):
                resolved = f"What are the opening hours and timings of {entity_name}?"
            elif any(w in q_clean for w in ["map", "where", "locate", "direction", "reach", "route", "take me"]):
                resolved = f"Where is {entity_name} on campus map and directions?"
            elif any(w in q_clean for w in ["cabin", "office", "sit", "room", "floor"]):
                resolved = f"Where is the cabin, room, and floor for {entity_name}?"
            elif any(w in q_clean for w in ["facility", "facilities", "amenity", "amenities", "inside"]):
                resolved = f"What facilities and services are inside {entity_name}?"
            elif any(w in q_clean for w in ["contact", "phone", "call"]):
                resolved = f"What is the contact information for {entity_name}?"
            else:
                resolved = f"{question} for {entity_name}"

            return resolved, prev_record

    # Requirement 3: Standalone incomplete query without earlier topic -> do not guess, return as-is
    return question, None


def generate_interactive_chips(
    question: str,
    top_record: Optional[Record] = None,
    tier: str = "none",
    is_negative_reply: bool = False,
) -> list[str]:
    """Generate dynamic, context-relevant interactive action and question chips."""
    return []


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
            reply = "Hey there! 👋 I'm your LPUNavix Campus Guide ✨ How can I help you find faculty cabins, campus blocks, food spots, or departments today? 🏢📍"
        return ChatResponse(reply=reply, locationId=None, title=None, chips=[])

    retriever: Optional[Retriever] = _state.get("retriever")
    if retriever is None:
        raise HTTPException(status_code=503, detail="Assistant is still starting up, try again shortly.")

    # Contextual query resolution
    search_query, priority_record = resolve_contextual_query(
        raw_question,
        req.history,
        req.last_entity,
        retriever.records,
    )

    query_embedding = embed_query(search_query)
    ranked = retriever.rank(query_embedding, query_text=search_query)

    if priority_record:
        # Prioritize the contextual target entity at the top
        ranked = [(priority_record, 1.0)] + [pair for pair in ranked if pair[0].id != priority_record.id]

    if not ranked:
        reply = (
            f"Hmm, I don't have any campus data loaded to answer that yet! 🤔 "
            f"Once it's set up I can help with {CAN_HELP_WITH}. 🏢📍"
        )
        return ChatResponse(reply=reply, locationId=None, title=None, chips=[])

    top_record, top_score = ranked[0]
    tier = classify_match(top_score)

    context_records = [r.context | {"id": r.id, "name": r.name} for r, _ in ranked if classify_match(_) != "none"]

    try:
        reply = generate_reply(search_query, context_records, match_quality=tier, history=history_payload)
    except Exception:
        try:
            from api.gemini_client import _format_grounded_fallback
            reply = _format_grounded_fallback(search_query, context_records, match_quality=tier)
        except Exception:
            reply = f"I couldn't reach the campus records right now, but I can help you find campus blocks, faculty offices, and departments! 📡🏢"

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

    chips = generate_interactive_chips(raw_question, top_record, tier, is_negative_reply)

    # Never surface a map location if the match is weak/none or the model replied that no info is available
    if tier != "confident" or is_negative_reply:
        return ChatResponse(reply=reply, locationId=None, title=None, chips=chips)

    return ChatResponse(reply=reply, locationId=top_record.id, title=top_record.name, chips=chips)
