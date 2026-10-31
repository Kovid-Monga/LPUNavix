import os
import re
import time
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

try:
    from google import genai
    from google.genai import types
    GENAI_AVAILABLE = True
except ImportError:
    genai = None
    types = None
    GENAI_AVAILABLE = False


def _clean_coordinates_from_text(text: str) -> str:
    """Removes raw lat/lng coordinates from text to keep chat responses natural."""
    if not text:
        return text
    t = re.sub(r'\(?\b\d{2}\.\d{3,},\s*\d{2}\.\d{3,}\)?', '', text)
    t = re.sub(r'(?i)\b(?:coordinates|coords|lat\s*/\s*lng):\s*\[?[^\]\r\n]+\]?', '', t)
    t = re.sub(r'  +', ' ', t)
    return t.strip()


EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSION = 3072

GENERATION_MODEL = os.getenv("GENERATION_MODEL", "gemini-3.5-flash-lite")
FALLBACK_GENERATION_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.1-flash-lite",
]

_client: Optional[Any] = None


def get_client() -> Optional[Any]:
    global _client
    if _client is not None:
        return _client
    if not GENAI_AVAILABLE or genai is None:
        return None
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        _client = genai.Client(api_key=api_key)
        return _client
    except Exception:
        return None


def embed_texts(texts: List[str]) -> List[List[float]]:
    """Embed a batch of texts (chunked into batches <= 90 to respect Gemini API limits)."""
    if not texts:
        return []
    client = get_client()
    if client is None:
        raise RuntimeError("Gemini client is unavailable or GEMINI_API_KEY is not configured.")

    batch_size = 90
    all_embeddings: List[List[float]] = []
    for i in range(0, len(texts), batch_size):
        chunk = texts[i : i + batch_size]
        for attempt in range(6):
            try:
                response = client.models.embed_content(
                    model=EMBEDDING_MODEL,
                    contents=chunk,
                )
                batch_embeddings = [list(e.values) for e in response.embeddings]
                if len(batch_embeddings) != len(chunk):
                    raise RuntimeError("Gemini returned an unexpected number of embeddings.")
                if any(len(vector) != EMBEDDING_DIMENSION for vector in batch_embeddings):
                    raise RuntimeError(
                        f"Gemini embeddings must have {EMBEDDING_DIMENSION} dimensions."
                    )
                all_embeddings.extend(batch_embeddings)
                break
            except Exception as e:
                err_msg = str(e)
                if ("429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg) and attempt < 5:
                    sleep_time = 15 * (attempt + 1)
                    time.sleep(sleep_time)
                    continue
                raise
    return all_embeddings


def embed_query(text: str) -> List[float]:
    """Embed a single incoming user question."""
    return embed_texts([text])[0]


SYSTEM_INSTRUCTION = """You are LPUNavix, the friendly, helpful AI Campus Guide for Lovely Professional University (LPU).
You speak like an encouraging, knowledgeable campus guide who helps students and visitors find faculty, cabins, buildings, food, and facilities quickly.

CORE GUIDELINES:
- Conversational & Natural: Respond naturally and dynamically to user inputs.
- Greetings & Pleasantries: When the user greets you ("hello", "hi", "good morning"), welcome them warmly and offer campus navigation help.
- Goodbyes & Gratitude: Acknowledge politely and warmly.
- User Lost on Campus: If the user says they are lost ("I am lost", "lost my way", "where am I"), reassure them warmly and ask which nearby building or landmark they see (UniMall, Central Library, Unipolis, or block numbers from 1 to 38), or suggest using the map location marker.
- Off-topic / Non-campus queries: Politely explain that you are their LPUNavix campus guide focused on helping them navigate Lovely Professional University, and invite their next campus question. Do not answer general coding or academic homework.
- Strict Campus Grounding: Use ONLY facts directly present in the provided Context records for campus information. Do NOT hallucinate fake buildings, rooms, cabins, or HODs. If the answer is not in the context records, state clearly that campus records do not have that specific information.
- Strictly NO Raw Coordinates: NEVER output numerical latitude/longitude numbers in your text. Map navigation is handled by UI buttons and location cards.
- Conciseness: Keep responses short, clear, and bite-sized (2 to 4 sentences or a compact info card).

FOLLOW-UP QUESTIONS:
At the very end of your response, provide exactly two short, relevant follow-up questions formatted on separate lines as:
Q1: [Question 1]?
Q2: [Question 2]?"""


def _format_grounded_fallback(question: str, context_records: List[Dict[str, Any]], match_quality: str) -> str:
    """Generate a clean, context-based grounded reply when external LLM calls are offline or unavailable."""
    q_lower = question.lower().strip()

    # Conversational greetings & identity
    if any(p in q_lower for p in ["how are you", "how r u", "how do you do", "how's it going"]):
        return (
            "Hey there! 😊 I'm doing great, thank you! I'm your LPUNavix campus guide. 🚀\n\n"
            "I can help you locate academic blocks, faculty cabins, hostels, dining spots, and campus facilities. What can I find for you today? 🏢📍"
        )
    if any(p in q_lower for p in ["who are you", "what are you", "what is your name"]):
        return (
            "Hey there! 😊 I am **LPUNavix**, your friendly AI campus navigation assistant! 🗺️✨\n\n"
            "I help students and visitors navigate Lovely Professional University (LPU) — finding blocks, faculty cabins, tuck shops, food spots, and services. How can I help you today? 🏢"
        )
    if (q_lower in ["hi", "hello", "hey", "hlo", "good morning", "good afternoon", "good evening"] or 
        (any(q_lower.startswith(w) for w in ["hi ", "hello ", "hey "]) and len(q_lower.split()) <= 3)):
        return (
            "Hey there! 👋 Welcome to LPUNavix, your Lovely Professional University campus guide! 😊✨\n\n"
            "Need directions to a block, a faculty cabin, hostel, or a food spot? Just ask! 🏢📍"
        )

    # Physically lost guidance
    if any(p in q_lower for p in ["lost my way", "where am i", "im lost", "i am lost"]) or q_lower == "lost":
        return (
            "Don't worry, you're not alone! 😊 Look around for the nearest block number (blocks range from Block 1 to 38) or major landmarks like UniMall, Unipolis, or the Central Library. 🏢📍\n\n"
            "Tell me what building you see or tap your location on the map, and I'll guide you to where you need to be! 🗺️✨"
        )

    # Food dish queries
    if any(w in q_lower for w in ["paneer", "dosa", "doss", "pizza", "burger", "hungry", "grab a bite", "snack"]):
        return (
            "Craving a bite? 🍕✨ While individual item menus are not listed, **UniMall** is LPU's primary dining hub with a full multi-cuisine food court and cafes! 🏢\n\n"
            "You can also grab snacks and drinks at the basement tuck shops in Blocks 26, 27, 28, and 36! 🥪☕\n\n"
            "Want to see UniMall on the map? Tap below! 🗺️"
        )

    # Healthcare / feeling unwell / hospital queries
    if any(w in q_lower for w in ["sick", "unwell", "hospital", "doctor", "health center", "medical", "clinic", "not feeling well", "not well", "fever", "dizzy", "injured", "hurt", "blood"]):
        return (
            "Hope you feel better soon! 🩺 If you are unwell or need medical care, please visit the **Uni Health Center** on campus right away. 🏥\n\n"
            "They provide outpatient doctor consultations, first aid, emergency treatment, and medical assistance for students.\n\n"
            "Want to view directions on the map? Tap below! 🗺️✨"
        )

    # Direct responses for acronym / definition questions
    if any(p in q_lower for p in ["what is gh", "gh meaning", "gh stands for", "full form of gh"]):
        return (
            "Hey there! 😊 **GH** stands for **Girls Hostel** at LPU! 🏢🌸\n\n"
            "Campus Girls Hostels include **GH-1**, **GH-2**, **GH-3**, and **GH-4**, offering comfortable rooms, mess/dining halls, study rooms, Wi-Fi, and 24x7 security.\n\n"
            "Want to see their location on the map? Tap below! 🗺️✨"
        )
    if any(p in q_lower for p in ["what is gs", "gs meaning", "gs stands for", "full form of gs"]):
        return (
            "Hey there! 😊 **GS** stands for **Girls Studios** at LPU! 🏢✨\n\n"
            "Campus Girls Studios include **GS-11** and **GS-12**, providing studio apartment living with Wi-Fi, pantry amenities, study lounges, and 24x7 security.\n\n"
            "Want to see their location on the map? Tap below! 🗺️✨"
        )
    if any(p in q_lower for p in ["what is bh", "bh meaning", "bh stands for", "full form of bh"]):
        return (
            "Hey there! 😊 **BH** stands for **Boys Hostel** at LPU! 🏢\n\n"
            "Campus Boys Hostels include **BH-1**, **BH-2**, **BH-3**, **BH-5**, and **BH-6**, with mess dining, study rooms, gym facilities, and 24x7 security.\n\n"
            "Want to see their location on the map? Tap below! 🗺️✨"
        )
    if any(p in q_lower for p in ["what is bs", "bs meaning", "bs stands for", "full form of bs"]):
        return (
            "Hey there! 😊 **BS** stands for **Boys Studio** at LPU! 🏢\n\n"
            "Campus Boys Studios include **BS-11**, **BS-12**, and **BS-13**, offering studio accommodations with Wi-Fi, pantry, and 24x7 security.\n\n"
            "Want to see their location on the map? Tap below! 🗺️✨"
        )

    # Stationery tuck shop queries
    if any(w in q_lower for w in ["stationery", "stationary", "tuck shop", "tuck shops", "tuckshop", "pens", "notebooks", "notebook", "photocopy"]):
        b_m = re.search(r"\b(?:block|b)[\s-]*(\d{1,2})\b", q_lower)
        if b_m:
            b_num = b_m.group(1).lstrip("0")
            if b_num in ["26", "27", "28", "36"]:
                return (
                    f"Yes! 😊 There is a stationery tuck shop located in the **Basement of Block {b_num}**! ✏️📓\n\n"
                    f"Students can purchase necessary stationery items such as pens, notebooks, and academic supplies here.\n\n"
                    f"Want to see it on the map? Tap below! 🗺️✨"
                )
            else:
                return (
                    f"Stationery tuck shops are located in the **basements** of Blocks **26, 27, 28, and 36** (not Block {b_num}). ✏️📓\n\n"
                    f"Students can visit any of those four basement shops to purchase necessary stationery items such as pens and notebooks.\n\n"
                    f"Want to view them on the map? Tap below! 🗺️✨"
                )
        return (
            "Hey there! 😊 Stationery tuck shops are located in the **basements** of the following four blocks:\n\n"
            "• **Block 26** — Basement: Stationery tuck shop\n"
            "• **Block 27** — Basement: Stationery tuck shop\n"
            "• **Block 28** — Basement: Stationery tuck shop\n"
            "• **Block 36** — Basement: Stationery tuck shop\n\n"
            "Students can purchase necessary stationery items such as pens, notebooks, and academic supplies here! ✏️📓\n\n"
            "Want to see their locations on the map? Tap below! 🗺️✨"
        )

    # Unipolis queries
    if any(w in q_lower for w in ["unipolis", "university events held", "events held", "report initially"]):
        return (
            "Hey there! 😊 **Unipolis** is a massive central indoor mega-auditorium and event arena with a seating capacity of over 10,000 people! 🏛️✨\n\n"
            "It serves as a major venue for university events, celebrity visits, cultural festivals, and initial student reporting.\n\n"
            "Want to see it on the map? Tap below! 🗺️✨"
        )

    # UniMall queries
    if any(w in q_lower for w in ["unimall", "uni mall", "mall on campus", "find the mall", "where is the mall", "campus mall"]):
        return (
            "Hey there! 😊 **UniMall** is the central shopping mall on campus! 🛍️🏢\n\n"
            "It features retail stores, a food court, lifestyle brands, electronics, and daily conveniences for students and staff.\n\n"
            "Want to see UniMall on the map? Tap below! 🗺️✨"
        )

    if match_quality == "none" or not context_records:
        return (
            "I couldn't find a campus record matching that query. 🤔\n\n"
            "Try checking the name, block number, or department. I can help you find campus buildings, hostels, food spots, offices, and departments! 🏢📍"
        )

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
            name_val = r.get('name') or r.get('title') or 'Campus Location'
            lines = [f"🏢 **{name_val}**"]
            desc = r.get("desc") or r.get("description") or r.get("text")
            if desc:
                if len(desc) > 300:
                    desc = desc[:297] + "..."
                lines.append(f"✨ {desc}")
            loc = r.get("floor") or r.get("category")
            if loc:
                lines.append(f"📍 {loc}")
            cards.append("\n".join(lines))

    card_text = "\n\n---\n\n".join(cards)
    followup = "\n\nNeed directions? Tap below to view on the map! 🗺️✨"
    return intro + card_text + followup


def generate_reply(
    question: str,
    context_records: List[Dict[str, Any]],
    match_quality: str,
    history: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """Call Gemini to produce the final chat reply with multi-model fallback and deterministic safety net."""
    client = get_client()
    if client is None:
        return _format_grounded_fallback(question, context_records, match_quality)

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
            cfg_kwargs: Dict[str, Any] = {"system_instruction": SYSTEM_INSTRUCTION}
            if hasattr(types, "AutomaticFunctionCallingConfig"):
                try:
                    cfg_kwargs["automatic_function_calling"] = types.AutomaticFunctionCallingConfig(disable=True)
                except Exception:
                    pass
            if hasattr(types, "ThinkingConfig"):
                try:
                    cfg_kwargs["thinking_config"] = types.ThinkingConfig(thinking_level="low")
                except Exception:
                    pass
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(**cfg_kwargs),
            )
            if response and response.text:
                return _clean_coordinates_from_text(response.text.strip())
        except Exception:
            continue

    return _format_grounded_fallback(question, context_records, match_quality)
