"""
In-memory semantic and structured search over the normalized campus records.
No vector DB — the dataset is small enough that a linear scan over
NumPy arrays is effectively instant.
"""

import os
import re
from typing import List, Tuple

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


def find_structured_matches(query: str, records: list[Record]) -> list[Record]:
    """Perform deterministic, structured matching for UIDs, location notations,
    person names, HOD departments, blocks, rooms, and administrative roles.
    """
    q = query.lower().strip()
    clean_q = re.sub(r"[^\w\s\-\/]", " ", q)
    words = clean_q.split()

    matches: list[Record] = []
    seen_ids = set()

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
    block_m = re.search(r"\bblock\s*(\d{2})\b", clean_q)
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
    # e.g. "Where can I buy stationery?", "Where are the tuck shops?", "Is there a stationery shop in Block 26?",
    # "Where can I buy pens, notebooks, or other stationery?", "Which blocks have stationery shops in their basements?"
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
                # If queried about a block without a tuck shop (e.g. Block 25), return all 4 tuck shops so assistant can explain where they are
                for tuck_id in ["tuck-shop-block-26", "tuck-shop-block-27", "tuck-shop-block-28", "tuck-shop-block-36"]:
                    for r in records:
                        if r.id == tuck_id:
                            add(r)
                if matches:
                    return matches
        else:
            # General stationery query -> return all four known basement locations
            for tuck_id in ["tuck-shop-block-26", "tuck-shop-block-27", "tuck-shop-block-28", "tuck-shop-block-36"]:
                for r in records:
                    if r.id == tuck_id:
                        add(r)
            if matches:
                return matches

    # 5.7 Division of Admissions & Block 29 queries
    # e.g. "Where is the Division of Admissions?", "Where should I go for admission-related queries?", "Which block handles admissions?"
    is_admission_query = bool(
        re.search(
            r"\b(admission|admissions|division\s+of\s+admissions|admission\s+queries|admission\s+office|admission\s+counseling)\b",
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
    # e.g. "Where is Unipolis?", "Where are major university events held?", "Where should students report initially?"
    is_unipolis_query = bool(
        re.search(
            r"\b(unipolis|major\s+university\s+events|university\s+events\s+held|events\s+held|initial\s+student\s+reporting|report\s+initially|initial\s+reporting|student\s+reporting|mega\s+auditorium|event\s+arena)\b",
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
    # e.g. "Where is UniMall?", "Where can I find the mall on campus?", "Where is the mall?"
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
    # e.g. "Where is the Sports Complex?", "Where can I play indoor sports?"
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

    # 6. Block queries (e.g. "Who sits in Block 27", "Where is Block 28", "Block 34")
    if block_m:
        b_val = block_m.group(1)
        if any(w in clean_q for w in ["who", "works", "sits", "people", "faculty", "staff"]):
            for r in records:
                if r.block == b_val and r.uid:
                    add(r)
        else:
            # Query is asking about the block itself (e.g. "Where is Block 28?", "Block 34")
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

    # 8. Placement Cell / TPC queries (e.g. "Where is the placement cell?", "Where is TPC?", "TPC Block 32")
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

    # 9. Central Library / Library queries (e.g. "Where is the central library?", "Library", "Library in pathway", "Which floor is the library?")
    is_lib_query = bool(
        re.search(r"\b(central\s+library|library|libraries|reading\s+room|study\s+room)\b", clean_q)
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

    # 10. Block 37 queries (e.g. "Where is Block 37?", "Block 37", "B37")
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

    # 12. Hostels / Studios / Apartments / Residential Area queries
    # e.g. "gh1", "gh-1", "gh 1", "girls hostel 1", "gh2", "gh 3", "gh4"
    # "gs 11", "gs11", "gs-11", "girls studio 11", "girls studios 11", "gs 12", "gs12"
    # "bh1", "bh-1", "bh 1", "boys hostel 1", "hostel 1", "bh2", "bh3", "bh5", "bh6"
    # "bs 11", "bs11", "bs-11", "boys studio 11", "bs 12", "bs 13"
    # "boys apartment ab", "apartment ab", "boys apartment cd", "apartment cd"
    # "residential area", "girls hostels", "girls studios", "boys hostels"

    # Girls Hostels (GH-1 to GH-4)
    gh_m = re.search(r"\b(?:gh|girls\s+hostel)[\s-]*([1-4])\b", clean_q)
    if gh_m:
        h_num = gh_m.group(1)
        target_id = f"gh-{h_num}"
        for r in records:
            if r.id == target_id:
                add(r)
        if matches:
            return matches

    # Girls Studios (GS-11 and GS-12)
    gs_m = re.search(r"\b(?:gs|girls\s+studio|girls\s+studios)[\s-]*(1[1-2])\b", clean_q)
    if gs_m:
        s_num = gs_m.group(1)
        target_id = f"gs-{s_num}"
        for r in records:
            if r.id == target_id:
                add(r)
        if matches:
            return matches

    # Boys Hostels (BH-1 to BH-6)
    bh_m = re.search(r"\b(?:bh|boys\s+hostel|hostel)[\s-]*([1-6])\b", clean_q)
    if bh_m:
        h_num = bh_m.group(1)
        target_id = f"bh-{h_num}"
        for r in records:
            if r.id == target_id:
                add(r)
        if matches:
            return matches

    # Boys Studios (BS-11 to BS-13)
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

    # Girls hostels queries (general)
    if re.search(r"\b(?:girls\s+hostel|girls\s+hostels|gh)\b", clean_q):
        for r in records:
            if r.id in ("gh-1", "gh-2", "gh-3", "gh-4"):
                add(r)
        if matches:
            return matches

    # Girls studios queries (general)
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

    # Boys hostels & studios queries (general)
    if re.search(r"\b(?:boys\s+residential\s+area|boys\s+hostel|boys\s+hostels|boys\s+studio|boys\s+studios|boys\s+apartment|boys\s+apartments)\b", clean_q):
        for r in records:
            if r.id == "residential-area":
                add(r)
        for r in records:
            if r.id in ("bh-1", "bh-2", "bh-3", "bh-5", "bh-6", "bs-11", "bs-12", "bs-13", "boys-apartment-ab", "boys-apartment-cd"):
                add(r)
        if matches:
            return matches

    # General campus accommodation queries
    if re.search(r"\b(?:residential\s+area|residential|hostels|hostel|where\s+to\s+stay|student\s+housing)\b", clean_q):
        for r in records:
            if r.id in ("girls-residential-area", "residential-area"):
                add(r)
        for r in records:
            if r.category == "hostels" and r.id not in ("residential-area", "girls-residential-area"):
                add(r)
        if matches:
            return matches

    return matches


class Retriever:
    def __init__(self, records: list[Record], embeddings: list[list[float]]):
        assert len(records) == len(embeddings), "records/embeddings length mismatch"
        self.records = records
        matrix = np.array(embeddings, dtype=np.float32)
        # Pre-normalize so similarity is a plain dot product.
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1e-8
        self._normed = matrix / norms

    def rank(
        self,
        query_embedding: list[float],
        query_text: str = "",
        top_k: int = TOP_K,
    ) -> list[tuple[Record, float]]:
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
            scores = self._normed @ q  # cosine similarity for every record
        order = np.argsort(-scores)

        results: list[tuple[Record, float]] = []
        seen_ids = set()

        # Prioritize structured matches with 1.0 confidence score
        for r in structured_matches:
            seen_ids.add(r.id)
            results.append((r, 1.0))

        # Fill with semantic ranking up to top_k
        for idx in order:
            rec = self.records[idx]
            if rec.id not in seen_ids:
                seen_ids.add(rec.id)
                results.append((rec, float(scores[idx])))
            if len(results) >= max(top_k, len(structured_matches)):
                break

        return results


def classify_match(top_score: float) -> str:
    """Return "confident" | "weak" | "none" based on the top similarity score."""
    if top_score >= CONFIDENT_THRESHOLD:
        return "confident"
    if top_score >= WEAK_THRESHOLD:
        return "weak"
    return "none"

