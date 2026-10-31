"""
api/retrieval.py — Structured Contextual Retrieval Engine for LPUNavix
========================================================================
Combines deterministic structured matching (UIDs, notations, HOD departments,
blocks, rooms, landmarks, hostels, stationery tuck shops, Unipolis, UniMall)
with fast vectorized semantic ranking.

Also implements conversational context resolution (anaphora resolution,
entity tracking, follow-up rewriting).
"""

import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

from api.data_loader import Record

CONFIDENT_THRESHOLD = float(os.environ.get("RETRIEVAL_CONFIDENT_THRESHOLD", 0.495))
WEAK_THRESHOLD = float(os.environ.get("RETRIEVAL_WEAK_THRESHOLD", 0.45))
TOP_K = int(os.environ.get("RETRIEVAL_TOP_K", 8))

DEPT_ALIASES = {
    "Data Science and Big Data": [
        "data science and big data", "data science", "big data", "ds"
    ],
    "Artificial Intelligence and Machine Learning": [
        "artificial intelligence and machine learning", "artificial intelligence & machine learning",
        "ai and ml", "ai & ml", "aiml", "ai/ml", "artificial intelligence", "machine learning"
    ],
    "Cloud Computing": [
        "cloud computing", "cloud"
    ],
    "Network and Cyber Security": [
        "network and cyber security", "network & cyber security", "network security", "cyber security",
        "cyber", "network"
    ],
    "Programming": [
        "programming", "coding"
    ],
    "Software Testing and Methodologies": [
        "software testing and methodologies", "software testing & methodologies", "software testing",
        "testing and methodologies", "software test", "testing"
    ],
    "Full Stack Application Development": [
        "full stack application development", "full stack", "fullstack", "application development"
    ],
    "DevOps": [
        "devops"
    ],
    "Mathematics": [
        "mathematics", "math", "maths"
    ],
    "Chemistry": [
        "chemistry", "chem"
    ],
    "ECE": [
        "ece", "electronics and communication"
    ],
    "HOL": [
        "hol", "head of labs"
    ],
    "Academic Operations": [
        "academic operations", "acad ops", "academic operation"
    ],
}


def find_structured_matches(query: str, records: List[Record]) -> List[Record]:
    """Perform deterministic, structured matching for UIDs, location notations,
    person names, HOD departments, blocks, rooms, and administrative roles.
    """
    q = query.lower().strip()
    clean_q = re.sub(r"[^\w\s\-\/]", " ", q)
    words = clean_q.split()

    matches: List[Record] = []
    seen_ids: Set[str] = set()

    def add(r: Record):
        if r.id not in seen_ids:
            seen_ids.add(r.id)
            matches.append(r)

    # 1. Exact UID match (e.g. "14575", "UID 17442", "16870")
    uid_matches = re.findall(r"\b(\d{5})\b", clean_q)
    for u in uid_matches:
        for r in records:
            if r.uid and r.uid == u:
                add(r)
    if matches:
        return matches

    # 2. Location notation match (e.g. "34-202-C3", "34-209-C1", "36-309A-C2", "34-309", "34-208")
    loc_notations = re.findall(r"\b(\d{2}-[0-9]{3}[a-zA-Z]?(?:-[cC]\d)?)\b", clean_q)
    for notat in loc_notations:
        norm_notat = notat.upper()
        for r in records:
            if r.location_notation and r.location_notation.upper() == norm_notat:
                add(r)
    if matches:
        return matches

    # 3. Person Name matching (prioritize exact / partial name matching)
    for r in records:
        if not r.uid or not r.name:
            continue
        full_name = r.name.lower()
        no_prefix = full_name.replace("dr. ", "").replace("mr. ", "").strip()
        if no_prefix in clean_q or full_name in clean_q:
            add(r)
            continue
        parts = no_prefix.split()
        if len(parts) >= 2:
            if " ".join(parts[-2:]) in clean_q or (parts[-1] in clean_q and parts[0] in clean_q):
                add(r)
        elif len(parts) == 1 and len(parts[0]) > 4 and parts[0] in words:
            add(r)

    if matches:
        return matches

    # 4. HOD + Department queries (e.g. "Who is the HOD of DevOps", "Where is the HOD for Data Science", "Who heads Cloud Computing")
    is_hod_query = any(w in clean_q for w in ["hod", "head", "heads", "handles", "contact", "meet"])
    matched_dept = None
    for dept_name, aliases in DEPT_ALIASES.items():
        for alias in aliases:
            pattern = r"\b" + re.escape(alias) + r"\b"
            if re.search(pattern, clean_q):
                matched_dept = dept_name
                break
        if matched_dept:
            break

    if matched_dept and (is_hod_query or "who" in clean_q or "where" in clean_q):
        for r in records:
            if r.role == "HOD" and r.department_or_subject and r.department_or_subject.lower() == matched_dept.lower():
                add(r)
        if matches:
            return matches

    # 5. Block + Room (+ Seating) queries (e.g. "Room 202 of Block 28", "Block 34 Room 202")
    block_m = re.search(r"\b(?:block|blok|b)[\s-]*(\d{1,2})\b", clean_q)
    room_m = re.search(r"\broom\s*([0-9]{3}[a-zA-Z]?)\b", clean_q)
    seat_m = re.search(r"\b(?:cabin|seating|seat|c)\s*([cC]?\d)\b", clean_q)
    seating_val = None
    if seat_m:
        val = seat_m.group(1).upper()
        seating_val = val if val.startswith("C") else f"C{val}"

    if block_m and room_m:
        b_val = block_m.group(1)
        r_val = room_m.group(1).upper()
        for r in records:
            if r.block == b_val and r.room and r.room.upper() == r_val:
                if seating_val:
                    if r.seating and r.seating.upper() == seating_val:
                        add(r)
                else:
                    add(r)
        if matches:
            return matches

    # 5.5 Block connection queries (e.g. "how are blocks 25 and 26 connected", "is block 25 connected to 26")
    if any(w in clean_q for w in ["connect", "connection", "connected", "bridge", "corridor"]):
        found_blocks = re.findall(r"\b(\d+)\b", clean_q)
        for r in records:
            if r.kind == "connection":
                if found_blocks:
                    if any(b in r.blob.lower() for b in found_blocks):
                        add(r)
                else:
                    add(r)
        if matches:
            return matches

    # 5.6 Stationery Tuck Shop queries
    is_stationery_query = bool(
        re.search(
            r"\b(stationery|stationary|tuck\s*shop|tuck\s*shops|tuckshop|tuckshops|pens?|notebooks?|photocopy|xerox)\b",
            clean_q,
        )
    )
    if is_stationery_query:
        block_tuck_m = re.search(r"\b(?:block|b)[\s-]*(\d{1,2})\b", clean_q)
        if block_tuck_m:
            b_num = block_tuck_m.group(1).lstrip("0")
            target_tuck_id = f"tuck-shop-block-{b_num}"
            found_specific = False
            for r in records:
                if r.id == target_tuck_id:
                    add(r)
                    found_specific = True
            if found_specific:
                for r in records:
                    if r.id == f"block-{b_num}":
                        add(r)
                return matches
            else:
                for tuck_id in ["tuck-shop-block-26", "tuck-shop-block-27", "tuck-shop-block-28", "tuck-shop-block-36"]:
                    for r in records:
                        if r.id == tuck_id:
                            add(r)
                if matches:
                    return matches
        else:
            for tuck_id in ["tuck-shop-block-26", "tuck-shop-block-27", "tuck-shop-block-28", "tuck-shop-block-36"]:
                for r in records:
                    if r.id == tuck_id:
                        add(r)
            if matches:
                return matches

    # 5.7 Division of Admissions & Block 29 queries
    is_admission_query = bool(
        re.search(
            r"\b(admi[s]{1,2}ion[s]?|divi[s]{1,2}ion\s+of\s+admi[s]{1,2}ion[s]?|admission\s+queries|admission\s+office|admission\s+counseling)\b",
            clean_q,
        )
    )
    if is_admission_query:
        for r in records:
            if r.id == "block-29":
                add(r)
        if matches:
            return matches

    # 5.8 Unipolis & Major Event Venue / Initial Reporting queries
    is_unipolis_query = bool(
        re.search(
            r"\b(unipoli[s]{1,3}|major\s+university\s+events|university\s+events\s+held|events\s+held|initial\s+student\s+reporting|report\s+initially|initial\s+reporting|student\s+reporting|mega\s+auditorium|event\s+arena)\b",
            clean_q,
        )
    )
    if is_unipolis_query:
        for r in records:
            if r.id == "unipolis":
                add(r)
        for r in records:
            if r.id == "auditorium":
                add(r)
        if matches:
            return matches

    # 5.9 UniMall queries
    is_mall_query = bool(
        re.search(
            r"\b(unimall|uni\s*mall|mall\s+on\s+campus|find\s+the\s+mall|campus\s+mall|shopping\s+mall)\b",
            clean_q,
        )
    )
    if is_mall_query or (re.search(r"\bmall\b", clean_q) and not re.search(r"\bmall\w+", clean_q)):
        for r in records:
            if r.id == "unimall":
                add(r)
        for r in records:
            if r.id == "mall":
                add(r)
        if matches:
            return matches

    # 5.10 Sports Complex & Indoor Sports queries
    is_sports_query = bool(
        re.search(
            r"\b(sports\s+complex|indoor\s+sports|play\s+indoor\s+sports|indoor\s+games|sports\s+facility)\b",
            clean_q,
        )
    )
    if is_sports_query:
        for r in records:
            if r.id == "sports-complex":
                add(r)
        for r in records:
            if r.id == "sports":
                add(r)
        if matches:
            return matches

    # 5.11 Mittal School of Business queries
    is_msb_query = bool(
        re.search(
            r"\b(mittal\s+school\s+of\s+business|mittal\s+business\s+school|school\s+of\s+business|business\s+school|msb)\b",
            clean_q,
        )
    )
    if is_msb_query:
        for r in records:
            if r.id == "mittal-school-of-business":
                add(r)
        if matches:
            return matches

    # 5.12 Division of Student Relationship (DSR) & Division of Student Welfare (DSW) queries
    is_dsr_query = bool(
        re.search(
            r"\b(dsr|dsw|division\s+of\s+student\s+relationship|division\s+of\s+student\s+welfare|student\s+relationship|student\s+welfare|grievances?|student\s+grievances?|student\s+problems?|academic\s+problems?|hostel\s+problems?|student\s+complaints?|student\s+issues?)\b",
            clean_q,
        )
    )
    if is_dsr_query:
        for r in records:
            if r.id == "division-of-student-relationship":
                add(r)
        if matches:
            return matches

    # 6. Block queries (e.g. "Who sits in Block 27", "Where is Block 28", "Block 34")
    if block_m:
        b_val = block_m.group(1)
        if any(w in clean_q for w in ["who", "works", "sits", "people", "faculty", "staff"]):
            for r in records:
                if r.block == b_val and r.uid:
                    add(r)
        else:
            for r in records:
                if r.id == f"block-{b_val}" or (r.id == f"block-{int(b_val)}" and r.kind == "location"):
                    add(r)
            if not matches:
                for r in records:
                    if r.block == b_val and r.kind == "location":
                        add(r)
        if matches:
            return matches

    # 7. Role queries (e.g. "Who is the HOS?", "Where is the HOS office?", "Who is the COS?", "Who is the administrator?", "Who is the COD?")
    role_target = None
    if re.search(r"\bhos\b", clean_q):
        role_target = "HOS"
    elif re.search(r"\bcos\b", clean_q):
        role_target = "COS"
    elif re.search(r"\bcod\b", clean_q):
        role_target = "COD"
    elif re.search(r"\badministrator\b", clean_q) or re.search(r"\badmin office\b", clean_q):
        role_target = "Administrator"

    if role_target:
        for r in records:
            if r.role and (r.role == role_target or (role_target == "Administrator" and "admin" in r.role.lower())):
                add(r)
        if matches:
            return matches

    # 8. Placement Cell / TPC queries
    is_tpc_query = bool(
        re.search(r"\b(tpc|placement|placements|placement cell|training and placement)\b", clean_q)
    )
    if is_tpc_query:
        floor_2 = bool(re.search(r"\b(2nd|second|2)\s*(?:floor)?\b", clean_q)) and any(w in clean_q for w in ["floor", "2nd", "second"])
        floor_3 = bool(re.search(r"\b(3rd|third|3)\s*(?:floor)?\b", clean_q)) and any(w in clean_q for w in ["floor", "3rd", "third"])
        floor_4 = bool(re.search(r"\b(4th|fourth|4)\s*(?:floor)?\b", clean_q)) and any(w in clean_q for w in ["floor", "4th", "fourth"])

        if floor_2 and not floor_3 and not floor_4:
            for r in records:
                if r.id == "office-tpc-32-floor-2":
                    add(r)
        elif floor_3 and not floor_2 and not floor_4:
            for r in records:
                if r.id == "office-tpc-32-floor-3":
                    add(r)
        elif floor_4 and not floor_2 and not floor_3:
            for r in records:
                if r.id == "office-tpc-32-floor-4":
                    add(r)
        else:
            for r in records:
                if r.id == "office-tpc-32":
                    add(r)
            for r in records:
                if r.id == "block-32":
                    add(r)
            for r in records:
                if r.id in ("office-tpc-32-floor-2", "office-tpc-32-floor-3", "office-tpc-32-floor-4"):
                    add(r)
        if matches:
            return matches

    # 9. Central Library / Library queries
    is_lib_query = bool(
        re.search(r"\b(centra[l]{1,2}\s+lib[a-z]*|lib[a-z]{2,4}y|librar[a-z]*|libraries|reading\s+room|study\s+room)\b", clean_q)
    )
    if is_lib_query:
        for r in records:
            if r.id == "central-library":
                add(r)
        for r in records:
            if r.id == "library":
                add(r)
        for r in records:
            if r.id == "block-37":
                add(r)
        if matches:
            return matches

    # 9.5 Uni Health Center / Clinic / Medical queries
    is_health_query = bool(
        re.search(r"\b(h[ea]{1,2}lth|clinic|doctor|medical|hospital|dispensary)\b", clean_q)
    )
    if is_health_query:
        for r in records:
            if r.id == "uni-health-center":
                add(r)
        if matches:
            return matches

    # 10. Block 37 queries
    if re.search(r"\b(block\s*37|b37)\b", clean_q):
        for r in records:
            if r.id == "block-37":
                add(r)
        for r in records:
            if r.id == "central-library":
                add(r)
        for r in records:
            if r.id == "library":
                add(r)
        if matches:
            return matches

    # 11. Auditorium / Shanti Devi Mittal Auditorium queries
    is_audi_query = bool(
        re.search(
            r"\b(shanti\s+devi(\s+mittal)?(\s+auditorium)?|shanti\s+devi|sdm\s+auditorium|auditorium|auditoriums|audi)\b",
            clean_q,
        )
    )
    if is_audi_query:
        if re.search(r"\b(baldev\s*raj|baldevraj)\b", clean_q):
            for r in records:
                if r.id == "sh-baldevraj-mittal-auditorium":
                    add(r)
            for r in records:
                if r.id == "auditorium":
                    add(r)
            for r in records:
                if r.id == "shanti-devi-mittal-auditorium":
                    add(r)
        else:
            for r in records:
                if r.id == "shanti-devi-mittal-auditorium":
                    add(r)
            for r in records:
                if r.id == "auditorium":
                    add(r)
            for r in records:
                if r.id == "unipolis":
                    add(r)
            for r in records:
                if r.id == "sh-baldevraj-mittal-auditorium":
                    add(r)
        if matches:
            return matches

    # 12. Hostels / Studios / Apartments
    gh_m = re.search(r"\b(?:gh|girls\s+hostel)[\s-]*([1-4])\b", clean_q)
    if gh_m:
        h_num = gh_m.group(1)
        target_id = f"gh-{h_num}"
        for r in records:
            if r.id == target_id:
                add(r)
        if matches:
            return matches

    gs_m = re.search(r"\b(?:gs|girls\s+studio|girls\s+studios)[\s-]*(1[1-2])\b", clean_q)
    if gs_m:
        s_num = gs_m.group(1)
        target_id = f"gs-{s_num}"
        for r in records:
            if r.id == target_id:
                add(r)
        if matches:
            return matches

    bh_m = re.search(r"\b(?:bh|boys\s+hoste[l]{1,2}|hoste[l]{1,2})[\s-]*([1-6])\b", clean_q)
    if bh_m:
        h_num = bh_m.group(1)
        target_id = f"bh-{h_num}"
        for r in records:
            if r.id == target_id:
                add(r)
        if matches:
            return matches

    bs_m = re.search(r"\b(?:bs|boys\s+studio|studio)[\s-]*(1[1-3])\b", clean_q)
    if bs_m:
        s_num = bs_m.group(1)
        target_id = f"bs-{s_num}"
        for r in records:
            if r.id == target_id:
                add(r)
        if matches:
            return matches

    if re.search(r"\b(?:boys\s+apartment\s+ab|apartment\s+ab|apt\s+ab|ab\s+apartment)\b", clean_q) or ("apartment" in clean_q and "ab" in words):
        for r in records:
            if r.id == "boys-apartment-ab":
                add(r)
        if matches:
            return matches

    if re.search(r"\b(?:boys\s+apartment\s+cd|apartment\s+cd|apt\s+cd|cd\s+apartment)\b", clean_q) or ("apartment" in clean_q and "cd" in words):
        for r in records:
            if r.id == "boys-apartment-cd":
                add(r)
        if matches:
            return matches

    if re.search(r"\b(?:girls\s+hoste[l]{1,2}|girls\s+hoste[l]{1,2}s|gh)\b", clean_q):
        for r in records:
            if r.id in ("gh-1", "gh-2", "gh-3", "gh-4"):
                add(r)
        if matches:
            return matches

    if re.search(r"\b(?:girls\s+studio|girls\s+studios|gs)\b", clean_q):
        for r in records:
            if r.id in ("gs-11", "gs-12"):
                add(r)
        if matches:
            return matches

    if re.search(r"\b(?:girls\s+residential\s+area|girls\s+residential)\b", clean_q):
        for r in records:
            if r.id == "girls-residential-area":
                add(r)
        for r in records:
            if r.id in ("gh-1", "gh-2", "gh-3", "gh-4", "gs-11", "gs-12"):
                add(r)
        if matches:
            return matches

    if re.search(r"\b(?:boys\s+residential\s+area|boys\s+hoste[l]{1,2}|boys\s+hoste[l]{1,2}s|boys\s+studio|boys\s+studios|boys\s+apartment|boys\s+apartments)\b", clean_q):
        for r in records:
            if r.id == "residential-area":
                add(r)
        for r in records:
            if r.id in ("bh-1", "bh-2", "bh-3", "bh-5", "bh-6", "bs-11", "bs-12", "bs-13", "boys-apartment-ab", "boys-apartment-cd"):
                add(r)
        if matches:
            return matches

    if re.search(r"\b(?:residential\s+area|residential|hoste[l]{1,2}s|hoste[l]{1,2}|where\s+to\s+stay|student\s+housing)\b", clean_q):
        for r in records:
            if r.id in ("girls-residential-area", "residential-area"):
                add(r)
        for r in records:
            if r.category == "hostels" and r.id not in ("residential-area", "girls-residential-area"):
                add(r)
        if matches:
            return matches

    return matches


def has_explicit_target(question: str, records: List[Record]) -> bool:
    """Detect if the query explicitly names a specific location, block, person, UID, or department."""
    clean_q = re.sub(r"[^\w\s\-\/]", " ", question.lower()).strip()

    if find_structured_matches(question, records):
        return True

    if re.search(r"\b(?:block|b)[\s-]*\d{1,2}\b", clean_q, re.I):
        return True

    known_landmarks = [
        "library", "central library", "unimall", "uni mall", "health center",
        "hospital", "dispensary", "food court", "main gate", "gate 1", "gate 2",
        "gate 3", "gate 4", "bh1", "bh-1", "bh 1", "bh2", "bh-2", "bh 2", "bh3", "bh-3", "bh 3",
        "bh4", "bh-4", "bh5", "bh-5", "bh 5", "bh6", "bh-6", "bh 6",
        "bs11", "bs-11", "bs 11", "bs12", "bs-12", "bs 12", "bs13", "bs-13", "bs 13",
        "gh1", "gh-1", "gh 1", "gh2", "gh-2", "gh 2", "gh3", "gh-3", "gh 3", "gh4", "gh-4", "gh 4",
        "gs11", "gs-11", "gs 11", "gs12", "gs-12", "gs 12",
        "boys apartment", "apartment ab", "apartment cd", "residential area",
        "girls residential area", "boys residential area", "girls hostel", "girls hostels",
        "girls studio", "girls studios", "boys hostel", "boys studio", "gh", "gs",
        "swimming pool", "stadium", "auditorium", "shanti devi mittal", "baldev raj mittal",
        "unipolis", "unimall", "uni mall", "mall", "sports complex", "indoor sports",
        "block 29", "block-29", "division of admissions", "admissions", "admission queries", "admission office",
        "stationery", "tuck shop", "tuck shops", "stationery shop", "pens", "notebooks",
        "mittal school of business", "school of business", "business school", "msb",
        "dsr", "dsw", "division of student relationship", "division of student welfare",
        "student relationship", "student welfare"
    ]
    for kw in known_landmarks:
        if re.search(r"\b" + re.escape(kw) + r"\b", clean_q, re.I):
            return True

    return False


def is_followup_query(question: str) -> bool:
    """Detect if a user query is an anaphoric or elliptical follow-up."""
    clean_q = re.sub(r"[^\w\s\-\/]", " ", question.lower()).strip()
    words = clean_q.split()

    pronouns = {"it", "its", "there", "his", "her", "their", "that", "this"}
    if any(w in pronouns for w in words):
        return True

    followup_patterns = [
        r"\b(?:opening|closing)?\s*(?:hours|timings|time)\b",
        r"\b(?:when|is it)\s*(?:open|closed)\b",
        r"\b(?:show|view|take me|locate)\s*(?:it\s*)?(?:on\s*(?:the\s*)?map)?\b",
        r"\b(?:directions|route|path|how to reach|how to go|how do i get there)\b",
        r"\b(?:what\s*)?(?:facilities|amenities|services)\b",
        r"\bwho\s*(?:sits|works|is)\s*(?:there|inside|in there)\b",
        r"\b(?:contact|phone|phone number|call)\b",
        r"\b(?:which|what)\s*(?:floor|room|cabin)\b",
        r"\b(?:tell me more|more details|more info)\b",
    ]
    for pattern in followup_patterns:
        if re.search(pattern, clean_q, re.I):
            return True

    if len(words) <= 4 and any(w in words for w in ["hours", "timings", "map", "directions", "reach", "floor", "cabin", "room"]):
        return True

    return False


def find_last_entity_record(
    last_entity: Optional[Any],
    history: Optional[List[Any]],
    records: List[Record],
) -> Optional[Record]:
    """Find the verified Record corresponding to the last confirmed entity or previous conversation topic."""
    if last_entity:
        last_id = getattr(last_entity, "id", None) or (last_entity.get("id") if isinstance(last_entity, dict) else None)
        last_name = getattr(last_entity, "name", None) or getattr(last_entity, "title", None) or (last_entity.get("name") or last_entity.get("title") if isinstance(last_entity, dict) else None)

        if last_id:
            for r in records:
                if r.id == last_id:
                    return r
        if last_name:
            target_name = str(last_name).lower().strip()
            for r in records:
                if r.name and r.name.lower().strip() == target_name:
                    return r
            for r in records:
                if r.name and target_name in r.name.lower():
                    return r

    if history:
        for msg in reversed(history):
            content = getattr(msg, "content", None) or (msg.get("content") if isinstance(msg, dict) else "")
            if not content:
                continue
            matches = find_structured_matches(content, records)
            if matches:
                return matches[0]
            b_m = re.search(r"\b(?:block|b)[\s-]*(\d{1,2})\b", content, re.I)
            if b_m:
                b_num = b_m.group(1)
                for r in records:
                    if r.block == b_num and not r.uid:
                        return r
                    if r.block == b_num:
                        return r
            for r in records:
                if r.name and len(r.name) > 3 and r.name.lower() in content.lower():
                    return r

    return None


def resolve_contextual_query(
    question: str,
    history: Optional[List[Any]],
    last_entity: Optional[Any],
    records: List[Record],
) -> Tuple[str, Optional[Record]]:
    """Resolve query taking conversational context into account."""
    if has_explicit_target(question, records):
        return question, None

    if is_followup_query(question):
        prev_record = find_last_entity_record(last_entity, history, records)
        if prev_record:
            entity_name = prev_record.name
            q_clean = question.lower().strip()

            if any(w in q_clean for w in ["hour", "timing", "open", "close"]):
                resolved = f"What are the opening hours and timings of {entity_name}?"
            elif any(w in q_clean for w in ["map", "where", "locate", "direction", "reach", "route", "take me"]):
                resolved = f"Where is {entity_name} on campus map and directions?"
            elif any(w in q_clean for w in ["cabin", "office", "sit", "room", "floor"]):
                resolved = f"Where is the cabin, room, and floor for {entity_name}?"
            elif any(w in q_clean for w in ["facility", "facilities", "amenity", "amenities", "inside"]):
                resolved = f"What facilities and services are inside {entity_name}?"
            elif any(w in q_clean for w in ["contact", "phone", "call"]):
                resolved = f"What is the contact information for {entity_name}?"
            else:
                resolved = f"{question} for {entity_name}"

            return resolved, prev_record

    return question, None


class Retriever:
    def __init__(self, records: List[Record], embeddings: List[List[float]]):
        assert len(records) == len(embeddings), "records/embeddings length mismatch"
        self.records = records
        matrix = np.array(embeddings, dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1e-8
        self._normed = matrix / norms

    def rank(
        self,
        query_embedding: List[float],
        query_text: str = "",
        top_k: int = TOP_K,
    ) -> List[Tuple[Record, float]]:
        structured_matches = []
        if query_text:
            structured_matches = find_structured_matches(query_text, self.records)

        q = np.array(query_embedding, dtype=np.float32)
        q_norm = np.linalg.norm(q)
        if q_norm == 0:
            q_norm = 1e-8
        q = q / q_norm

        if len(q) != self._normed.shape[1]:
            scores = np.zeros(len(self.records), dtype=np.float32)
        else:
            scores = self._normed @ q

        order = np.argsort(-scores)

        results: List[Tuple[Record, float]] = []
        seen_ids = set()

        for r in structured_matches:
            seen_ids.add(r.id)
            results.append((r, 1.0))

        for idx in order:
            rec = self.records[idx]
            if rec.id not in seen_ids:
                seen_ids.add(rec.id)
                results.append((rec, float(scores[idx])))
            if len(results) >= max(top_k, len(structured_matches)):
                break

        return results


def classify_match(top_score: float) -> str:
    """Return 'confident' | 'weak' | 'none' based on the top similarity score."""
    if top_score >= CONFIDENT_THRESHOLD:
        return "confident"
    if top_score >= WEAK_THRESHOLD:
        return "weak"
    return "none"
