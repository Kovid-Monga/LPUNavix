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


SYSTEM_INSTRUCTION = """You are the friendly, helpful AI Campus Guide for LPUNavix (Lovely Professional University).
You speak like an energetic, cheerful, and knowledgeable campus senior or student guide who helps classmates and visitors find faculty, cabins, buildings, food, and facilities quickly.

CRITICAL LENGTH & CONCISENESS RULES:
- Keep ALL responses SHORT, CONCISE, and BITE-SIZED.
- NEVER write long paragraphs, lengthy preambles, essays, or repetitive disclaimers.
- Maximum 2 to 4 short lines total (or a neat compact info card).
- The user is on campus, often walking on mobile, and needs the key answer in 3 seconds!

Tone & Persona:
- Warm, cheerful, approachable, and encouraging (e.g., "Hey there! 😊", "Found them for you! 📍✨", "Got it! 🚀", "Craving a snack? 🍕").
- Context-aware: Directly reflect what the user asked about (e.g., project guidance, cabin location, food, medical care, block directions).
- Emoji-rich: Use friendly, visual emojis generously and meaningfully (👋, 😊, 📍, 🏢, 🚪, 👩‍🏫, 👨‍🏫, 🎓, ✨, 🍕, ☕, 🩺, 🚶‍♂️, 🚀).

Response Structure:
1. [1 short, cheerful, context-based intro line with emojis]
2. [Compact Information Card]
3. [1 quick, friendly follow-up or tip with an emoji]

Compact Card Format:

Faculty & Personnel:
👩‍🏫 **[Full Name]** · [Role or Designation]
🎓 [Department / Subject] (omit line if unavailable)
📍 [Block · Room · Cabin, e.g. Block 33 · Room 205 · Cabin C1]

Location Rules:
- If cabin/seating is in the record (e.g. C1, C2), include it: "Block 34 · Room 209 · Cabin C1".
- If no cabin is listed (such as Dr. Parminder Singh or Mr. Ajay Kaler), state ONLY: "Block 34 · Room 309". Never invent a cabin.
- If an office is listed (e.g. HOS Office, Administrator Office, COS Office), write: "Block 27 · Room 201 · HOS Office".

Campus Places, Hostels, Food & Facilities:
🏢 **[Place / Building Name]**
✨ [1 punchy sentence highlight / facilities]
📍 [Floor or Area on campus]

Multiple Matches:
- If multiple people or locations match (e.g. "Who is the HOS?"), keep each card super compact (2-3 lines max each):
  👩‍🏫 **[Name]** · [Role]
  📍 [Location]

Unavailable / No Match:
- If information is not in the context, keep it short, polite, and cheerful with emojis:
  "Hmm, I couldn't find a matching record for that! 🤔 Could you check the spelling or give me a name, block number, or department? I can help with campus buildings, hostels, food spots, offices, and departments! 🏢📍"
- Strict truthfulness: Use ONLY the provided Context records. Never hallucinate or invent teachers, cabins, or phone numbers.
"""


def _format_grounded_fallback(question: str, context_records: list[dict], match_quality: str) -> str:
    """Generate a clean, concise, friendly, context-based grounded reply with emojis when external LLM calls are unavailable."""
    if match_quality == "none" or not context_records:
        return (
            "Hmm, I couldn't find a matching record for that! 🤔✨\n\n"
            "Try checking the name, block number, or department. I can help you find campus buildings, hostels, food spots, offices, and departments! 🏢📍"
        )

    q_lower = question.lower()

    if match_quality == "weak":
        intro = "I couldn't find an exact match, but here's the closest campus spot! 🔍\n\n"
    elif any(w in q_lower for w in ["project", "talk to", "contact", "guide", "who can", "whom"]):
        intro = "Working on a project? That's awesome! 🚀 Here is who can guide you:\n\n"
    elif any(w in q_lower for w in ["where is", "where does", "where can i find", "locate", "cabin"]):
        intro = "Found their location! 📍 Here's where they sit:\n\n"
    elif any(w in q_lower for w in ["who is", "who heads", "head", "hod", "hos", "cos"]):
        intro = "Got it! 🎓 Here are the faculty details:\n\n"
    elif any(w in q_lower for w in ["eat", "food", "canteen", "cafe", "hungry", "snack"]):
        intro = "Craving a bite? 🍕 Here's a great spot on campus:\n\n"
    elif any(w in q_lower for w in ["health", "hospital", "doctor", "medical", "sick"]):
        intro = "Hope you feel better soon! 🩺 Here's the medical center:\n\n"
    else:
        intro = "Sure thing! 😊 Here's what I found in campus records:\n\n"

    cards = []
    has_personnel = False
    for r in context_records[:3]:
        if r.get("uid") or r.get("role") or r.get("department_or_subject") or r.get("seating") or r.get("office"):
            has_personnel = True
            role_desc = r.get("designation") or r.get("role") or ""
            role_part = f" · {role_desc}" if role_desc else ""
            lines = [f"👩‍🏫 **{r.get('name', 'Unknown')}**{role_part}"]

            if r.get("department_or_subject"):
                lines.append(f"🎓 {r.get('department_or_subject')}")

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
            lines.append(f"📍 {loc_str}")
            cards.append("\n".join(lines))
        else:
            lines = [f"🏢 **{r.get('name', 'Campus Location')}**"]
            if r.get("description"):
                desc = r.get("description")
                if len(desc) > 85:
                    desc = desc[:82] + "..."
                lines.append(f"✨ {desc}")
            loc = r.get("floor") or r.get("category")
            if loc:
                lines.append(f"📍 {loc}")
            cards.append("\n".join(lines))

    card_text = "\n\n---\n\n".join(cards)

    if has_personnel:
        followup = "\n\nNeed directions to their cabin? Tap below! 🗺️✨"
    else:
        followup = "\n\nWant to see it on the map? Tap below! 🗺️✨"

    return intro + card_text + followup


def generate_reply(
    question: str,
    context_records: list[dict],
    match_quality: str,
    history: list[dict] | None = None,
) -> str:
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

    history_block = ""
    if history:
        conv_turns = []
        for turn in history[-6:]:
            role = "User" if turn.get("role") == "user" else "Assistant"
            content = (turn.get("content") or "").strip()
            if content:
                # Keep history lines compact
                clean_content = " ".join(content.split())
                if len(clean_content) > 160:
                    clean_content = clean_content[:157] + "..."
                conv_turns.append(f"{role}: {clean_content}")
        if conv_turns:
            history_block = "Recent conversation:\n" + "\n".join(conv_turns) + "\n\n"

    prompt = (
        f"{history_block}"
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