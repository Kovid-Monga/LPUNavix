import os
import re
from typing import Iterable, List, Optional

try:
    import google.generativeai as genai
except ImportError:  # pragma: no cover - handled at runtime when dependency is installed.
    genai = None


CAMPUS_RECORDS = [
    {
        "id": "fashion-design-dept",
        "kind": "group",
        "name": "School of Fashion Design",
        "category": "academics",
        "type": "Department",
        "tags": ["fashion design", "school of fashion design", "design department"],
        "blocks": ["block-1-fashion-design"],
        "groupName": "",
        "desc": "Department of Fashion Design at LPU.",
        "facilities": [],
    },
    {
        "id": "cse-dept",
        "kind": "group",
        "name": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Department Zone",
        "tags": ["cse", "computer science", "it", "coding", "software", "btech cse", "cse blocks"],
        "blocks": ["block-25", "block-26", "block-27", "block-28", "block-31"],
        "groupName": "",
        "desc": "Houses the School of Computer Science & Engineering.",
        "facilities": [],
    },
    {
        "id": "block-1",
        "kind": "block",
        "name": "Block 1",
        "groupId": "fashion-design-dept",
        "groupName": "School of Fashion Design",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.258597515534394,
        "lng": 75.70874010081363,
        "floor": "Academic Block",
        "facilities": ["Classrooms", "Design Studios", "Faculty Offices"],
        "tags": ["block 1", "block-1", "school of fashion design", "fashion design", "academic block"],
        "desc": "Block 1 houses the School of Fashion Design on the LPU campus.",
        "hours": "Open on Campus Schedule",
    },
    {
        "id": "block-25",
        "kind": "block",
        "name": "Block 25 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.25285938442377,
        "lng": 75.70247885462516,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 25", "cse", "computer science", "b25", "academic block"],
        "desc": "Block 25 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-26",
        "kind": "block",
        "name": "Block 26 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.252861883513926,
        "lng": 75.70289512306216,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 26", "cse", "computer science", "b26", "academic block"],
        "desc": "Block 26 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-27",
        "kind": "block",
        "name": "Block 27 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.252858651898666,
        "lng": 75.70330718355343,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 27", "cse", "computer science", "b27", "academic block"],
        "desc": "Block 27 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-28",
        "kind": "block",
        "name": "Block 28 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.25284540741938,
        "lng": 75.70373386456326,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 28", "cse", "computer science", "b28", "academic block"],
        "desc": "Block 28 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-31",
        "kind": "block",
        "name": "Block 31 (Admin)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "offices",
        "type": "Administrative & Academic Block",
        "lat": 31.252443962233237,
        "lng": 75.70496872629623,
        "floor": "Multi-storey Block",
        "facilities": ["Administrative Offices", "Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 31", "admin", "administration", "cse", "computer science", "b31", "administrative block"],
        "desc": "Block 31 - Administrative Block & CSE Department.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-32",
        "kind": "block",
        "name": "Block 32 (Admin)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.252169312144662,
        "lng": 75.70476168618337,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 32", "cse", "computer science", "b32", "academic block"],
        "desc": "Block 32 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-33",
        "kind": "block",
        "name": "Block 33 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.25182752424929,
        "lng": 75.70475097721261,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 33", "cse", "computer science", "b33", "academic block"],
        "desc": "Block 33 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-34",
        "kind": "block",
        "name": "Block 34 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.251755912632076,
        "lng": 75.70394589038689,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 34", "cse", "computer science", "b34", "academic block"],
        "desc": "Block 34 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-35",
        "kind": "block",
        "name": "Block 35 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.251822078239537,
        "lng": 75.70336032734117,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 35", "cse", "computer science", "b35", "academic block"],
        "desc": "Block 35 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-36",
        "kind": "block",
        "name": "Block 36 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.251689259364163,
        "lng": 75.70286644251997,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 36", "cse", "computer science", "b36", "academic block"],
        "desc": "Block 36 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-37",
        "kind": "block",
        "name": "Block 37 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.252110679864544,
        "lng": 75.70278483547997,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 37", "cse", "computer science", "b37", "academic block"],
        "desc": "Block 37 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "block-38",
        "kind": "block",
        "name": "Block 38 (CSE)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "academics",
        "type": "Academic Block",
        "lat": 31.252140287536804,
        "lng": 75.70338135340346,
        "floor": "Multi-storey Block",
        "facilities": ["Classrooms", "Computer Labs", "Faculty Cabins"],
        "tags": ["block 38", "cse", "computer science", "b38", "academic block"],
        "desc": "Block 38 - Department of Computer Science & Engineering.",
        "hours": "8:00 AM - 5:30 PM",
    },
    {
        "id": "office-admin-28-209",
        "kind": "office",
        "name": "Administrative Office (Block 28, Room 209)",
        "groupId": "cse-dept",
        "groupName": "School of Computer Science & Engineering (CSE)",
        "category": "offices",
        "type": "Administrative Office",
        "parentBlockIds": ["block-27", "block-28"],
        "visibleFromZoom": 19,
        "lat": 31.252754224964615,
        "lng": 75.70378526355849,
        "floor": "Second Floor, Room 209",
        "facilities": ["Lost and Found", "Infrastructure Queries", "Faculty Details", "General Queries"],
        "tags": ["administrative office", "admin office", "block 27", "block 28", "room 209", "lost and found", "infrastructure", "faculty details", "general queries"],
        "desc": "Administrative office serving Blocks 27 and 28 for lost and found, infrastructure queries, faculty details, and general queries.",
        "hours": "8:00 AM - 5:30 PM",
    },
]

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
            "I couldn’t find any campus records that match your question. "
            "Please ask a more specific question about a block, office, department, or service, "
            "such as a room, office, or campus facility."
        )

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Missing GEMINI_API_KEY. Add it to your environment or a .env file before calling the Gemini endpoint."
        )

    if genai is None:
        raise RuntimeError("The google-generativeai package is not installed. Add it to requirements.txt and install dependencies.")

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-1.5-flash")

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

    response = model.generate_content(prompt)
    return getattr(response, "text", str(response)).strip() or "I couldn’t find a reliable answer in the campus data provided."
