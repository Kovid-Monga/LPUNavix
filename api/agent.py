import re
import json
import logging
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.data_loader import CampusDataLoader, get_campus_data_loader, haversine_distance_m
from api.vector_store import get_campus_vector_store
import api.gemini_client as gemini_client

try:
    from google import genai
    from google.genai import types
except ImportError:
    types = getattr(gemini_client, "types", None)

logger = logging.getLogger("lpunavix.agent")
logger.setLevel(logging.INFO)

router = APIRouter(tags=["Autonomous Campus Assistant (Gemini / RAG)"])


def _clean_coordinates_from_text(text: str) -> str:
    """Removes raw lat/lng coordinates from text to keep chat responses natural."""
    if not text:
        return text
    t = re.sub(r'\(?\b\d{2}\.\d{3,},\s*\d{2}\.\d{3,}\)?', '', text)
    t = re.sub(r'(?i)\b(?:coordinates|coords|lat\s*/\s*lng):\s*\[?[^\]\r\n]+\]?', '', t)
    t = re.sub(r'  +', ' ', t)
    return t.strip()


# Campus GPS boundary constants
CAMPUS_LAT_MIN = 31.2400
CAMPUS_LAT_MAX = 31.2650
CAMPUS_LNG_MIN = 75.6900
CAMPUS_LNG_MAX = 75.7200


def is_user_on_campus(lat: float, lng: float) -> bool:
    """Checks whether the user's GPS fix falls within the LPU campus area."""
    return CAMPUS_LAT_MIN <= lat <= CAMPUS_LAT_MAX and CAMPUS_LNG_MIN <= lng <= CAMPUS_LNG_MAX


class UserLocation(BaseModel):
    lat: float
    lng: float
    accuracy_m: Optional[float] = None
    consented: bool = True


class MapAction(BaseModel):
    action_type: Literal["SET_DIRECTIONS", "FLY_TO_LOCATION", "SET_MAP_VIEW", "HIGHLIGHT_KART"]
    coordinates: Optional[List[float]] = None
    label: Optional[str] = None
    start: Optional[Dict[str, Any]] = None
    end: Optional[Dict[str, Any]] = None
    stops: Optional[List[str]] = None
    auto_execute: bool = False


class AgentChatRequest(BaseModel):
    message: str
    history: Optional[List[Dict[str, Any]]] = None
    last_entity: Optional[Dict[str, Any]] = None
    user_location: Optional[UserLocation] = None


class LocationCard(BaseModel):
    title: str
    subtitle: Optional[str] = None
    location: Optional[str] = None
    code: Optional[str] = None
    hours: Optional[str] = None
    category: Optional[str] = None


class AgentChatResponse(BaseModel):
    reply: str
    location_card: Optional[LocationCard] = None
    actions: List[MapAction] = []
    suggestions: List[str] = []
    last_entity: Optional[Dict[str, Any]] = None


# Intent classification patterns
EXPLICIT_NAV_PATTERNS = [
    r"\b(?:i\s+want\s+to\s+go(?:\s+to)?|want\s+to\s+go(?:\s+to)?|i\s+wanna\s+go(?:\s+to)?|wanna\s+go(?:\s+to)?|go\s+to|going\s+to|head\s+to|heading\s+to|take\s+me(?:\s+to|\s+there)?|navigate(?:\s+to)?|directions?(?:\s+(?:to|for))?|how\s+to\s+reach|how\s+do\s+i\s+(?:get|reach|go)(?:\s+to)?|how\s+can\s+i\s+(?:get|reach|go)(?:\s+to)?|route(?:\s+to|\s+of)|guide\s+me(?:\s+to)?|lead\s+me(?:\s+to)?|walk\s+to|path\s+to)\b",
    r"\b(?:show\s+(?:me\s+)?(?:where\s+(?:is|are)\s+)?|show\s+(?:it\s+)?on\s+map|open\s+map|view\s+on\s+map|locate\s+on\s+map|map\s+view)\b"
]

LOC_SEEKING_PATTERNS = [
    r"\b(?:where\s+(?:is|are|can\s+i\s+find)|how\s+(?:to\s+(?:reach|find|get\s+to)|can\s+i\s+(?:find|reach|get\s+to))|location\s+of|find\s+(?:the\s+)?|which\s+block\s+is|show\s+on\s+map|view\s+on\s+map|show\s+me\s+where)\b",
    r"\b(?:i\s+want\s+to\s+go(?:\s+to)?|want\s+to\s+go(?:\s+to)?|go\s+to|reach|find|locate)\b"
]

ANAPHORIC_PATTERNS = [
    r"\b(there|it|that place|that block|that building|his cabin|her cabin|their cabin|directions to it|take me there|navigate there|how to reach there|route to it|where is it located|show it on map)\b"
]

TOPIC_SHIFT_PATTERNS = [
    r"\b(?:what about|how about|where is|tell me about|take me to|show me|find|locate|who is|where does)\b"
]

GREETING_PATTERNS = [
    r"^(?:hi|hello|hey|hlo|heya|howdy|sup|greetings|namaste|namaskar|pranam|good\s+(?:morning|afternoon|evening|day))[\s!.,?]*$"
]

FILLER_PATTERNS = [
    r"^(?:h+m+|u+h+|u+m+|thinking|wait|well|ok|okay|k|alright|cool|got\s+it|understood|sure|sounds\s+good|done|fine|perfect)[\s!.,?]*$"
]


def is_explicit_nav_request(text: str) -> bool:
    clean = text.strip().lower()
    return any(re.search(pat, clean) for pat in EXPLICIT_NAV_PATTERNS)


def is_location_seeking_query(text: str) -> bool:
    clean = text.strip().lower()
    return any(re.search(pat, clean) for pat in LOC_SEEKING_PATTERNS)


def is_location_proximity_query(text: str) -> bool:
    clean = text.strip().lower()
    return bool(re.search(
        r"\b(?:near(?:\s+by|\s+me)?|closest(?:\s+to\s+me|\s+to\s+my\s+location)?|nearest(?:\s+to\s+me|\s+to\s+my\s+location)?|around\s+(?:me|my\s+location)|nearest\s+one|closest\s+one|nearby)\b",
        clean,
        re.I
    ))


def get_multi_entity_candidates(query: str, dl: CampusDataLoader) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    Detects facility types with multiple matching locations in data.js
    (e.g., auditoriums, tuck shops, main gates, boys apartments, medical facilities).
    """
    q = query.strip().lower()

    # 1. Auditoriums
    if re.search(r"\b(auditorium|auditoriums|audi)\b", q):
        if not any(specific in q for specific in ["shanti", "devi", "baldev", "baldevraj", "unipolis"]):
            auds = [
                loc for loc in dl.locations
                if loc.get("id") in ["sh-baldevraj-mittal-auditorium", "shanti-devi-mittal-auditorium", "unipolis"]
            ]
            if auds:
                return auds, "auditorium"

    # 2. Stationery Tuck Shops
    if re.search(r"\b(tuck\s*shops?|stationery\s*shops?)\b", q):
        if not re.search(r"\b(block\s*\d+|b\d+)\b", q):
            shops = [loc for loc in dl.locations if loc.get("type") == "Stationery Tuck Shop"]
            if shops:
                return shops, "stationery tuck shop"

    # 3. Main Gates
    if re.search(r"\b(main\s+gate|campus\s+gate|entry\s+gate|gates?)\b", q):
        if not any(w in q for w in ["student", "vehicle", "car", "bike"]):
            gates = [loc for loc in dl.locations if "main-gate" in loc.get("id", "")]
            if gates:
                return gates, "gate"

    # 4. Boys Apartments
    if re.search(r"\b(boys?\s*apartment|apartments?)\b", q):
        if not any(w in q for w in ["ab", "cd"]):
            apts = [loc for loc in dl.locations if loc.get("type") == "Boys Apartment"]
            if apts:
                return apts, "boys apartment"

    # 5. Medical Facilities
    if re.search(r"\b(medical\s*facility|medical\s*facilities|hospital|clinic|dispensary|health\s*center)\b", q):
        meds = [loc for loc in dl.locations if loc.get("id") == "uni-health-center"]
        if meds:
            return meds, "medical facility"

    return [], None


def is_anaphoric_followup(text: str) -> bool:
    clean = text.strip().lower()
    return any(re.search(pat, clean) for pat in ANAPHORIC_PATTERNS)


def detect_topic_shift(text: str) -> bool:
    clean = text.strip().lower()
    return any(re.search(pat, clean) for pat in TOPIC_SHIFT_PATTERNS)


def is_greeting(text: str) -> bool:
    clean = re.sub(r"[^\w\s]", "", text.strip().lower())
    return any(re.match(pat, clean) for pat in GREETING_PATTERNS)


def is_filler_or_ack(text: str) -> bool:
    clean = re.sub(r"[^\w\s]", "", text.strip().lower())
    return any(re.match(pat, clean) for pat in FILLER_PATTERNS)


def _parse_llm_response(content: str, default_questions: Optional[List[str]] = None) -> Tuple[str, List[str]]:
    """Separates the reply text from the exactly 2 follow-up questions (Q1 and Q2)."""
    raw = content.strip()
    q1 = None
    q2 = None

    q1_match = re.search(
        r"(?:^|\b|\n)(?:q1|q\.1|question\s*1|\[q1\])\s*[:\-\)]\s*(.*?)(?=(?:^|\b|\n)(?:q2|q\.2|question\s*2|\[q2\])\s*[:\-\)]|$)",
        raw,
        re.I | re.DOTALL
    )
    if q1_match:
        q1 = q1_match.group(1).strip()
        q2_match = re.search(
            r"(?:^|\b|\n)(?:q2|q\.2|question\s*2|\[q2\])\s*[:\-\)]\s*(.*?)$",
            raw,
            re.I | re.DOTALL
        )
        if q2_match:
            q2 = q2_match.group(1).strip()
    else:
        m_inline_num = re.search(r"(?:^|\b|\n)1[\.\)]\s+(.+?\?)\s*2[\.\)]\s+(.+?)$", raw, re.DOTALL)
        if m_inline_num:
            q1 = m_inline_num.group(1).strip()
            q2 = m_inline_num.group(2).strip()
        else:
            lines = [l.strip() for l in raw.split("\n") if l.strip()]
            for l in lines:
                m1 = re.match(r"^(?:q1|q\.1|question\s*1|1[\.\)])[:\s\-]+(.*)$", l, re.I)
                m2 = re.match(r"^(?:q2|q\.2|question\s*2|2[\.\)])[:\s\-]+(.*)$", l, re.I)
                if m1 and not q1:
                    q1 = m1.group(1).strip()
                elif m2 and not q2:
                    q2 = m2.group(1).strip()

    # Cut off follow-up indicators from reply body
    reply_cut_patterns = [
        r"(?:\n\s*|\A\s*)(?:suggested\s+|follow[\-\s]?up\s+)+questions?[:\s\-]*",
        r"(?:\n\s*|\A\s*)(?:q1|q\.1|question\s*1|\[q1\])\s*[:\-\)]",
        r"(?:\n\s*)(?:1[\.\)]\s+[^?\n]+\?\s*\n\s*2[\.\)]\s+[^?\n]+\?)",
    ]
    raw_reply = raw
    for pat in reply_cut_patterns:
        parts = re.split(pat, raw_reply, maxsplit=1, flags=re.I)
        if len(parts) > 1 and len(parts[0].strip()) > 10:
            raw_reply = parts[0].strip()

    raw_reply = re.sub(r"^(?:reply|assistant|response|answer)\b[:\s\-]*", "", raw_reply, flags=re.I).strip()
    raw_reply = re.sub(r"(?:\n\s*)(?:suggested\s+|follow[\-\s]?up\s+)+questions?[\s\:]*$", "", raw_reply, flags=re.I).strip()
    raw_reply = re.sub(r"(?:\n\s*)(?:q1|q2|question\s*1|question\s*2)\b.*$", "", raw_reply, flags=re.I | re.DOTALL).strip()

    clean_reply = _clean_coordinates_from_text(raw_reply)

    def clean_q(q_str: Optional[str]) -> Optional[str]:
        if not q_str:
            return None
        q = q_str.strip().split("\n")[0].strip().strip('"\'')
        if not q.endswith("?"):
            q += "?"
        words = q.split()
        if len(words) < 2 or len(words) > 12:
            return None
        return q

    final_questions = []
    cq1 = clean_q(q1)
    if cq1:
        final_questions.append(cq1)
    cq2 = clean_q(q2)
    if cq2 and cq2 != cq1:
        final_questions.append(cq2)

    if len(final_questions) < 2 and default_questions:
        for dq in default_questions:
            if len(final_questions) >= 2:
                break
            if dq not in final_questions:
                final_questions.append(dq)

    return clean_reply, final_questions[:2]


def generate_dynamic_reply(
    user_query: str,
    context_records: List[Dict[str, Any]],
    match_quality: str,
    history: Optional[List[Dict[str, Any]]] = None,
    default_questions: Optional[List[str]] = None
) -> Tuple[str, List[str]]:
    """
    Generates response dynamically via Gemini when online;
    falls back cleanly to existing offline response when Gemini is offline.
    """
    client = gemini_client.get_client()
    if client is not None:
        try:
            raw_reply = gemini_client.generate_reply(
                question=user_query,
                context_records=context_records,
                match_quality=match_quality,
                history=history
            )
            if raw_reply and len(raw_reply.strip()) > 5:
                return _parse_llm_response(raw_reply, default_questions)
        except Exception as e:
            logger.warning(f"[Agent] Online Gemini generation failed: {e}. Using offline fallback.")

    # Offline fallback (Preserved from gemini_client._format_grounded_fallback)
    offline_reply = gemini_client._format_grounded_fallback(user_query, context_records, match_quality)
    fallback_qs = default_questions[:2] if default_questions else ["Where is the Central Library?", "Where is Block 34?"]
    return offline_reply, fallback_qs


# Multi-point routing helpers
def resolve_location_token(token: str, dl: CampusDataLoader) -> Optional[Tuple[List[float], str, str]]:
    """Resolves a place token into (coords, label, type)."""
    clean = token.strip()
    if not clean:
        return None
    clean_lower = clean.lower()
    clean_lower = re.sub(r"^(?:the|to|from|towards|at|block)\s+", "", clean_lower).strip()

    # 1. Match numeric or block string
    m = re.search(r"\bblock[-_ ]*(\d+)\b", token, re.I)
    if not m and token.strip().isdigit():
        m = re.search(r"(\d+)", token.strip())
    if m:
        b_num = m.group(1).lower()
        b_info = dl.get_block(b_num)
        if b_info and b_info.get("coordinates"):
            return (b_info["coordinates"], b_info["name"], "block")

    # 1b. Match hostels
    h_info = dl.get_hostel_info(clean)
    if h_info and h_info.get("coordinates"):
        return (h_info["coordinates"], h_info["name"], "hostel")

    # 1c. Health Center variations
    clean_no_space = re.sub(r"[\s\-_]+", "", clean_lower)
    if clean_no_space in ["unihealth", "healthcenter", "hospital", "clinic", "dispensary", "medicalcenter"]:
        return ([31.25812, 75.706749], "Uni Health Center", "locations")

    candidates = (
        [("CAMPUS_LOCATIONS", record) for record in dl.locations] +
        [("CAMPUS_OFFICES", record) for record in dl.offices] +
        [("CAMPUS_PERSONS", record) for record in dl.persons] +
        [("CAMPUS_GROUPS", record) for record in dl.groups]
    )
    for source, record in candidates:
        aliases = [
            str(record.get("id", "")),
            str(record.get("name", "")),
            *[str(tag) for tag in record.get("tags", [])],
        ]
        for alias in aliases:
            if not alias:
                continue
            a_lower = alias.lower()
            if clean_lower == a_lower or clean_lower in a_lower or a_lower in clean_lower:
                coords = (
                    record.get("coordinates")
                    or record.get("centerCoords")
                    or record.get("coords")
                )
                if not coords and record.get("lat") and record.get("lng"):
                    coords = [record["lat"], record["lng"]]
                if coords:
                    return (coords, record.get("name", clean), source)
    return None


def extract_navigation_route_via_llm(msg: str) -> Optional[Dict[str, Any]]:
    client = gemini_client.get_client()
    if client is None:
        return None
    try:
        cfg_kwargs: Dict[str, Any] = {
            "system_instruction": (
                "You are a campus navigation intent parser for Lovely Professional University (LPU). "
                "Analyze the user's message and determine if they are requesting navigation, directions, a path, or a route from one location to another. "
                "Extract the origin location, the destination location, and any intermediate stops mentioned. "
                "Return JSON ONLY: {\"is_navigation\": bool, \"origin\": str or null, \"destination\": str or null, \"stops\": []} "
                "Do not invent locations. If the user mentions starting from 'my location', 'here', or 'current location', set origin to 'Your Location'."
            )
        }
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

        resp = client.models.generate_content(
            model=gemini_client.GENERATION_MODEL,
            contents=f"Extract navigation intent: \"{msg}\"",
            config=types.GenerateContentConfig(**cfg_kwargs)
        )
        if resp and resp.text:
            raw = re.sub(r"^```(?:json)?\s*", "", resp.text.strip(), flags=re.M)
            raw = re.sub(r"\s*```$", "", raw, flags=re.M).strip()
            parsed = json.loads(raw)
            if parsed.get("is_navigation") and (parsed.get("destination") or parsed.get("origin")):
                return parsed
    except Exception as e:
        logger.debug(f"[Agent] LLM Route extraction skipped: {e}")
    return None


def extract_navigation_route(msg: str, dl: CampusDataLoader, user_location: Optional[UserLocation]) -> Optional[Dict[str, Any]]:
    clean = msg.strip()
    clean_lower = clean.lower()

    # Regex heuristic for fast matching
    m = re.search(
        r"(?:from\s+([^,]+?)\s+to\s+([^,]+?)(?:\s+via\s+([^,]+))?|direction(?:s)?\s+of\s+([^,]+?)\s+to\s+([^,]+)|route\s+from\s+([^,]+?)\s+to\s+([^,]+)|how\s+to\s+reach\s+([^,]+?)\s+from\s+([^,]+))(?=$|[?.!])",
        clean_lower
    )
    if m:
        groups = m.groups()
        orig_str, dest_str, via_str = "", "", ""
        if groups[0] and groups[1]:
            orig_str, dest_str, via_str = groups[0], groups[1], groups[2] or ""
        elif groups[3] and groups[4]:
            orig_str, dest_str = groups[3], groups[4]
        elif groups[5] and groups[6]:
            orig_str, dest_str = groups[5], groups[6]
        elif groups[7] and groups[8]:
            dest_str, orig_str = groups[7], groups[8]

        orig_res = resolve_location_token(orig_str, dl) if orig_str else None
        dest_res = resolve_location_token(dest_str, dl) if dest_str else None

        if orig_str and any(k in orig_str.lower() for k in ["my location", "current location", "here", "where i am"]):
            if user_location:
                orig_res = ([user_location.lat, user_location.lng], "Your Location", "gps")

        if orig_res and dest_res:
            stops_list = []
            if via_str:
                v_res = resolve_location_token(via_str, dl)
                stops_list.append(v_res[1] if v_res else via_str.strip())
            return {
                "origin": orig_res,
                "destination": dest_res,
                "stops": stops_list
            }

    # Fallback to LLM parser if phrasing was conversational
    has_nav_phrase = bool(re.search(
        r"\b(?:route|directions?|navigate|navigation|how to (?:go|reach|walk|get)|way to|path to|take me to|walk to|reach|head over to|get to)\b",
        clean_lower
    ))
    if has_nav_phrase:
        llm_nav = extract_navigation_route_via_llm(clean)
        if llm_nav:
            raw_orig = (llm_nav.get("origin") or "").strip()
            raw_dest = (llm_nav.get("destination") or "").strip()
            raw_stops = llm_nav.get("stops") or []

            orig_resolved = resolve_location_token(raw_orig, dl) if raw_orig else None
            dest_resolved = resolve_location_token(raw_dest, dl) if raw_dest else None

            if raw_orig and any(k in raw_orig.lower() for k in ["my location", "current location", "here", "where i am"]):
                if user_location:
                    orig_resolved = ([user_location.lat, user_location.lng], "Your Location", "gps")

            if not orig_resolved and user_location and dest_resolved:
                orig_resolved = ([user_location.lat, user_location.lng], "Your Location", "gps")

            if orig_resolved and dest_resolved:
                stops_list = []
                for s_tok in raw_stops:
                    s_res = resolve_location_token(str(s_tok).strip(), dl)
                    stops_list.append(s_res[1] if s_res else str(s_tok).strip())
                return {
                    "origin": orig_resolved,
                    "destination": dest_resolved,
                    "stops": stops_list
                }
    return None


def extract_entity_from_history(history: List[Dict[str, Any]], dl: CampusDataLoader) -> Optional[Dict[str, Any]]:
    """Recovers the most recently mentioned campus entity from conversation history."""
    if not history:
        return None
    for turn in reversed(history):
        content = turn.get("content", "")
        if not content:
            continue
        if re.search(r"\b(?:health\s*center|clinic|dispensary|hospital|doctor|first\s*aid)\b", content, re.I):
            return {"name": "Uni Health Center", "coordinates": [31.25812, 75.706749], "category": "healthcare"}
        if re.search(r"\b(?:boys?\s*hostel|girls?\s*hostel|residential\s*area|bh\s*[-_ ]?[1-6]|bs\s*[-_ ]?1[1-3]|gh\s*[-_ ]?[1-4]|gs\s*[-_ ]?1[1-2])\b", content, re.I):
            if re.search(r"\bgirls?\s*hostel|gh\b", content, re.I):
                return {"name": "Girls Residential Area", "coordinates": [31.2568, 75.7049], "category": "hostels"}
            return {"name": "Residential Area (Boys Hostels)", "coordinates": [31.249742, 75.703481], "category": "hostels"}
        if re.search(r"\b(?:central\s*library|library|reading\s*hall)\b", content, re.I):
            return {"name": "Central Library", "coordinates": [31.2541, 75.7032], "category": "study"}
        if re.search(r"\b(?:unimall|mall|food\s*court)\b", content, re.I):
            return {"name": "UniMall", "coordinates": [31.255736, 75.705318], "category": "food"}
        m = re.search(r"\b(?:block[-_ ]?)(\d+)\b", content, re.I)
        if m:
            b_num = m.group(1)
            b_info = dl.get_block(b_num)
            if b_info and b_info.get("coordinates"):
                return {"name": f"Block {b_num}", "coordinates": b_info["coordinates"], "block_number": b_num}
    return None


def run_campus_agent(
    message: str,
    user_location: Optional[UserLocation] = None,
    last_entity: Optional[Dict[str, Any]] = None,
    history: Optional[List[Dict[str, Any]]] = None
) -> AgentChatResponse:
    """
    Autonomous AI Campus Agent for LPUNavix.
    Online: Dynamically generates conversational & grounded answers via Gemini.
    Offline: Reverts to deterministic grounded fallbacks.
    Zero prebuilt conversational responses in agent.py.
    """
    dl = get_campus_data_loader()
    vs = get_campus_vector_store()
    msg = message.strip()
    msg_lower = msg.lower()

    if not msg:
        return AgentChatResponse(
            reply="Hey there! Welcome to LPUNavix. What campus building, faculty cabin, hostel, or service can I help you find today? 🏢📍",
            suggestions=["Where is Block 34?", "Where is the Central Library?"]
        )

    is_explicit_nav = is_explicit_nav_request(msg)
    is_loc_seeking = is_location_seeking_query(msg)
    should_auto_fly = False

    # Recover last_entity from conversation history if missing
    if last_entity is None and history:
        last_entity = extract_entity_from_history(history, dl)

    actions: List[MapAction] = []
    loc_card: Optional[LocationCard] = None
    new_entity: Optional[Dict[str, Any]] = last_entity
    context_records: List[Dict[str, Any]] = []
    match_quality: str = "none"
    default_questions: List[str] = ["Where is the Central Library?", "Where is Block 34?"]

    # -----------------------------------------------------------------------
    # 1. Multi-Point Navigation Route Intent
    # -----------------------------------------------------------------------
    route_data = extract_navigation_route(msg, dl, user_location)
    if route_data:
        orig = route_data["origin"]
        dest = route_data["destination"]
        stops = route_data.get("stops", [])
        orig_coords = orig[0]
        dest_coords = dest[0]
        orig_label = orig[1]
        dest_label = dest[1]

        actions.append(MapAction(
            action_type="SET_DIRECTIONS",
            start={"lat": orig_coords[0], "lng": orig_coords[1], "label": orig_label},
            end={"lat": dest_coords[0], "lng": dest_coords[1], "label": dest_label},
            stops=stops,
            label=dest_label,
            auto_execute=False
        ))
        loc_card = LocationCard(
            title=dest_label,
            subtitle="Destination",
            location=f"{dest_label}, LPU Campus",
            category="route"
        )
        context_records = [{
            "name": dest_label,
            "origin": orig_label,
            "destination": dest_label,
            "stops": stops,
            "desc": f"Walking route navigation from {orig_label} to {dest_label}."
        }]
        match_quality = "confident"
        default_questions = [f"How far is {dest_label}?", "Show landmarks along the route"]
        new_entity = {"name": dest_label, "coordinates": dest_coords}

        reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
        return AgentChatResponse(
            reply=reply,
            location_card=loc_card,
            actions=actions,
            suggestions=questions,
            last_entity=new_entity
        )

    # -----------------------------------------------------------------------
    # 2. Pure Conversational / Fillers / Acknowledgments
    # -----------------------------------------------------------------------
    # If the user says hello, thanks, bye, ok, hmm without mentioning a location,
    # let Gemini converse dynamically without forcing any campus location card.
    if is_greeting(msg) or is_filler_or_ack(msg):
        reply, questions = generate_dynamic_reply(msg, [], "none", history, default_questions)
        return AgentChatResponse(
            reply=reply,
            location_card=None,
            actions=[],
            suggestions=questions,
            last_entity=last_entity
        )

    # -----------------------------------------------------------------------
    # 3. Lost Property / Lost and Found Services
    # -----------------------------------------------------------------------
    has_lost_item = bool(re.search(
        r"\b(?:item|items|thing|things|belonging|belongings|stuff|pen|pens|pencil|pencils|notebook|notebooks|book|books|bag|bags|backpack|wallet|wallets|purse|phone|phones|mobile|keys?|id\s*card|cards?|laptop|laptops|bottle|water\s*bottle|charger|earphones|headphones|airpods|watch|watches|specs|glasses|umbrella|jacket|calculator|documents?|file|anything|something)\b",
        msg_lower
    ))
    has_lost_found_keyword = bool(re.search(
        r"\b(?:lost\s+(?:and|&)\s+found|lost\s+property|found\s+(?:an?\s+)?item|report\s+(?:a\s+)?lost|lost\s+desk|lost\s+counter|lost\s+office|lost\s+and\s+found\s+office)\b",
        msg_lower
    ))
    is_lost_property = has_lost_found_keyword or (
        has_lost_item and any(w in msg_lower for w in ["lost", "misplaced", "left", "forgot", "forgotten", "dropped", "found"])
    ) or ("lost" in msg_lower and any(w in msg_lower for w in ["claim", "recover", "submit", "report", "retrieve"]))

    if is_lost_property:
        office = dl.find_lost_and_found()
        if office and office.get("coordinates"):
            coords = office["coordinates"]
            floor_str = office.get("floor", "Second Floor, Room 209")
            name = office.get("name", "Administrative Office")
            actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=coords, label=name, auto_execute=False))
            actions.append(MapAction(
                action_type="SET_DIRECTIONS",
                start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
                end={"lat": coords[0], "lng": coords[1], "label": name},
                label=name,
                auto_execute=False
            ))
            loc_card = LocationCard(
                title=name,
                subtitle="Lost and Found Services",
                location=f"Block 28, {floor_str}, LPU Campus",
                hours=office.get("hours", "8:00 AM - 5:30 PM"),
                category="offices"
            )
            context_records = [office]
            match_quality = "confident"
            default_questions = ["How do I get to Block 28?", "What are the office timings?"]
            new_entity = {"name": name, "coordinates": coords, "category": "offices"}

            reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
            return AgentChatResponse(
                reply=reply,
                location_card=loc_card,
                actions=actions,
                suggestions=questions,
                last_entity=new_entity
            )

    # -----------------------------------------------------------------------
    # 4. Physically Lost Assistance (Campus Navigation / Orientation)
    # -----------------------------------------------------------------------
    is_physically_lost = not is_lost_property and (
        bool(re.search(r"\b(?:i(?:'m|\s+am)?(?:\s+(?:completely|totally|really|so))?\s+lost|lost\s+my\s+way|lost\s+on\s+campus|where\s+am\s+i|don'?t\s+know\s+where\s+i\s+am|help\s+me\s+i\s+am\s+lost|i\s+got\s+lost)\b", msg_lower))
        or ("lost" in msg_lower and any(w in msg_lower for w in ["i am", "i'm", "im", "my way", "where am i", "help me", "on campus", "got lost"]))
        or msg_lower.strip() in ["lost", "i'm lost", "im lost"]
    )
    if is_physically_lost:
        context_records = [{
            "name": "Campus Orientation",
            "desc": (
                "The user is lost on the Lovely Professional University (LPU) campus. "
                "Academic blocks range from Block 1 to 38. Key landmarks include UniMall (shopping & food court), "
                "Central Library (along central pathway), and Unipolis (indoor event arena). "
                "Reassure the user warmly and invite them to share what nearby building or landmark they see, "
                "or suggest tapping the GPS location button on the map."
            )
        }]
        default_questions = ["Where is UniMall?", "Where is the Central Library?"]
        reply, questions = generate_dynamic_reply(msg, context_records, "none", history, default_questions)
        return AgentChatResponse(
            reply=reply,
            location_card=None,
            actions=[],
            suggestions=questions,
            last_entity=last_entity
        )

    # -----------------------------------------------------------------------
    # 5. Stationery & Supplies Purchase
    # -----------------------------------------------------------------------
    buy_pen_query = bool(re.search(
        r"\b(?:where\s+can\s+i\s+(?:buy|get|purchase)|where\s+to\s+buy|buy|purchase|shop\s+for)\s+(?:a\s+)?(?:pen|pens|stationery|pencil|pencils|notebooks?|books?|paper)\b|\b(?:stationery\s+shop|tuck\s+shop|need\s+a\s+pen|where\s+to\s+get\s+pens?)\b",
        msg_lower
    ))
    if buy_pen_query:
        stationery_options = dl.find_stationery()
        primary_shop = next((s for s in stationery_options if "26" in s.get("id", "")), stationery_options[0] if stationery_options else None)
        coords = primary_shop.get("coordinates") if primary_shop else [31.25263, 75.702895]
        actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=coords, label="Stationery Tuck Shop (Block 26)", auto_execute=False))
        actions.append(MapAction(
            action_type="SET_DIRECTIONS",
            start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
            end={"lat": coords[0], "lng": coords[1], "label": "Stationery Tuck Shop (Block 26)"},
            label="Stationery Tuck Shop (Block 26)",
            auto_execute=False
        ))
        loc_card = LocationCard(
            title="Stationery Tuck Shop",
            subtitle="Basement Tuck Shop (Block 26)",
            location="Block 26 (Basement), LPU Campus",
            hours="8:00 AM - 5:30 PM",
            category="offices"
        )
        context_records = stationery_options + [{"name": "UniMall", "desc": "Retail stationery stores inside UniMall."}]
        match_quality = "confident"
        default_questions = ["Where is Block 26 located?", "Where is UniMall located?"]
        new_entity = {"name": "Stationery Tuck Shop (Block 26)", "coordinates": coords, "category": "offices"}

        reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
        return AgentChatResponse(
            reply=reply,
            location_card=loc_card,
            actions=actions,
            suggestions=questions,
            last_entity=new_entity
        )

    # -----------------------------------------------------------------------
    # 6. List of All HODs
    # -----------------------------------------------------------------------
    is_all_hods_query = bool(re.search(
        r"\b(list\s+(?:of\s+)?(?:all\s+)?hods?|all\s+hods?|who\s+are\s+(?:all\s+)?(?:the\s+)?hods?|hod\s+list|names\s+of\s+(?:all\s+)?hods?|give\s+me\s+(?:the\s+)?list\s+of\s+all\s+hods?|show\s+(?:all\s+)?hods?)\b",
        msg_lower
    ))
    if is_all_hods_query:
        all_hods = dl.get_all_hods()
        context_records = [
            {
                "name": h["name"],
                "role": h.get("role", "Head of Department"),
                "department": h.get("department"),
                "location": f"Block {h.get('block')}, Room {h.get('room')}, Cabin {h.get('cabin')}",
                "notation": h.get("notation")
            }
            for h in all_hods
        ]
        match_quality = "confident"
        default_questions = ["Where is Block 34?", "Who is the Dean of CSE?"]
        reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
        return AgentChatResponse(
            reply=reply,
            location_card=None,
            actions=[],
            suggestions=questions,
            last_entity=last_entity
        )

    # -----------------------------------------------------------------------
    # 6b. Multiple Matching Locations & Location-Aware Proximity Handling
    # -----------------------------------------------------------------------
    is_proximity = is_location_proximity_query(msg)
    cands, facility_kind = get_multi_entity_candidates(msg, dl)

    if cands:
        if len(cands) > 1:
            if is_proximity:
                # User explicitly asks for nearest/closest facility
                if user_location and user_location.lat and user_location.lng:
                    scored_cands = []
                    for c in cands:
                        c_coords = c.get("coordinates") or [c.get("lat"), c.get("lng")]
                        dist = haversine_distance_m(user_location.lat, user_location.lng, c_coords[0], c_coords[1])
                        scored_cands.append((c, dist, c_coords))
                    scored_cands.sort(key=lambda x: x[1])
                    nearest_item, nearest_dist, nearest_coords = scored_cands[0]

                    actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=nearest_coords, label=nearest_item["name"], auto_execute=False))
                    actions.append(MapAction(
                        action_type="SET_DIRECTIONS",
                        start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"},
                        end={"lat": nearest_coords[0], "lng": nearest_coords[1], "label": nearest_item["name"]},
                        label=nearest_item["name"],
                        auto_execute=False
                    ))
                    loc_card = LocationCard(
                        title=nearest_item["name"],
                        subtitle=f"Nearest {facility_kind.title()} (~{round(nearest_dist)}m away)",
                        location=nearest_item.get("floor") or "LPU Campus",
                        hours=nearest_item.get("hours", "Open on Campus Schedule"),
                        category=nearest_item.get("category", "locations")
                    )
                    context_records = [
                        {
                            "user_location_provided": True,
                            "nearest_facility": nearest_item["name"],
                            "nearest_distance_meters": round(nearest_dist),
                            "nearest_details": nearest_item.get("desc") or nearest_item.get("floor"),
                            "all_options_ranked_by_distance": [
                                f"{item['name']}: ~{round(d)} meters away ({item.get('floor') or 'Campus'})"
                                for item, d, _ in scored_cands
                            ],
                            "guidance": (
                                f"The user asked for the closest/nearest {facility_kind}. "
                                f"Confirm that based on their current location, {nearest_item['name']} is the nearest "
                                f"(~{round(nearest_dist)} meters away). Also briefly mention the other available {facility_kind} facilities."
                            )
                        }
                    ]
                    default_questions = [f"Directions to {nearest_item['name']}", f"About {scored_cands[1][0]['name']}"]
                    new_entity = {"name": nearest_item["name"], "coordinates": nearest_coords}
                    reply, questions = generate_dynamic_reply(msg, context_records, "confident", history, default_questions)
                    return AgentChatResponse(
                        reply=reply,
                        location_card=loc_card,
                        actions=actions,
                        suggestions=questions,
                        last_entity=new_entity
                    )
                else:
                    # User asked for nearest, but user_location is not available
                    context_records = [
                        {
                            "user_location_provided": False,
                            "facility_type": facility_kind,
                            "available_options": [
                                {"name": c["name"], "location": c.get("floor") or c.get("desc")}
                                for c in cands
                            ],
                            "guidance": (
                                f"The user asked for the closest/nearest {facility_kind}, but their current location access is unavailable. "
                                f"Do NOT fabricate distances or claim one is nearest. "
                                f"Explain politely that location access is required to compute proximity, and list all {len(cands)} "
                                f"available {facility_kind} options with their actual building locations."
                            )
                        }
                    ]
                    default_questions = [c["name"] for c in cands[:2]]
                    reply, questions = generate_dynamic_reply(msg, context_records, "confident", history, default_questions)
                    return AgentChatResponse(
                        reply=reply,
                        location_card=None,
                        actions=[],
                        suggestions=questions,
                        last_entity=last_entity
                    )
            else:
                # User asked a generic or count query WITHOUT proximity keywords (e.g. "Where is the auditorium?" or "How many auditoriums are there?")
                # Must NOT automatically use location or pick one arbitrarily!
                is_count_query = bool(re.search(r"\b(?:how\s+many|count|number\s+of|total)\b", msg_lower))
                context_records = [
                    {
                        "multiple_matching_facilities": True,
                        "facility_type": facility_kind,
                        "count": len(cands),
                        "available_options": [
                            {"name": c["name"], "description": c.get("desc"), "location_details": c.get("floor")}
                            for c in cands
                        ],
                        "is_count_query": is_count_query,
                        "guidance": (
                            f"LPU has {len(cands)} distinct {facility_kind} facilities on campus: {', '.join([c['name'] for c in cands])}. "
                            + (
                                f"The user is asking for the count. State clearly that there are {len(cands)} {facility_kind} facilities and list them."
                                if is_count_query else
                                f"Clearly present all available options using their exact campus names and distinguish them by their location/purpose. Ask the user which one they mean. Do NOT select one arbitrarily."
                            )
                        )
                    }
                ]
                default_questions = [f"Where is {c['name']}?" for c in cands[:2]]
                reply, questions = generate_dynamic_reply(msg, context_records, "confident", history, default_questions)
                return AgentChatResponse(
                    reply=reply,
                    location_card=None,
                    actions=[],
                    suggestions=[c["name"] for c in cands[:3]],
                    last_entity=last_entity
                )
        elif len(cands) == 1 and is_proximity:
            # Single candidate with proximity request (e.g., medical facility)
            item = cands[0]
            item_coords = item.get("coordinates") or [item.get("lat"), item.get("lng")]
            if user_location and user_location.lat and user_location.lng:
                dist = haversine_distance_m(user_location.lat, user_location.lng, item_coords[0], item_coords[1])
                actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=item_coords, label=item["name"], auto_execute=False))
                actions.append(MapAction(
                    action_type="SET_DIRECTIONS",
                    start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"},
                    end={"lat": item_coords[0], "lng": item_coords[1], "label": item["name"]},
                    label=item["name"],
                    auto_execute=False
                ))
                loc_card = LocationCard(
                    title=item["name"],
                    subtitle=f"Medical Facility (~{round(dist)}m away)",
                    location=item.get("floor") or "Block 28 (Room 209), LPU Campus",
                    hours=item.get("hours", "Open on Campus Schedule"),
                    category="healthcare"
                )
                context_records = [
                    {
                        "facility_name": item["name"],
                        "user_location_provided": True,
                        "distance_meters": round(dist),
                        "location": item.get("floor") or "Block 28, Room 209",
                        "description": item.get("desc"),
                        "facilities": item.get("facilities")
                    }
                ]
                default_questions = [f"Directions to {item['name']}", "What are the clinic timings?"]
                reply, questions = generate_dynamic_reply(msg, context_records, "confident", history, default_questions)
                return AgentChatResponse(
                    reply=reply,
                    location_card=loc_card,
                    actions=actions,
                    suggestions=questions,
                    last_entity={"name": item["name"], "coordinates": item_coords}
                )
            else:
                context_records = [
                    {
                        "facility_name": item["name"],
                        "user_location_provided": False,
                        "location": item.get("floor") or "Block 28, Room 209",
                        "description": item.get("desc"),
                        "guidance": (
                            f"The user asked for the closest {facility_kind}, but location access is not provided. "
                            f"State that {item['name']} in {item.get('floor', 'Block 28')} is the campus facility, "
                            f"and note that location access is needed to compute distance."
                        )
                    }
                ]
                default_questions = [f"Where is {item['name']}?", "What services are provided?"]
                reply, questions = generate_dynamic_reply(msg, context_records, "confident", history, default_questions)
                return AgentChatResponse(
                    reply=reply,
                    location_card=LocationCard(
                        title=item["name"],
                        subtitle="Campus Healthcare Facility",
                        location=item.get("floor") or "Block 28 (Room 209), LPU Campus",
                        hours=item.get("hours", "Open on Campus Schedule"),
                        category="healthcare"
                    ),
                    actions=[],
                    suggestions=questions,
                    last_entity={"name": item["name"], "coordinates": item_coords}
                )

    # -----------------------------------------------------------------------
    # 7. Concept Intent (Healthcare, Food, ATMs, Study, Computing)
    # -----------------------------------------------------------------------
    concept = dl.resolve_concept_intent(msg)
    if concept:
        c_id = concept["id"]
        if c_id == "concept_sick":
            health_coords = [31.25812, 75.706749]
            actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=health_coords, label="Uni Health Center", auto_execute=False))
            actions.append(MapAction(
                action_type="SET_DIRECTIONS",
                start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
                end={"lat": health_coords[0], "lng": health_coords[1], "label": "Uni Health Center"},
                label="Uni Health Center",
                auto_execute=False
            ))
            loc_card = LocationCard(
                title="Uni Health Center",
                subtitle="Healthcare Services",
                location="Block 28 (Room 209), LPU Campus",
                hours="Open on Campus Schedule",
                category="healthcare"
            )
            is_blood = bool(re.search(r"\bblood\b", msg_lower))
            desc = "Uni Health Center in Block 28 (Room 209). Provides outpatient doctor consultations, first aid, emergency treatment, and medical assistance."
            if is_blood:
                desc += " Note: Campus records do not specify a laboratory blood testing facility on campus."
            context_records = [{"name": "Uni Health Center", "location": "Block 28, Room 209", "desc": desc}]
            match_quality = "confident"
            default_questions = ["How do I reach the Uni Health Center?", "What are the medical center timings?"]
            new_entity = {"name": "Uni Health Center", "coordinates": health_coords, "category": "healthcare"}

            reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
            return AgentChatResponse(
                reply=reply,
                location_card=loc_card,
                actions=actions,
                suggestions=questions,
                last_entity=new_entity
            )

        elif c_id == "concept_food":
            unimall_coords = [31.255736, 75.705318]
            actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=unimall_coords, label="UniMall", auto_execute=False))
            actions.append(MapAction(
                action_type="SET_DIRECTIONS",
                start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
                end={"lat": unimall_coords[0], "lng": unimall_coords[1], "label": "UniMall"},
                label="UniMall",
                auto_execute=False
            ))
            loc_card = LocationCard(
                title="UniMall",
                subtitle="Shopping Mall & Food Court",
                location="Central Campus, LPU",
                hours="Open on Campus Schedule",
                category="food"
            )
            context_records = [
                {"name": "UniMall Food Court", "desc": "Central food court, multi-cuisine restaurants, bakeries, and cafes on campus."},
                {"name": "Basement Tuck Shops", "desc": "Quick snacks and drinks at basement tuck shops in Blocks 26, 27, 28, and 36."}
            ]
            match_quality = "confident"
            default_questions = ["Where is UniMall located?", "What food options are in UniMall?"]
            new_entity = {"name": "UniMall", "coordinates": unimall_coords, "category": "food"}

            reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
            return AgentChatResponse(
                reply=reply,
                location_card=loc_card,
                actions=actions,
                suggestions=questions,
                last_entity=new_entity
            )

        elif c_id == "concept_study":
            lib_coords = [31.2541, 75.7032]
            actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=lib_coords, label="Central Library", auto_execute=False))
            actions.append(MapAction(
                action_type="SET_DIRECTIONS",
                start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
                end={"lat": lib_coords[0], "lng": lib_coords[1], "label": "Central Library"},
                label="Central Library",
                auto_execute=False
            ))
            loc_card = LocationCard(
                title="Central Library",
                subtitle="Campus Library & Study Area",
                location="Central Pathway, LPU Campus",
                hours="Open on Campus Schedule",
                category="study"
            )
            context_records = [{
                "name": "Central Library",
                "desc": "Central multi-story university library housing print books, digital reference archives, e-library terminals, and study areas. Located along the central campus pathway."
            }]
            match_quality = "confident"
            default_questions = ["Where is the Central Library located?", "What facilities are in the Central Library?"]
            new_entity = {"name": "Central Library", "coordinates": lib_coords, "category": "study"}

            reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
            return AgentChatResponse(
                reply=reply,
                location_card=loc_card,
                actions=actions,
                suggestions=questions,
                last_entity=new_entity
            )

        elif c_id == "concept_cash":
            unimall_coords = [31.255736, 75.705318]
            actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=unimall_coords, label="UniMall ATMs", auto_execute=False))
            loc_card = LocationCard(
                title="UniMall ATMs",
                subtitle="Banking & Cash Withdrawal",
                location="UniMall, LPU Campus",
                hours="24/7 Access",
                category="finance"
            )
            context_records = [{"name": "UniMall ATMs", "desc": "Banking and ATM withdrawal facilities located in and near UniMall and the campus main entrance."}]
            match_quality = "confident"
            default_questions = ["Where is UniMall located?", "How do I reach UniMall from here?"]
            new_entity = {"name": "UniMall ATMs", "coordinates": unimall_coords, "category": "finance"}

            reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
            return AgentChatResponse(
                reply=reply,
                location_card=loc_card,
                actions=actions,
                suggestions=questions,
                last_entity=new_entity
            )

    # -----------------------------------------------------------------------
    # 8. Hostels & Residential Areas
    # -----------------------------------------------------------------------
    is_hostel_query = bool(re.search(
        r"\b(?:hostel|hostels|bh|bs|gh|gs|apartment|apartments|studio|studios|residential\s+area)\b",
        msg_lower
    ))
    if is_hostel_query:
        h_info = dl.get_hostel_info(msg)
        if h_info and h_info.get("coordinates"):
            coords = h_info["coordinates"]
            actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=coords, label=h_info["name"], auto_execute=False))
            actions.append(MapAction(
                action_type="SET_DIRECTIONS",
                start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
                end={"lat": coords[0], "lng": coords[1], "label": h_info["name"]},
                label=h_info["name"],
                auto_execute=False
            ))
            loc_card = LocationCard(
                title=h_info["name"],
                subtitle="Campus Accommodation",
                location=f"{h_info['name']}, LPU Campus",
                hours="24x7 Security & Access",
                category="hostels"
            )
            context_records = [h_info]
            match_quality = "confident"
            default_questions = [f"Where is {h_info['name']} located?", "What facilities are in this hostel?"]
            new_entity = {"name": h_info["name"], "coordinates": coords, "category": "hostels"}
        else:
            is_girls = bool(re.search(r"\b(girls?|gh|gs)\b", msg_lower))
            if is_girls:
                coords = [31.2568, 75.7049]
                name = "Girls Residential Area"
                subtitle = "Girls Hostels & Studios (GH-1 to GH-4, GS-11 to GS-12)"
            else:
                coords = [31.249742, 75.703481]
                name = "Residential Area (Boys Hostels)"
                subtitle = "Boys Hostels & Studios (BH-1 to BH-6, BS-11 to BS-13)"
            actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=coords, label=name, auto_execute=False))
            loc_card = LocationCard(
                title=name,
                subtitle=subtitle,
                location=f"{name}, LPU Campus",
                hours="24x7 Access & Security",
                category="hostels"
            )
            context_records = [{"name": name, "subtitle": subtitle, "desc": f"Residential accommodation at LPU offering mess dining, study rooms, gym, Wi-Fi, and 24x7 security."}]
            match_quality = "confident"
            default_questions = ["Where is the Boys Hostel?", "Where is the Girls Hostel?"]
            new_entity = {"name": name, "coordinates": coords, "category": "hostels"}

        reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
        return AgentChatResponse(
            reply=reply,
            location_card=loc_card,
            actions=actions,
            suggestions=questions,
            last_entity=new_entity
        )

    # -----------------------------------------------------------------------
    # 9. Faculty & HOD Queries
    # -----------------------------------------------------------------------
    is_person_query = bool(re.search(r"\b(hod|head|dean|director|chairperson|coordinator|cos|faculty|professor|teacher|cabin|meet|consult|guidance|dr\b|mr\b|ms\b|mrs\b)\b", msg_lower))
    if is_person_query:
        # Check HOD by department
        hod_data = dl.get_hod(msg)
        if hod_data:
            if not hod_data.get("has_hod", True) or not hod_data.get("name"):
                dept_name = hod_data.get("department", "the department")
                c_block = hod_data.get("central_block", "1")
                b_info = dl.get_block(c_block)
                if b_info and b_info.get("coordinates"):
                    coords = b_info["coordinates"]
                    actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=coords, label=f"Block {c_block}", auto_execute=False))
                    loc_card = LocationCard(
                        title=f"Block {c_block}",
                        subtitle=dept_name,
                        location=f"Block {c_block}, LPU Campus",
                        hours="Open during campus hours",
                        category="academics"
                    )
                    new_entity = {"name": f"Block {c_block}", "coordinates": coords}
                context_records = [{
                    "name": dept_name,
                    "location": f"Block {c_block}",
                    "desc": f"The {dept_name} is located in Block {c_block}. Please note that no specific Head of Department (HOD) is listed in campus records for this school."
                }]
                match_quality = "confident"
                default_questions = [f"Where is Block {c_block} located?", "Which departments are in Block 34?"]
                reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
                return AgentChatResponse(
                    reply=reply,
                    location_card=loc_card,
                    actions=actions,
                    suggestions=questions,
                    last_entity=new_entity
                )
            else:
                name = hod_data["name"]
                dept = hod_data["department"]
                block = hod_data["block"]
                room = hod_data["room"]
                cabin = hod_data.get("cabin", "")
                notation = hod_data.get("notation", "")
                b_info = dl.get_block(block)
                if b_info and b_info.get("coordinates"):
                    coords = b_info["coordinates"]
                    actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=coords, label=f"Block {block} ({name})", auto_execute=False))
                    actions.append(MapAction(
                        action_type="SET_DIRECTIONS",
                        start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
                        end={"lat": coords[0], "lng": coords[1], "label": f"Block {block}"},
                        label=f"Block {block}",
                        auto_execute=False
                    ))
                    loc_card = LocationCard(
                        title=name,
                        subtitle=f"Head of Department ({dept})",
                        location=f"Block {block}, Room {room}" + (f", Cabin {cabin}" if cabin else ""),
                        code=notation,
                        hours="8:00 AM - 5:30 PM",
                        category="faculty"
                    )
                    new_entity = {"name": f"{name} (Block {block})", "coordinates": coords, "notation": notation}
                context_records = [hod_data]
                match_quality = "confident"
                default_questions = [f"Where is Block {block} located?", f"What are {name}'s consultation hours?"]
                reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
                return AgentChatResponse(
                    reply=reply,
                    location_card=loc_card,
                    actions=actions,
                    suggestions=questions,
                    last_entity=new_entity
                )

        # Check Person by name or UID
        person = dl.get_person(msg)
        if person:
            name = person["name"]
            block = person.get("block")
            room = person.get("room")
            cabin = person.get("seating")
            notation = person.get("location_notation")
            designation = person.get("designation") or person.get("role") or "Faculty Member"
            dept = person.get("department_or_subject") or "Academics"

            if block:
                b_info = dl.get_block(block)
                if b_info and b_info.get("coordinates"):
                    coords = b_info["coordinates"]
                    actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=coords, label=f"Block {block} ({name})", auto_execute=False))
                    actions.append(MapAction(
                        action_type="SET_DIRECTIONS",
                        start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
                        end={"lat": coords[0], "lng": coords[1], "label": f"Block {block}"},
                        label=f"Block {block}",
                        auto_execute=False
                    ))
                    loc_card = LocationCard(
                        title=name,
                        subtitle=f"{designation} ({dept})",
                        location=f"Block {block}, Room {room}" + (f", Cabin {cabin}" if cabin else ""),
                        code=notation,
                        hours="8:00 AM - 5:30 PM",
                        category="faculty"
                    )
                    new_entity = {"name": f"{name} (Block {block})", "coordinates": coords, "notation": notation}
            context_records = [person]
            match_quality = "confident"
            default_questions = [f"Where is Block {block} located?", f"What are {name}'s cabin hours?"]
            reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
            return AgentChatResponse(
                reply=reply,
                location_card=loc_card,
                actions=actions,
                suggestions=questions,
                last_entity=new_entity
            )

    # -----------------------------------------------------------------------
    # 10. Numbered Block / Building Query
    # -----------------------------------------------------------------------
    m_block = re.search(r"\bblock[-_ ]*(\d{1,2})\b", msg_lower)
    if not m_block and msg_lower.strip().isdigit():
        m_block = re.search(r"\b(\d{1,2})\b", msg_lower)

    if m_block:
        b_num_str = m_block.group(1)
        block_info = dl.get_block(b_num_str)
        if block_info:
            bname = block_info["name"]
            desc = block_info.get("desc", "")
            coords = block_info.get("coordinates")
            if coords:
                actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=coords, label=bname, auto_execute=False))
                actions.append(MapAction(
                    action_type="SET_DIRECTIONS",
                    start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
                    end={"lat": coords[0], "lng": coords[1], "label": bname},
                    label=bname,
                    auto_execute=False
                ))
            loc_card = LocationCard(
                title=bname,
                subtitle=desc[:45] if desc else "Academic Block",
                location=f"Block {b_num_str}, LPU Campus",
                code=f"Block {b_num_str}",
                hours="8:00 AM - 5:30 PM",
                category="block"
            )
            context_records = [block_info]
            match_quality = "confident"
            default_questions = [f"Which departments are inside {bname}?", "Where is the nearest tuck shop?"]
            new_entity = {"name": bname, "coordinates": coords}
            reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
            return AgentChatResponse(
                reply=reply,
                location_card=loc_card,
                actions=actions,
                suggestions=questions,
                last_entity=new_entity
            )
        else:
            # Block number queried but does not exist
            context_records = [{"name": f"Block {b_num_str}", "desc": f"Block {b_num_str} was not found in campus records. LPU academic blocks range from Block 1 to Block 38."}]
            match_quality = "none"
            default_questions = ["Where is Block 34?", "Where is Block 1?"]
            reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
            return AgentChatResponse(
                reply=reply,
                location_card=None,
                actions=[],
                suggestions=questions,
                last_entity=last_entity
            )

    # -----------------------------------------------------------------------
    # 11. CSE Blocks Overview & Count Queries
    # -----------------------------------------------------------------------
    is_cse_blocks_query = (
        bool(re.search(r"\b(?:cse|computer\s+science)\b", msg_lower)) and
        bool(re.search(r"\b(?:blocks?|department|school|buildings?)\b", msg_lower)) and
        not bool(re.search(r"\b(?:hod|head|dean|chairperson|faculty|who\s+is)\b", msg_lower))
    )
    if is_cse_blocks_query:
        cse_group = next((g for g in dl.groups if g.get("id") == "cse-dept"), None)
        raw_blocks = cse_group.get("blocks", []) if cse_group else []
        formatted_blocks = [b.replace("block-", "Block ") for b in raw_blocks]
        count = len(formatted_blocks)
        is_count_query = bool(re.search(r"\b(?:how\s+many|count|number\s+of|total)\b", msg_lower))

        b34_coords = [31.2538, 75.7045]
        actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=b34_coords, label="Block 34 (CSE)", auto_execute=False))
        actions.append(MapAction(
            action_type="SET_DIRECTIONS",
            start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
            end={"lat": b34_coords[0], "lng": b34_coords[1], "label": "Block 34 (CSE)"},
            label="Block 34 (CSE)",
            auto_execute=False
        ))
        loc_card = LocationCard(
            title="School of Computer Science & Engineering (CSE)",
            subtitle=f"{count} Academic Blocks: {', '.join(formatted_blocks[:6])}...",
            location="Block 34 (Main Hub), LPU Campus",
            hours="8:00 AM - 5:30 PM",
            category="academics"
        )
        context_records = [
            {
                "department": "School of Computer Science & Engineering (CSE)",
                "total_cse_blocks_count": count,
                "cse_blocks_list": formatted_blocks,
                "main_academic_hub": "Block 34",
                "description": (
                    f"The School of Computer Science & Engineering (CSE) at LPU encompasses a total of {count} academic blocks: "
                    f"{', '.join(formatted_blocks)}. Block 34 serves as the central administrative hub and main CSE building."
                ),
                "is_count_query": is_count_query,
                "guidance": (
                    f"The user is asking {'for the count of CSE blocks' if is_count_query else 'about the CSE department blocks'}. "
                    f"State clearly that there are {count} academic blocks belonging to CSE: {', '.join(formatted_blocks)}, with Block 34 as the central hub. "
                    f"Do not invent or fabricate blocks or mention unrelated offices like TPC unless asked."
                )
            }
        ]
        match_quality = "confident"
        default_questions = ["Where is Block 34 located?", "Which CSE blocks are interconnected?"]
        new_entity = {"name": "School of Computer Science & Engineering (CSE)", "coordinates": b34_coords}
        reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
        return AgentChatResponse(
            reply=reply,
            location_card=loc_card,
            actions=actions,
            suggestions=questions,
            last_entity=new_entity
        )

    is_corridor_query = bool(re.search(r"\b(connect(?:ed|ion|ions)?|corridor|bridge|walkway|skywalk|passage|pathway)\b", msg_lower))
    if is_corridor_query:
        context_records = dl.connections
        match_quality = "confident"
        default_questions = ["Which CSE blocks are connected?", "Where is Block 34?"]
        reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
        return AgentChatResponse(
            reply=reply,
            location_card=None,
            actions=[],
            suggestions=questions,
            last_entity=last_entity
        )

    # -----------------------------------------------------------------------
    # 12. Tier 2 Semantic Vector Search Fallback
    # -----------------------------------------------------------------------
    matches = vs.search(msg, top_k=3, threshold=0.55)
    # Filter out connection documents unless the user specifically asked for corridors
    if not is_corridor_query:
        matches = [m for m in matches if m[0].get("source_collection") != "CAMPUS_BLOCK_CONNECTIONS"]

    if matches:
        top_doc, top_score = matches[0]
        name = top_doc.get("name", "Campus Location")
        data = top_doc.get("data", {})
        coords = (
            data.get("coordinates")
            or data.get("centerCoords")
            or data.get("coords")
            or top_doc.get("coordinates")
            or top_doc.get("centerCoords")
            or top_doc.get("coords")
        )
        if not coords and data.get("lat") and data.get("lng"):
            coords = [data["lat"], data["lng"]]

        if coords:
            actions.append(MapAction(action_type="FLY_TO_LOCATION", coordinates=coords, label=name, auto_execute=False))
            actions.append(MapAction(
                action_type="SET_DIRECTIONS",
                start={"lat": user_location.lat, "lng": user_location.lng, "label": "Your Location"} if user_location else None,
                end={"lat": coords[0], "lng": coords[1], "label": name},
                label=name,
                auto_execute=False
            ))
        
        loc_card = LocationCard(
            title=name,
            subtitle=top_doc.get("type") or "Campus Location",
            location=data.get("floor") or data.get("location") or "LPU Campus",
            hours=data.get("hours") or "Open during campus hours",
            category=top_doc.get("category") or "locations"
        )
        new_entity = {"name": name, "coordinates": coords if coords else None}

        context_records = [top_doc]
        match_quality = "confident" if top_score >= 0.65 else "weak"
        default_questions = [f"Where is {name} located?", "How do I reach here?"]
        reply, questions = generate_dynamic_reply(msg, context_records, match_quality, history, default_questions)
        return AgentChatResponse(
            reply=reply,
            location_card=loc_card,
            actions=actions,
            suggestions=questions,
            last_entity=new_entity
        )

    # -----------------------------------------------------------------------
    # 13. Open Conversational / General / Out-of-Domain Fallback
    # -----------------------------------------------------------------------
    # Pass directly to Gemini with zero records; Gemini will respond naturally
    # as LPUNavix and clarify or decline off-topic requests.
    default_questions = ["Where is the Central Library?", "Where is Block 34?"]
    reply, questions = generate_dynamic_reply(msg, [], "none", history, default_questions)
    return AgentChatResponse(
        reply=reply,
        location_card=None,
        actions=[],
        suggestions=questions,
        last_entity=last_entity
    )


@router.post("/api/agent/chat", response_model=AgentChatResponse)
def chat_endpoint(req: AgentChatRequest):
    """
    Public API chat endpoint for the Autonomous LPUNavix Campus Guide.
    """
    if not req.message or not req.message.strip():
        raise HTTPException(status_code=400, detail="Query message cannot be empty.")
    try:
        return run_campus_agent(
            message=req.message,
            user_location=req.user_location,
            last_entity=req.last_entity,
            history=req.history
        )
    except Exception as e:
        logger.error(f"[chat_endpoint] Unhandled error: {e}", exc_info=True)
        # Safe deterministic fallback
        offline_fallback = gemini_client._format_grounded_fallback(req.message, [], "none")
        return AgentChatResponse(
            reply=offline_fallback,
            location_card=None,
            actions=[],
            suggestions=["Where is the Central Library?", "Where is Block 34?"],
            last_entity=req.last_entity
        )
