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

    # 6. Block-only queries asking about personnel (e.g. "Who sits in Block 27", "Who works in Block 28")
    if block_m and any(w in clean_q for w in ["who", "works", "sits", "located", "people", "faculty", "staff"]):
        b_val = block_m.group(1)
        for r in records:
            if r.block == b_val and r.uid:
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

