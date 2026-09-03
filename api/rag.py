import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Union

try:
    import json5
except ImportError:
    json5 = None

try:
    from dotenv import load_dotenv
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        load_dotenv(dotenv_path=env_path)
    else:
        load_dotenv()
except ImportError:
    pass

try:
    from google import genai
except ImportError:  # pragma: no cover - handled at runtime when dependency is installed.
    genai = None

DATA_JS_PATH = Path(__file__).resolve().parent.parent / "js" / "data.js"

STOPWORDS = {
    "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or", "is", "are",
    "am", "was", "were", "be", "been", "being", "do", "does", "did", "have", "has",
    "had", "where", "what", "which", "who", "whom", "whose", "why", "how", "i", "me",
    "my", "we", "our", "you", "your", "he", "him", "she", "her", "it", "its", "they",
    "them", "can", "could", "would", "should", "tell", "show", "please", "about", "there",
    "any", "some", "me", "find", "get", "go", "reach"
}

SYNONYM_MAP = {
    "lost": ["lost", "missing", "misplaced", "found", "find", "item", "belonging", "belongings"],
    "report": ["report", "reports", "reporting", "query", "queries", "ask", "asks", "inquire", "inquiry", "help"],
    "admin": ["admin", "administration", "administrative", "office", "desk"],
    "faculty": ["faculty", "teacher", "teachers", "staff", "mentor", "mentors", "professor", "professors", "details"],
    "infrastructure": ["infrastructure", "maintenance", "repair", "facility", "facilities", "queries"],
    "parking": ["parking", "park", "vehicle", "car", "bike", "scooter", "auto", "entry"],
    "health": ["health", "medical", "hospital", "doctor", "clinic", "dispensary", "first aid", "medicine"],
    "food": ["food", "canteen", "cafeteria", "cafe", "eat", "dining", "court"],
    "shuttle": ["shuttle", "kart", "transport", "ride", "bus", "electric shuttle"],
    "cse": ["cse", "computer science", "it", "coding", "software", "btech cse", "programming"],
}


def _extract_js_array(var_name: str, js_code: str) -> List[dict]:
    """Extract a JavaScript array variable from JS source code."""
    pattern = re.compile(
        rf"(?:const|var|let)?\s*{var_name}\s*(?:=\s*window\.{var_name}\s*)?=\s*(\[[\s\S]*?\n\s*\]);",
        re.MULTILINE,
    )
    match = pattern.search(js_code)
    if not match:
        return []

    raw_array = match.group(1)

    if json5 is not None:
        try:
            return json5.loads(raw_array)
        except Exception:
            pass

    # Fallback parser if json5 is unavailable or fails
    cleaned = re.sub(r"//.*$", "", raw_array, flags=re.MULTILINE)
    cleaned = re.sub(r"/\*[\s\S]*?\*/", "", cleaned)
    cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
    cleaned = re.sub(r"(?<=[{,\n\r\t ])([a-zA-Z_][a-zA-Z0-9_]*)\s*:", r'"\1":', cleaned)
    try:
        return json.loads(cleaned)
    except Exception:
        return []


def load_campus_records(data_js_path: Optional[Union[str, Path]] = None) -> List[dict]:
    """
    Dynamically loads campus entities (groups, locations/blocks, offices, FAQs, karts) from js/data.js.
    """
    target_path = Path(data_js_path) if data_js_path else DATA_JS_PATH
    if not target_path.exists():
        return []

    try:
        content = target_path.read_text(encoding="utf-8")
    except Exception:
        return []

    groups = _extract_js_array("CAMPUS_GROUPS", content)
    locations = _extract_js_array("CAMPUS_LOCATIONS", content)
    offices = _extract_js_array("CAMPUS_OFFICES", content)
    knowledge_base = _extract_js_array("AI_KNOWLEDGE_BASE", content)
    karts = _extract_js_array("CAMPUS_KARTS", content)

    records: List[dict] = []

    for group in groups:
        records.append({
            "id": group.get("id"),
            "kind": "group",
            "name": group.get("name", ""),
            "category": group.get("category", "academics"),
            "type": group.get("type", "Department"),
            "tags": group.get("tags", []) or [],
            "blocks": group.get("blocks", []) or [],
            "groupName": group.get("groupName", ""),
            "desc": group.get("desc", ""),
            "facilities": group.get("facilities", []) or [],
        })

    for loc in locations:
        loc_id = str(loc.get("id", ""))
        kind = loc.get("kind") or ("block" if "block" in loc_id.lower() else "location")
        records.append({
            "id": loc_id,
            "kind": kind,
            "name": loc.get("name", ""),
            "groupId": loc.get("groupId"),
            "groupName": loc.get("groupName") or "",
            "category": loc.get("category", ""),
            "type": loc.get("type", "Campus Location"),
            "lat": loc.get("lat"),
            "lng": loc.get("lng"),
            "floor": loc.get("floor", ""),
            "facilities": loc.get("facilities", []) or [],
            "tags": loc.get("tags", []) or [],
            "desc": loc.get("desc", ""),
            "hours": loc.get("hours", "Open on Campus Schedule"),
        })

    for office in offices:
        records.append({
            "id": office.get("id"),
            "kind": "office",
            "name": office.get("name", ""),
            "groupId": office.get("groupId"),
            "groupName": office.get("groupName") or "",
            "category": office.get("category", "offices"),
            "type": office.get("type", "Administrative Office"),
            "parentBlockIds": office.get("parentBlockIds", []) or [],
            "visibleFromZoom": office.get("visibleFromZoom"),
            "lat": office.get("lat"),
            "lng": office.get("lng"),
            "floor": office.get("floor", ""),
            "facilities": office.get("facilities", []) or [],
            "tags": office.get("tags", []) or [],
            "desc": office.get("desc", ""),
            "hours": office.get("hours", "8:00 AM - 5:30 PM"),
        })

    for kb in knowledge_base:
        records.append({
            "id": kb.get("locationId") or kb.get("groupId") or "kb-item",
            "kind": "faq",
            "name": kb.get("question", "Campus FAQ"),
            "category": "faq",
            "type": "Campus FAQ",
            "tags": kb.get("triggers", []) or [],
            "desc": kb.get("answer", ""),
            "groupId": kb.get("groupId"),
            "locationId": kb.get("locationId"),
            "facilities": [],
            "hours": "",
        })

    for kart in karts:
        records.append({
            "id": kart.get("id"),
            "kind": "kart",
            "name": kart.get("name", "Campus Shuttle"),
            "category": "transport",
            "type": "Campus Shuttle / Kart",
            "tags": ["shuttle", "kart", "transport", "electric shuttle", kart.get("name", "").lower()],
            "desc": f"Route: {kart.get('route', '')}. Location: {kart.get('location', '')}. ETA: {kart.get('eta', '')}",
            "route": kart.get("route", ""),
            "lat": kart.get("lat"),
            "lng": kart.get("lng"),
            "facilities": ["Electric Transport", "Campus Shuttle"],
            "hours": "Open on Campus Schedule",
        })

    return records


# Preloaded default campus records
CAMPUS_RECORDS = load_campus_records()


def _normalize_text(value: Optional[str]) -> str:
    if value is None:
        return ""
    text = str(value).lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _tokenize(text: str, filter_stopwords: bool = False) -> List[str]:
    tokens = [token for token in _normalize_text(text).split() if token]
    if filter_stopwords:
        tokens = [t for t in tokens if t not in STOPWORDS]
    return tokens


def _expanded_terms(question: str) -> List[str]:
    tokens = set(_tokenize(question, filter_stopwords=True))
    expanded = set(tokens)
    for token in list(tokens):
        expanded.add(token)
        for canonical, variants in SYNONYM_MAP.items():
            if token == canonical or token in variants:
                expanded.add(canonical)
                expanded.update(variants)
    return sorted(expanded)


def _record_search_text(record: dict) -> str:
    values = []
    for field in ["name", "type", "desc", "groupName", "category", "floor"]:
        values.append(record.get(field, ""))
    for field in ["tags", "facilities", "parentBlockIds", "blocks"]:
        val = record.get(field)
        if isinstance(val, list):
            values.extend(val)
        elif val:
            values.append(str(val))
    text = " ".join(str(v) for v in values)
    return _normalize_text(text)


def retrieve_relevant_records(question: str, records: Optional[Iterable[dict]] = None, limit: int = 5) -> List[dict]:
    """
    Score and retrieve the most relevant campus entities matching the user's question.
    """
    base_records = list(records) if records is not None else list(CAMPUS_RECORDS)
    if not question or not question.strip():
        return []

    cleaned = _normalize_text(question)
    query_tokens = _tokenize(question, filter_stopwords=True)
    expanded_terms = _expanded_terms(cleaned)

    # Detect numbers in query (e.g. 28, 25, 209, 31, 1)
    query_numbers = [tok for tok in query_tokens if tok.isdigit()]

    scored: List[dict] = []
    for record in base_records:
        search_text = _record_search_text(record)
        name_normalized = _normalize_text(record.get("name", ""))
        score = 0
        matches = []

        # 1. Expanded Term Matching
        for term in expanded_terms:
            if term in search_text:
                matches.append(term)
                weight = 4
                if term in name_normalized:
                    weight += 8
                if term in _normalize_text(" ".join(record.get("tags", []) or [])):
                    weight += 6
                if term in _normalize_text(" ".join(record.get("facilities", []) or [])):
                    weight += 8
                if term in _normalize_text(record.get("desc", "") or ""):
                    weight += 4
                if term in _normalize_text(record.get("floor", "") or ""):
                    weight += 6
                if term in _normalize_text(record.get("groupName", "") or ""):
                    weight += 4
                score += weight

        # 2. Number / Identifier Match Bonus (e.g. Block 28 vs Block 31)
        for num in query_numbers:
            rec_id = str(record.get("id", "")).lower()
            rec_name_tokens = _tokenize(record.get("name", ""))
            if num in rec_id.split("-") or num in rec_name_tokens:
                score += 35
                matches.append(f"#{num}")
            elif num in search_text.split():
                score += 15

        # 3. Exact Substring Phrase Matching
        if name_normalized and (name_normalized in cleaned or cleaned in name_normalized):
            score += 40

        for tag in record.get("tags", []) or []:
            norm_tag = _normalize_text(tag)
            if norm_tag and norm_tag in cleaned:
                score += 25
                matches.append(norm_tag)

        for fac in record.get("facilities", []) or []:
            norm_fac = _normalize_text(fac)
            if norm_fac and norm_fac in cleaned:
                score += 30
                matches.append(norm_fac)

        # 4. Specific high-intent key phrases
        intent_phrases = [
            "lost item", "lost and found", "report a lost item", "lost property",
            "infrastructure", "infrastructure queries", "faculty details", "faculty cabin",
            "computer science", "school of fashion design", "uni health center",
            "parking", "main gate", "auditorium", "health center"
        ]
        for phrase in intent_phrases:
            if phrase in cleaned and phrase in search_text:
                score += 15

        if score > 0:
            scored.append({
                "id": record.get("id"),
                "kind": record.get("kind"),
                "name": record.get("name"),
                "score": score,
                "matches": sorted(list(set(matches))),
                "search_text": search_text,
                "record": record,
            })

    scored.sort(key=lambda item: (-item["score"], item["name"]))
    return scored[:limit]


def build_context_block(records: List[dict], all_records: Optional[List[dict]] = None) -> str:
    """Format matched records and their associated blocks/offices into a rich context block for LLM prompting."""
    if not records:
        return "No relevant campus records were retrieved."

    all_recs = all_records if all_records is not None else CAMPUS_RECORDS
    records_by_id = {str(r.get("id")): r for r in all_recs if r.get("id")}

    context_lines = []
    seen_ids = set()

    for item in records:
        record = item.get("record", item)
        rec_id = str(record.get("id", ""))
        if rec_id in seen_ids:
            continue
        seen_ids.add(rec_id)

        location_details = []
        if record.get("floor"):
            location_details.append(f"Floor/Location: {record['floor']}")
        if record.get("groupName"):
            location_details.append(f"Department/Cluster: {record['groupName']}")
        if record.get("lat") is not None and record.get("lng") is not None:
            location_details.append(f"Coordinates: {record['lat']}, {record['lng']}")
        if record.get("parentBlockIds"):
            formatted_parents = ", ".join(b.replace("block-", "Block ") for b in record["parentBlockIds"])
            location_details.append(f"Located in / Serving Blocks: {formatted_parents}")
        if record.get("blocks"):
            formatted_blocks = ", ".join(b.replace("block-", "Block ") for b in record["blocks"])
            location_details.append(f"Associated Blocks in Zone: {formatted_blocks}")

        facility_text = ", ".join(record.get("facilities", []) or [])
        tags_text = ", ".join(record.get("tags", []) or [])
        loc_str = "; ".join(location_details)

        context_lines.append(
            f"• Entity: {record.get('name')} | Type: {record.get('type', 'Campus Location')}\n"
            f"  - Details: {loc_str or 'Campus Grounds'}\n"
            f"  - Hours/Timings: {record.get('hours', 'Open on Campus Schedule')}\n"
            f"  - Services & Facilities: {facility_text or 'Standard Campus Facilities'}\n"
            f"  - Description: {record.get('desc', '')}\n"
            f"  - Keywords/Tags: {tags_text}"
        )

        # Include child offices if this is a block or group
        for other in all_recs:
            if other.get("kind") == "office" and other.get("id") not in seen_ids:
                parents = [p.lower() for p in (other.get("parentBlockIds") or [])]
                if rec_id.lower() in parents or (record.get("groupId") and other.get("groupId") == record.get("groupId")):
                    context_lines.append(
                        f"  [Inside/Serving Office]: {other.get('name')} (Floor: {other.get('floor', 'N/A')}) - Services: {', '.join(other.get('facilities', []) or [])}"
                    )

    return "\n\n".join(context_lines)


def generate_direct_reply(question: str, relevant_records: List[dict]) -> str:
    """
    Directly synthesizes an accurate, clean, structured response from the fed campus records.
    Used as an immediate fallback or when offline without needing an external API key.
    """
    if not relevant_records:
        return (
            "I couldn't find any matching campus records in the system. "
            "Please try asking about a specific block (e.g., Block 28, Block 1), "
            "department (e.g., CSE, Fashion Design), office (e.g., Lost and Found, Room 209), "
            "or facility (e.g., Uni Health Center, Parking)."
        )

    top_item = relevant_records[0]
    rec = top_item["record"]
    kind = rec.get("kind", "")
    name = rec.get("name", "Campus Location")
    desc = rec.get("desc", "")
    floor = rec.get("floor", "")
    hours = rec.get("hours", "")
    facilities = rec.get("facilities", []) or []
    group_name = rec.get("groupName", "")
    parent_blocks = rec.get("parentBlockIds", []) or []
    blocks = rec.get("blocks", []) or []

    # If top item is FAQ, format directly from answer
    if kind == "faq":
        return f"💡 **{name}**\n\n{desc}"

    lines = [f"📍 **{name}**"]

    if rec.get("type"):
        lines.append(f"• **Type:** {rec.get('type')}")

    if floor:
        lines.append(f"• **Location / Floor:** {floor}")

    if parent_blocks:
        formatted_blocks = ", ".join(b.replace("block-", "Block ") for b in parent_blocks)
        lines.append(f"• **Serving / Located in:** {formatted_blocks}")

    if blocks:
        formatted_blocks = ", ".join(b.replace("block-", "Block ") for b in blocks)
        lines.append(f"• **Campus Blocks:** {formatted_blocks}")

    if group_name:
        lines.append(f"• **Department:** {group_name}")

    if facilities:
        lines.append(f"• **Services & Facilities:** {', '.join(facilities)}")

    if hours:
        lines.append(f"• **Hours / Schedule:** {hours}")

    if desc:
        lines.append(f"• **Details:** {desc}")

    # If there are additional relevant records (e.g. secondary related blocks or offices)
    if len(relevant_records) > 1:
        other_names = [f"**{r['name']}**" for r in relevant_records[1:3] if r["name"] != name]
        if other_names:
            lines.append(f"\n💡 *Related locations:* {', '.join(other_names)}")

    return "\n".join(lines)


# Global in-memory cache for fast, instantaneous repeated query responses
_CHAT_CACHE: Dict[str, str] = {}
_GENAI_CLIENT = None


def _get_genai_client(api_key: str):
    global _GENAI_CLIENT
    if _GENAI_CLIENT is None and genai is not None:
        try:
            _GENAI_CLIENT = genai.Client(api_key=api_key)
        except Exception:
            _GENAI_CLIENT = None
    return _GENAI_CLIENT


def generate_chat_reply(question: str, relevant_records: List[dict]) -> str:
    """
    Generate a chatbot response for the user's question using Gemini AI if configured,
    or smoothly fallback to direct record synthesis.
    Optimized for ultra-low latency.
    """
    if not relevant_records:
        return (
            "I couldn't find any campus records that match your question. "
            "Please ask about a specific block, office, department, or service "
            "(such as CSE Department, Block 28, Lost and Found, or Health Center)."
        )

    norm_q = _normalize_text(question)

    # 1. Check in-memory cache for instantaneous response (< 1ms)
    if norm_q in _CHAT_CACHE:
        return _CHAT_CACHE[norm_q]

    # 2. Fast-path for direct FAQ knowledge base records (0ms)
    top_item = relevant_records[0]
    top_rec = top_item.get("record", {})
    if top_rec.get("kind") == "faq" and top_rec.get("desc"):
        reply = f"💡 **{top_rec.get('name', 'Campus Information')}**\n\n{top_rec.get('desc')}"
        _CHAT_CACHE[norm_q] = reply
        return reply

    api_key = os.getenv("GEMINI_API_KEY", "").strip()

    # If no API key is provided, synthesize answer directly from fed campus records
    if not api_key:
        reply = generate_direct_reply(question, relevant_records)
        _CHAT_CACHE[norm_q] = reply
        return reply

    # Fast models prioritized for lowest latency and highest throughput
    custom_model = os.getenv("GEMINI_MODEL", "").strip()
    candidate_models = []
    if custom_model:
        candidate_models.append(custom_model)
    candidate_models.extend([
        "gemini-3.5-flash",       # Ultra-fast (< 1s)
        "gemini-3.1-flash-lite",  # Fast & efficient
        "gemini-flash-latest",    # Flash fallback
        "gemini-3.7-flash",       # Standard
    ])
    # Deduplicate while preserving order
    candidate_models = list(dict.fromkeys(candidate_models))

    # Keep context compact (top 2-3 records) to minimize prompt token count & latency
    compact_records = relevant_records[:3]
    context_block = build_context_block(compact_records, CAMPUS_RECORDS)
    prompt = (
        "You are LPUNavix AI, the smart campus assistant for Lovely Professional University (LPU).\n"
        "Provide a concise, direct, helpful answer (3-5 bullet points) using ONLY the campus context below.\n"
        "Rules:\n"
        "- Highlight block numbers, room numbers, floor levels, operational hours, and key facilities in bold.\n"
        "- If asked about CSE Department, list all associated blocks (Blocks 25, 26, 27, 28, 31, 32, 33, 34, 36, 37, 38) and the admin office in Room 209.\n"
        "- If asked about lost items or admin queries, state Room 209 in Block 28 (8:00 AM – 5:30 PM).\n"
        "- Be brief and immediately actionable.\n\n"
        f"Campus Context:\n{context_block}\n\n"
        f"Question: {question}\n\n"
        "Answer:"
    )

    # Try google.genai SDK with singleton client & fast config
    client = _get_genai_client(api_key)
    if client is not None:
        for model_name in candidate_models:
            for cfg in [
                {"max_output_tokens": 250, "temperature": 0.2, "thinking_config": {"thinking_budget": 0}},
                {"max_output_tokens": 250, "temperature": 0.2}
            ]:
                try:
                    response = client.models.generate_content(
                        model=model_name,
                        contents=prompt,
                        config=cfg
                    )
                    if response and response.text:
                        reply = response.text.strip()
                        if len(_CHAT_CACHE) > 500:
                            _CHAT_CACHE.clear()
                        _CHAT_CACHE[norm_q] = reply
                        return reply
                except Exception:
                    continue

    # Fallback to direct synthesis for guaranteed speed & reliability
    reply = generate_direct_reply(question, relevant_records)
    _CHAT_CACHE[norm_q] = reply
    return reply


