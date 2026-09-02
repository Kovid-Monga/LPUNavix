import json
import os
import re
from pathlib import Path
from typing import Any, Iterable, List, Optional, Union

try:
    import json5
except ImportError:
    json5 = None

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    from google import genai
except ImportError:  # pragma: no cover - handled at runtime when dependency is installed.
    genai = None

DATA_JS_PATH = Path(__file__).resolve().parent.parent / "js" / "data.js"


def _extract_js_array(var_name: str, js_code: str) -> List[dict]:
    """Extract a JavaScript array variable from JS source code."""
    pattern = re.compile(
        rf"{var_name}\s*(?:=\s*window\.{var_name}\s*)?=\s*(\[[\s\S]*?\n\s*\]);",
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
    Dynamically loads campus entities (groups, locations/blocks, offices) from js/data.js.
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

    records: List[dict] = []

    for group in groups:
        records.append({
            "id": group.get("id"),
            "kind": "group",
            "name": group.get("name", ""),
            "category": group.get("category", ""),
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

    return records


# CAMPUS_RECORDS loaded dynamically from data.js
CAMPUS_RECORDS = load_campus_records()


SYNONYM_MAP = {
    "lost": ["lost", "missing", "misplaced", "found", "find"],
    "report": ["report", "reports", "reporting", "query", "queries", "ask", "asks", "inquire", "inquiry", "information", "help"],
    "item": ["item", "belonging", "belongings", "object", "bag", "luggage"],
    "admin": ["admin", "administration", "administrative", "office"],
    "where": ["where", "locate", "location", "find", "reach"],
    "faculty": ["faculty", "teacher", "staff", "mentor"],
    "infrastructure": ["infrastructure", "maintenance", "repair", "facility"],
}


def _normalize_text(value: Optional[str]) -> str:
    if value is None:
        return ""
    text = str(value).lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _tokenize(text: str) -> List[str]:
    return [token for token in _normalize_text(text).split() if token]


def _expanded_terms(question: str) -> List[str]:
    tokens = set(_tokenize(question))
    expanded = set(tokens)
    for token in list(tokens):
        expanded.update({token})
        for canonical, variants in SYNONYM_MAP.items():
            if token == canonical or token in variants:
                expanded.add(canonical)
                expanded.update(variants)
    return sorted(expanded)


def _record_search_text(record: dict) -> str:
    values = []
    for field in ["name", "type", "desc", "groupName", "category", "floor"]:
        values.append(record.get(field, ""))
    for field in ["tags", "facilities"]:
        values.extend(record.get(field, []) or [])
    text = " ".join(str(v) for v in values)
    return _normalize_text(text)


def retrieve_relevant_records(question: str, records: Optional[Iterable[dict]] = None, limit: int = 5) -> List[dict]:
    base_records = list(records) if records is not None else list(CAMPUS_RECORDS)
    if not question or not question.strip():
        return []

    cleaned = _normalize_text(question)
    expanded_terms = _expanded_terms(cleaned)

    scored: List[dict] = []
    for record in base_records:
        search_text = _record_search_text(record)
        score = 0
        matches = []

        for term in expanded_terms:
            if term in search_text:
                matches.append(term)
                weight = 3
                if term in _normalize_text(record.get("name", "")):
                    weight += 5
                if term in _normalize_text(" ".join(record.get("tags", []) or [])):
                    weight += 4
                if term in _normalize_text(record.get("desc", "") or ""):
                    weight += 3
                if term in _normalize_text(" ".join(record.get("facilities", []) or [])):
                    weight += 6
                if term in _normalize_text(record.get("groupName", "") or ""):
                    weight += 2
                score += weight

        if any(token in search_text for token in ["lost", "found", "query", "queries", "office", "administrative"]):
            score += 4

        # Encourage shorter exact phrase matches that reflect the user's intent.
        question_phrases = [
            "lost item",
            "lost and found",
            "report a lost item",
            "general queries",
            "administrative office",
            "infrastructure queries",
        ]
        for phrase in question_phrases:
            if phrase in cleaned and phrase in search_text:
                score += 10

        if score > 0:
            scored.append({
                "id": record.get("id"),
                "kind": record.get("kind"),
                "name": record.get("name"),
                "score": score,
                "matches": matches,
                "search_text": search_text,
                "record": record,
            })

    scored.sort(key=lambda item: (-item["score"], item["name"]))
    return scored[:limit]


def build_context_block(records: List[dict]) -> str:
    if not records:
        return "No relevant campus records were retrieved."

    context_lines = []
    for item in records:
        record = item["record"]
        location = ""
        if record.get("floor"):
            location += f"Floor: {record['floor']}; "
        if record.get("groupName"):
            location += f"Parent group: {record['groupName']}; "
        if record.get("lat") is not None and record.get("lng") is not None:
            location += f"Coordinates: {record['lat']}, {record['lng']}; "
        if record.get("parentBlockIds"):
            location += f"Related blocks: {', '.join(record['parentBlockIds'])}; "
        facility_text = ", ".join(record.get("facilities", []) or [])
        tags_text = ", ".join(record.get("tags", []) or [])
        context_lines.append(
            f"- {record.get('name')} ({record.get('type')}) | {location.strip()} "
            f"Hours: {record.get('hours', 'Not specified')}; "
            f"Facilities: {facility_text or 'Not specified'}; "
            f"Description: {record.get('desc', '')}; "
            f"Tags: {tags_text or 'Not specified'}"
        )
    return "\n".join(context_lines)


def generate_chat_reply(question: str, relevant_records: List[dict]) -> str:
    if not relevant_records:
        return (
            "I couldn’=t find any campus records that match your question. "
            "Please ask a more specific question about a block, office, department, or service, "
            "such as a room, office, or campus facility."
        )

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Missing GEMINI_API_KEY. Add it to your environment or a .env file before calling the Gemini endpoint."
        )

    if genai is None:
        raise RuntimeError("The google-genai package is not installed. Add it to requirements.txt and install dependencies.")

    client = genai.Client(api_key=api_key)

    system_instruction = (
        "Answer using ONLY the information in the provided campus-context data. "
        "Never invent locations, facilities, hours, room numbers, or department details. "
        "If the context does not contain enough information, say so honestly and ask the user to be more specific. "
        "Write a natural, conversational answer in plain English."
    )
    context_block = build_context_block(relevant_records)
    prompt = (
        f"{system_instruction}\n\n"
        f"User question: {question}\n\n"
        f"Relevant campus context:\n{context_block}"
    )

    response = client.models.generate_content(
        model="Gemini 2.5 Flash",
        contents=prompt,
    )
    return response.text.strip() if response.text else "I couldn't find a reliable answer in the campus data provided."
