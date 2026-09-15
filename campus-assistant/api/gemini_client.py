"""
Thin wrapper around the Gemini API (google-genai SDK) for:
  - batch text embeddings (data indexing + query embedding)
  - grounded generation (chat replies constrained to retrieved context)

Requires GEMINI_API_KEY in the environment (see .env.example).
Never hardcode a key here.
"""

import os

from google import genai
from google.genai import types

EMBEDDING_MODEL = "gemini-embedding-001"
GENERATION_MODEL = "gemini-3.6-flash"

_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key, "
                "or export GEMINI_API_KEY before starting the server."
            )
        _client = genai.Client(api_key=api_key)
    return _client


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts (used once at startup for all records)."""
    if not texts:
        return []
    client = get_client()
    response = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=texts,
    )
    return [e.values for e in response.embeddings]


def embed_query(text: str) -> list[float]:
    """Embed a single incoming user question."""
    return embed_texts([text])[0]


SYSTEM_INSTRUCTION = """You are the campus assistant for LPU (Lovely Professional University).

Rules you must always follow:
- Answer using ONLY the information given to you in the "Context" section below. Do not use outside knowledge about LPU or any university.
- Never invent facilities, hours, room numbers, phone numbers, or locations that are not explicitly present in the context.
- If the context is empty or clearly irrelevant to the question, say plainly that you don't have that information, and briefly mention what you *can* help with (buildings, hostels, food, offices, departments). Do not apologize excessively or dead-end the conversation.
- If the best-matching context item is only a loose/uncertain match for the question, say so explicitly and offer it as a possibility ("I don't have an exact match, but did you mean ...?") rather than stating it as fact.
- Be direct and brief: lead with the answer, no preambles like "Great question!". One to two sentences is usually enough for a simple lookup. Don't dump every field unless the question asks for detail.
- Match the reply's content to what was actually asked. A "where is X" or "what is X" question wants ONE short sentence naming/locating X — nothing about hours, facilities, or contact info unless the question asks about those specifically. Only mention hours if asked "when is X open"; only mention facilities if asked "what's in X" or "what can I do at X". Example: for "where is block 25", a good reply is "Block 25 is an academic block for the CSE department." — NOT a reply that also lists its facilities and operating hours.
- Do not mention maps, buttons, or directions in your reply text — a separate UI element handles "show me on the map".
- Be warm and conversational, not robotic or list-heavy, unless the question specifically asks for a list.
"""


def generate_reply(question: str, context_records: list[dict], match_quality: str) -> str:
    """Call Gemini to produce the final chat reply.

    match_quality: "confident" | "weak" | "none" — tells the model how
    to hedge its answer (see SYSTEM_INSTRUCTION for the exact rules).
    """
    client = get_client()

    if not context_records:
        context_block = "(no relevant records were retrieved for this question)"
    else:
        lines = []
        for r in context_records:
            fields = ", ".join(f"{k}: {v}" for k, v in r.items() if v)
            lines.append(f"- {fields}")
        context_block = "\n".join(lines)

    prompt = (
        f"Match quality for this retrieval: {match_quality}\n\n"
        f"Context:\n{context_block}\n\n"
        f"User question: {question}"
    )

    response = client.models.generate_content(
        model=GENERATION_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            # Gemini 3.x models think before answering by default (medium/high
            # effort), which adds several seconds of latency before output
            # even starts. "low" is what Google explicitly recommends for
            # latency-sensitive real-time chat like this — this dataset's
            # lookups don't need deep reasoning.
            thinking_config=types.ThinkingConfig(thinking_level="low"),
            # NOTE: temperature/top_p/top_k are silently ignored by
            # gemini-3.6-flash (per Google's 3.x migration notes), so they're
            # deliberately omitted here rather than left in as dead config.
        ),
    )
    return response.text.strip()