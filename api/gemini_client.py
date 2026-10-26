"""
Thin wrapper around the Gemini API (google-genai SDK) for:
  - batch text embeddings (data indexing + query embedding)
  - grounded generation (chat replies constrained to retrieved context)

Requires GEMINI_API_KEY in the environment (see .env.example).
Never hardcode a key here.
"""

import os
from pathlib import Path
import time

try:
    from dotenv import load_dotenv
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.exists():
        load_dotenv(dotenv_path=env_file)
    else:
        load_dotenv()
except ImportError:
    pass

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
    """Embed a batch of texts (chunked into batches <= 90 to respect Gemini API limits)."""
    if not texts:
        return []
    client = get_client()
    batch_size = 90
    all_embeddings = []
    for i in range(0, len(texts), batch_size):
        chunk = texts[i : i + batch_size]
        for attempt in range(6):
            try:
                response = client.models.embed_content(
                    model=EMBEDDING_MODEL,
                    contents=chunk,
                )
                all_embeddings.extend([e.values for e in response.embeddings])
                break
            except Exception as e:
                err_msg = str(e)
                if ("429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg) and attempt < 5:
                    sleep_time = 15 * (attempt + 1)
                    print(f"[embed_texts] Rate limited (429). Retrying in {sleep_time}s (attempt {attempt + 1}/5)...")
                    time.sleep(sleep_time)
                    continue
                raise
    return all_embeddings


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

Training & Placement Cell (TPC):
- When asked about the Placement Cell, TPC, campus placements, drives, or interviews:
  • Clearly state that it is situated in Block 32 (School of Computer Science & Engineering - CSE).
  • Highlight that it is located across the 2nd, 3rd, and 4th floors (2nd floor: student helpdesk, registration & verification; 3rd floor: GD & corporate interview rooms; 4th floor: executive placement cabins & corporate relations).

Central Library & Block 37:
- When asked about the Central Library or Library:
  • Clearly state that it is situated in the pathway (coordinates: 31.2522036, 75.7033894).
  • Clearly explain the floor division:
    - The Central Library occupies up to the 5th floor (Ground floor to 5th floor).
    - From the 6th floor onwards, the building houses Block 37 (School of Computer Science & Engineering - CSE).
- When asked about Block 37:
  • Clearly state that Block 37 (CSE) is situated from the 6th floor onwards in the same building above the Central Library in the pathway (Ground to 5th floor is the Central Library).

Shanti Devi Mittal Auditorium & Auditoriums:
- When asked about Shanti Devi Mittal Auditorium (or auditoriums / audi / event venue):
  • Clearly state that Shanti Devi Mittal Auditorium is located on the campus at coordinates 31.252058, 75.704112.
  • Highlight that it is a premier venue for convocations, cultural fests, national conferences, academic symposiums, and university events.
  • (If asked generally about auditoriums on campus, you can also mention Sh. Baldevraj Mittal Auditorium located near the main entrance/Block 1).

Unipolis — Auditorium Group:
- When asked about Unipolis, major university events venue, or where students report initially:
  • Unipolis is a massive central indoor mega-auditorium and event arena with a seating capacity of over 10,000 people.
  • It serves as a major venue for university events, celebrity visits, cultural festivals, and initial student reporting.
  • Coordinates: 31.255085, 75.704811. Category / Group: Auditorium (Auditoriums group).

UniMall — Mall Group:
- When asked about UniMall, mall on campus, or campus shopping:
  • UniMall is the main campus shopping mall (Category / Group: Mall).
  • Features retail stores, food court/outlets, lifestyle brands, electronics, and daily convenience services for students and staff.
  • Coordinates: 31.255736, 75.705318.

Sports Complex — Indoor Sports:
- When asked about the Sports Complex or where to play indoor sports:
  • The Sports Complex is a campus facility for indoor sports (Category / Group: sports / Sports Complex).
  • Features indoor sports arenas including badminton courts, basketball courts, gymnasium, swimming pool, table tennis, and squash courts.
  • Coordinates: 31.250862, 75.701458.

Block 29 — Division of Admissions:
- When asked about Block 29, the Division of Admissions, or where to go for admission queries / counseling:
  • The Division of Admissions is located in Block 29 (Admission Block) and handles admission-related queries, counseling, and document verification.
  • Coordinates: 31.252722, 75.704132. Category: Academic & Administrative Block.

Mittal School of Business (MSB):
- When asked about Mittal School of Business, MSB, or the business / management school:
  • Mittal School of Business (MSB) houses management, MBA, BBA, commerce, and economics programs.
  • Coordinates: 31.254525, 75.705613. Category: Academic Block.

Division of Student Relationship (DSR) / Division of Student Welfare (DSW):
- When asked about DSR, DSW, Division of Student Relationship, Division of Student Welfare, or where to go for academic problems, hostel issues, student complaints, or welfare:
  • Students can reach out to DSR / DSW for ANY problem regarding academics, student grievances, hostels, or general campus welfare.
  • Coordinates: 31.255099, 75.706053. Category: Student Welfare & Support Office.

Stationery Tuck Shops (Basements of Blocks 26, 27, 28, and 36):
- When asked about stationery, tuck shops, pens, notebooks, or academic supplies:
  • Stationery tuck shops are located in the **basements of Blocks 26, 27, 28, and 36**.
  • Purpose: Students can purchase necessary stationery items such as pens, notebooks, and academic supplies.
  • For general queries (e.g. "Where can I buy stationery?", "Where are the tuck shops?", "Where can I buy pens, notebooks, or other stationery?", "Which blocks have stationery shops in their basements?"), list all four known locations:
    - Block 26 — Basement: Stationery tuck shop
    - Block 27 — Basement: Stationery tuck shop
    - Block 28 — Basement: Stationery tuck shop
    - Block 36 — Basement: Stationery tuck shop
  • For a block-specific query (e.g. "Is there a stationery shop in Block 26?"):
    - If the block is 26, 27, 28, or 36, specify that block's basement stationery tuck shop location.
    - If another block is asked, clearly clarify that stationery tuck shops are located in the basements of Blocks 26, 27, 28, and 36.
  • STRICT RULE: Do not invent opening hours, prices, shop names, or precise basement entrance coordinates.

Block Connections:
- When asked how campus blocks are connected (e.g. Block 25, 26, 27):
  • Use the provided Connection records to state how they connect (e.g. continuous indoor corridors, shared floors, bridges).
  • Highlight connecting floors and that students/faculty can walk directly between them internally.

Hostels, Studios, Apartments & Residential Area:
- When asked about hostels, studios, apartments, or the campus residential area:
  • GH = Girls Hostel (GH-1, GH-2, GH-3, GH-4).
  • GS = Girls Studio / Girls Studios (GS-11, GS-12).
  • BH = Boys Hostel (BH-1, BH-2, BH-3, BH-5, BH-6).
  • BS = Boys Studio (BS-11, BS-12, BS-13).
  • Apartments include Boys Apartment AB and Boys Apartment CD.
  • GH stands for Girls Hostel, and GS stands for Girls Studios.
  • All belong to the campus residential accommodation zones.
  • Highlight facilities such as hostel rooms/studio suites, mess/dining halls, study rooms, Wi-Fi, laundry, and 24x7 security.

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
    q_lower = question.lower().strip()

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
        import re
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
    if any(w in q_lower for w in ["unipolis", "university events held", "events held", "report initially", "student reporting", "initial reporting"]):
        return (
            "Hey there! 😊 **Unipolis** is a massive central indoor mega-auditorium and event arena with a seating capacity of over 10,000 people! 🏛️✨\n\n"
            "It serves as a major venue for university events, celebrity visits, cultural festivals, and initial student reporting. 📍 Ground Floor & Arena\n\n"
            "Want to see it on the map? Tap below! 🗺️✨"
        )

    # UniMall queries
    if any(w in q_lower for w in ["unimall", "uni mall", "mall on campus", "find the mall", "where is the mall", "campus mall"]):
        return (
            "Hey there! 😊 **UniMall** is the central shopping mall on campus! 🛍️🏢\n\n"
            "It features retail stores, a food court, lifestyle brands, electronics, and daily conveniences for students and staff.\n\n"
            "Want to see UniMall on the map? Tap below! 🗺️✨"
        )

    # Sports Complex queries
    if any(w in q_lower for w in ["sports complex", "indoor sports", "play indoor sports", "sports facility"]):
        return (
            "Hey there! 😊 The **Sports Complex** is a campus facility for indoor sports! 🏀🏸\n\n"
            "It features badminton courts, basketball courts, gymnasium, swimming pool, table tennis, and squash courts for fitness and university athletics.\n\n"
            "Want to see the Sports Complex on the map? Tap below! 🗺️✨"
        )

    # Division of Admissions / Block 29 queries
    if any(w in q_lower for w in ["division of admissions", "admission-related", "admission queries", "admission office", "handles admissions", "where is block 29", "block 29"]):
        return (
            "Hey there! 😊 The **Division of Admissions** is located in **Block 29 (Admission Block)**! 🏢🎓\n\n"
            "It handles admission-related queries, counseling, and document verification.\n\n"
            "Want to see Block 29 on the map? Tap below! 🗺️✨"
        )

    # Mittal School of Business queries
    if any(w in q_lower for w in ["mittal school of business", "school of business", "business school", "msb"]):
        return (
            "Hey there! 😊 **Mittal School of Business (MSB)** is located at coordinates **31.254525, 75.705613**! 🏢💼\n\n"
            "It is a premier business and management school offering MBA, BBA, Commerce, and Economics programs.\n\n"
            "Want to see Mittal School of Business on the map? Tap below! 🗺️✨"
        )

    # Division of Student Relationship (DSR) / Division of Student Welfare (DSW) queries
    if any(w in q_lower for w in ["dsr", "dsw", "division of student relationship", "division of student welfare", "student relationship", "student welfare", "academic problem", "hostel problem", "student problem"]):
        return (
            "Hey there! 😊 For any academic issues, hostel issues, or student problems, you can reach out to the **Division of Student Relationship (DSR) / Division of Student Welfare (DSW)**! 🏢🤝\n\n"
            "📍 Location coordinates: **31.255099, 75.706053**\n\n"
            "They handle student welfare, counseling, grievance redressal, and problem resolution across academics and campus life. Want to locate DSR on the map? Tap below! 🗺️✨"
        )

    if match_quality == "none" or not context_records:
        return (
            "Hmm, I couldn't find a matching record for that! 🤔✨\n\n"
            "Try checking the name, block number, or department. I can help you find campus buildings, hostels, food spots, offices, and departments! 🏢📍"
        )

    if match_quality == "weak":
        intro = "I couldn't find an exact match, but here's the closest campus spot! 🔍\n\n"
    elif any(w in q_lower for w in ["hostel", "hostels", "gh", "gs", "bh", "bs", "apartment", "studio", "studios", "residential", "stay", "room"]):
        intro = "Looking for campus accommodation? 🏠 Here are the hostel details:\n\n"
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
            desc = r.get("desc") or r.get("description")
            if desc:
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