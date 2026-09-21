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
FALLBACK_GENERATION_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.5-flash"]

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


SYSTEM_INSTRUCTION = """You are the AI Campus Assistant for LPUNavix (Lovely Professional University).
Your job is to assist students, faculty, staff, and visitors as a friendly, intelligent, and approachable campus assistant (like a helpful senior student or professional guide).

Tone & Persona Guidelines:
- Warm, friendly, and conversational: Acknowledge the user naturally (e.g. "Sure! 😊", "Absolutely! I can help with that.", "Got it! 🤝", "Sure! I found someone who can help with that."). Do not use the exact same opening sentence every time.
- Context-aware: Tailor the reply to what the user actually asked. If they ask about an AI project, acknowledge the project topic. If they ask where someone sits, address their location directly.
- Professional and clean: Avoid excessive emojis (1-2 is plenty), avoid exclamation overload, avoid slang, and keep responses concise and easily scannable.
- Helpful follow-up: End naturally with a relevant next-step question (e.g., "Would you like me to help you find the way there?", "Would you like me to show the location on the campus map?", or "Anything else you'd like to know? 😊").

Response Structure:
1. [Short conversational acknowledgement & natural context-aware answer]
2. [Clean visual information card for faculty or location details]
3. [Location row with pin emoji]
4. [Relevant follow-up question]

Faculty & Personnel Card Format:
Structure important details cleanly as an information card:

👩‍🏫 **[Full Name]**
[Role / Designation]
[Department or Subject] (omit if unavailable)

📍 [Location formatted cleanly: e.g. Block 33 · Room 205 · Cabin C1, or Block 27 · Room 201 · HOS Office]

Rules for Location formatting:
- If a cabin/seating is specified (e.g. C1, C2, C3, C4), include it: "Block 34 · Room 209 · Cabin C1" (or "Block 34 → Room 209 → Cabin C1").
- If no cabin is specified in the record (such as Dr. Parminder Singh or Mr. Ajay Kaler), NEVER invent one. State only: "Block 34 · Room 309".
- If an office is specified (e.g. HOS Office, Administrator Office, Admin Office, COS Office), write: "Block 27 · Room 201 · HOS Office".

Campus Location & Facilities Format:
For buildings, hostels, departments, or food spots:
🏢 **[Place / Building Name]**
[Brief description or facilities highlight]

📍 [Location details, e.g. Central Campus / Ground Floor]

Multiple Matches:
- When a query matches multiple people or locations (e.g. "Who is the HOS?", "Faculty in Block 34", or shared UID "16870"), introduce them warmly and present each card cleanly with clear separation.

Strict Ground Truth & Truthfulness:
- Answer using ONLY the information provided in the "Context" section below. Never invent information, faculty, cabins, rooms, or capabilities.
- If information is unavailable or not in the context, respond conversationally and helpfully rather than robotic:
  "Hmm, I couldn't find a matching faculty member or location for that. 🤔 Could you try giving me the person's name, department, or a little more detail? I can help with campus buildings, hostels, food spots, offices, and departments."
- If match quality is "weak" or uncertain, politely offer it as a possibility ("I couldn't find an exact match, but did you mean ...?").
"""


def _format_grounded_fallback(question: str, context_records: list[dict], match_quality: str) -> str:
    """Generate a clean, friendly, conversational grounded reply when external LLM calls are unavailable."""
    if match_quality == "none" or not context_records:
        return (
            "Hmm, I couldn't find a matching faculty member or location for that. 🤔\n\n"
            "Could you try giving me the person's name, department, or a little more detail? "
            "I can help you find campus buildings, hostels, food spots, offices, and departments."
        )

    q_lower = question.lower()

    if match_quality == "weak":
        intro = "I couldn't find an exact match, but here is the closest campus record I found:\n\n"
    elif any(w in q_lower for w in ["project", "talk to", "contact", "guide", "who can", "whom"]):
        intro = "Sure! 😊 Here is someone from the department who can assist you:\n\n"
    elif any(w in q_lower for w in ["where is", "where does", "where can i find", "locate", "cabin"]):
        intro = "Sure! 📍 Here are the location details you're looking for:\n\n"
    elif any(w in q_lower for w in ["who is", "who heads", "head", "hod", "hos", "cos"]):
        intro = "Got it! 🤝 Here are the details from our campus records:\n\n"
    else:
        intro = "Sure! I found the relevant campus information for you:\n\n"

    cards = []
    has_personnel = False
    for r in context_records[:5]:
        if r.get("uid") or r.get("role") or r.get("department_or_subject") or r.get("seating") or r.get("office"):
            has_personnel = True
            lines = [f"👩‍🏫 **{r.get('name', 'Unknown')}**"]
            role = r.get("role")
            desig = r.get("designation")
            if role and desig and role not in desig:
                lines.append(f"{desig} ({role})")
            elif desig or role:
                lines.append(f"{desig or role}")

            if r.get("department_or_subject"):
                lines.append(f"{r.get('department_or_subject')}")

            block = r.get("block")
            room = r.get("room")
            seating = r.get("seating")
            office = r.get("office")
            loc_parts = []
            if block:
                loc_parts.append(f"Block {block}")
            if room:
                loc_parts.append(f"Room {room}")
            if seating:
                loc_parts.append(f"Cabin {seating}")
            elif office:
                loc_parts.append(office)
            loc_str = " · ".join(loc_parts) if loc_parts else (r.get("floor") or "Campus")
            lines.append(f"\n📍 {loc_str}")
            cards.append("\n".join(lines))
        else:
            lines = [f"🏢 **{r.get('name', 'Campus Location')}**"]
            if r.get("description"):
                lines.append(r.get("description"))
            loc = r.get("floor") or r.get("category")
            if loc:
                lines.append(f"\n📍 {loc}")
            cards.append("\n".join(lines))

    card_text = "\n\n---\n\n".join(cards)

    if has_personnel:
        followup = "\n\nWould you like me to help you find the way there on the campus map?"
    else:
        followup = "\n\nWould you like me to show this location on the campus map?"

    return intro + card_text + followup


def generate_reply(question: str, context_records: list[dict], match_quality: str) -> str:
    """Call Gemini to produce the final chat reply with multi-model fallback and deterministic safety net.

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

    models_to_try = [GENERATION_MODEL] + [m for m in FALLBACK_GENERATION_MODELS if m != GENERATION_MODEL]

    for model_name in models_to_try:
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_INSTRUCTION,
                    # Low latency configuration
                    thinking_config=types.ThinkingConfig(thinking_level="low"),
                ),
            )
            if response and response.text:
                return response.text.strip()
        except Exception:
            # Fall through to next model candidate
            continue

    # Fall back safely to structured deterministic answer if all models hit rate limits or are unreachable
    return _format_grounded_fallback(question, context_records, match_quality)