"""
Campus Assistant backend.

Startup: parse js/data.js -> normalize records -> embed every record
with Gemini -> keep everything in memory.

Request:  POST /api/chat  {"message": "..."}
Response: {"reply": "...", "locationId": "..."|null, "title": "..."|null}

IMPORTANT: all API routes must be registered BEFORE the
`app.mount("/", StaticFiles(...))` line at the bottom of this file.
Routes added after that mount get silently swallowed by the static
file handler and will 404 — this bit the project before, hence this
comment.
"""

import hashlib
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # pulls GEMINI_API_KEY from a local .env file, if present

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from api.data_loader import Record, load_records
from api.gemini_client import EMBEDDING_MODEL, embed_query, embed_texts, generate_reply
from api.retrieval import Retriever, classify_match

DATA_JS_PATH = Path(__file__).resolve().parent.parent / "js" / "data.js"
CACHE_PATH = Path(__file__).resolve().parent / "embeddings_cache.json"

# Populated in the lifespan startup hook below.
_state: dict = {"retriever": None}


def _compute_hash(records: list[Record], model: str) -> str:
    h = hashlib.sha256(model.encode("utf-8"))
    for r in records:
        h.update(f"{r.id}:{r.blob}\n".encode("utf-8"))
    return h.hexdigest()


def get_or_create_embeddings(records: list[Record], cache_path: Path) -> list[list[float]]:
    # When running tests or if cache is explicitly disabled, bypass cache
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    records = load_records(DATA_JS_PATH)
    embeddings = get_or_create_embeddings(records, CACHE_PATH)
    _state["retriever"] = Retriever(records, embeddings)
    print(f"[startup] Indexed {len(records)} campus records for retrieval.")
    yield
    _state.clear()


app = FastAPI(title="Campus Assistant API", lifespan=lifespan)


class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    reply: str
    locationId: str | None = None
    title: str | None = None


CAN_HELP_WITH = "buildings, hostels, food, offices, and departments on campus"


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    question = req.message.strip()
    if not question:
        raise HTTPException(status_code=400, detail="message must not be empty")

    retriever: Retriever | None = _state.get("retriever")
    if retriever is None:
        raise HTTPException(status_code=503, detail="Assistant is still starting up, try again shortly.")

    query_embedding = embed_query(question)
    ranked = retriever.rank(query_embedding, query_text=question)

    if not ranked:
        reply = (
            f"I don't have any campus data loaded to answer that yet. "
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

    if tier == "none":
        return ChatResponse(reply=reply, locationId=None, title=None)

    # "confident" and "weak" both surface a map button — for "weak" the
    # reply text itself asks the user to confirm before they'd tap it.
    return ChatResponse(reply=reply, locationId=top_record.id, title=top_record.name)


# --- Static frontend last, per the mount-order gotcha noted above. ---
PROJECT_ROOT = Path(__file__).resolve().parent.parent
app.mount("/js", StaticFiles(directory=str(PROJECT_ROOT / "js")), name="js")
app.mount("/css", StaticFiles(directory=str(PROJECT_ROOT / "css")), name="css")
app.mount("/", StaticFiles(directory=str(PROJECT_ROOT / "static"), html=True), name="static")
