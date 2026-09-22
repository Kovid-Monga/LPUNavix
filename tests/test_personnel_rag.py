"""
tests/test_personnel_rag.py
===========================
Comprehensive validation of:
1. All 44 personnel records from js/data.js
2. Exact fields (UID, Name, Designation, Role, Department, Block, Room, Seating, Office, Notation)
3. Seating normalization rules and missing information rules
4. Duplicate UID 16870 preservation
5. RAG retrieval and /api/chat resolution across all required query patterns
"""

import os
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import api.main as main_module
import api.rag as rag_module
from api.data_loader import load_records, Record
from api.retrieval import find_structured_matches


# Expected 44 personnel entries
EXPECTED_PERSONNEL = [
    # Section A
    {"name": "Dr. Arun Malik", "uid": "17442", "designation": "Professor & Associate Dean", "role": "HOS", "block": "27", "room": "201", "seating": None, "office": "HOS Office"},
    {"name": "Dr. Baljit Singh Saini", "uid": "22078", "designation": "Professor", "role": "COD", "block": "27", "room": "203", "seating": "C3", "office": None},
    {"name": "Dr. Rajeev Kumar Patial", "uid": "12301", "designation": "Associate Professor", "role": "COD", "block": "28", "room": "206", "seating": "C1", "office": None},
    {"name": "Dr. Harminder Singh Saggu", "uid": "11530", "designation": "Professor", "role": "COD", "block": "28", "room": "206", "seating": "C3", "office": None},
    {"name": "Dr. Simarjit Singh Malhi", "uid": "28260", "designation": "Associate Professor", "role": "COD", "block": "27", "room": "205", "seating": "C1", "office": None},
    {"name": "Mr. Sourabh Kaul", "uid": "34813", "designation": "Administrator", "role": "Administrator", "block": "27", "room": "206", "seating": None, "office": "Administrator Office"},
    {"name": "Dr. Chirag Sharma", "uid": "16717", "designation": "Associate Professor", "role": "COD", "block": "27", "room": "207", "seating": "C1", "office": None},
    {"name": "Dr. Richa Jain", "uid": "17688", "designation": "Associate Professor", "role": "COD", "block": "27", "room": "209", "seating": "C1", "office": None},
    {"name": "Dr. Amritpal Singh", "uid": "17673", "designation": "Associate Professor", "role": "COD", "block": "27", "room": "102", "seating": "C1", "office": None},
    {"name": "Dr. Mohit Arora", "uid": "15980", "designation": "Associate Professor", "role": "COD", "block": "27", "room": "102", "seating": "C3", "office": None},
    {"name": "Dr. Dalwinder Singh", "uid": "11265", "designation": "Professor/Deputy Director", "role": "COS", "block": "28", "room": "201A", "seating": None, "office": "COS Office"},
    {"name": "Dr. Gursharan Singh", "uid": "16967", "designation": "Associate Professor", "role": "COD", "block": "28", "room": "202", "seating": "C2", "office": None},
    {"name": "Janpreet Singh", "uid": "11266", "designation": "Assistant Professor", "role": "COD", "block": "28", "room": "202", "seating": "C3", "office": None},
    {"name": "Dr. Robin Prakash Mathur", "uid": "14597", "designation": "Associate Professor", "role": "COD", "block": "28", "room": "203", "seating": "C1", "office": None},
    # Section B
    {"name": "Dr. Neeraj Sharma", "uid": "32821", "designation": "Professor and Dean", "role": "HOS", "block": "34", "room": "201B", "seating": None, "office": "HOS Office"},
    {"name": "Dr. Parminder Singh", "uid": "16479", "designation": "Prof. dy Dean", "role": "COS", "block": "34", "room": "309", "seating": None, "office": None, "notation": "34-309"},
    {"name": "Dr. Rachit Garg", "uid": "25708", "designation": "Deputy Dean", "role": "Administrator", "block": "34", "room": "206", "seating": None, "office": "Administrator Office"},
    {"name": "Mr. Ajay Kaler", "uid": "11427", "designation": "Sr. Officer", "role": "Admin", "block": "34", "room": "208", "seating": None, "office": None, "notation": "34-208"},
    # Section C - HODs
    {"name": "Dr. Makul Mahajan", "uid": "14575", "designation": "Associate Professor", "role": "HOD", "dept": "Data Science and Big Data", "block": "34", "room": "209", "seating": "C1", "notation": "34-209-C1"},
    {"name": "Dr. Harjeet Kaur", "uid": "12427", "designation": "Associate Professor", "role": "HOD", "dept": "Artificial Intelligence and Machine Learning", "block": "33", "room": "205", "seating": "C1", "notation": "33-205-C1"},
    {"name": "Dr. Manjit Kaur", "uid": "12438", "designation": "Professor", "role": "HOD", "dept": "Cloud Computing", "block": "34", "room": "202", "seating": "C1", "notation": "34-202-C1"},
    {"name": "Dr. Atul Malhotra", "uid": "16870", "designation": "Associate Professor", "role": "HOD", "dept": "Network and Cyber Security", "block": "34", "room": "202", "seating": "C3", "notation": "34-202-C3"},
    {"name": "Dr. Vijay Kumar Garg", "uid": "14085", "designation": "Professor", "role": "HOD", "dept": "Programming", "block": "36", "room": "307", "seating": "C1", "notation": "36-307-C1"},
    {"name": "Dr. Max Bhatia", "uid": "16870", "designation": "Associate Professor", "role": "HOD", "dept": "Software Testing and Methodologies", "block": "34", "room": "207", "seating": "C2", "notation": "34-207-C2"},
    {"name": "Pushpendra Kumar Pateriya", "uid": "14623", "designation": "Assistant Professor", "role": "HOD", "dept": "Full Stack Application Development", "block": "34", "room": "204", "seating": "C1", "notation": "34-204-C1"},
    {"name": "Dr. Richa Sharma", "uid": "18364", "designation": "Associate Professor", "role": "HOD", "dept": "DevOps", "block": "36", "room": "309A", "seating": "C2", "notation": "36-309A-C2"},
    {"name": "Dr. Deepak Kumar", "uid": "11360", "designation": "Professor and Assistant Dean", "role": "HOD", "dept": "Mathematics", "block": "38", "room": "301", "seating": "C1", "notation": "38-301-C1"},
    {"name": "Dr. Gurpinder Singh", "uid": "13608", "designation": "Professor", "role": "HOD", "dept": "Chemistry", "block": "33", "room": "209", "seating": "C1", "notation": "33-209-C1"},
    {"name": "Dr. Pawandeep Kaur", "uid": "12284", "designation": "Associate Professor", "role": "HOD", "dept": "ECE", "block": "33", "room": "215", "seating": "C1", "notation": "33-215-C1"},
    {"name": "Mr. Tejinder Thind", "uid": "15312", "designation": "Assistant Professor", "role": "HOD", "dept": "HOL", "block": "34", "room": "203", "seating": "C3", "notation": "34-203-C3"},
    {"name": "Amandeep Kaur", "uid": "11384", "designation": "Assistant Professor", "role": "HOD", "dept": "Academic Operations", "block": "34", "room": "205", "seating": "C2", "notation": "34-205-C2"},
    # Section D
    {"name": "Dr. Vikas Verma", "uid": "11361", "designation": "Associate Professor & Additional Dean", "role": "HOS", "block": "26", "room": "201A", "seating": None, "office": "HOS Office"},
    {"name": "Raj Karan Singh", "uid": "14307", "designation": "Assistant Professor & Assistant Dean", "role": "COS", "block": "26", "room": "207", "seating": None, "office": "COS Office"},
    {"name": "Dr. Vinay Anand", "uid": "34786", "designation": "Associate Professor & Administrator", "role": "Administrator", "block": "26", "room": "204B", "seating": None, "office": "Administrator Office"},
    {"name": "Dr. Shilpa Sharma", "uid": "13891", "designation": "Professor", "role": "COD", "block": "25", "room": "301", "seating": "C2", "office": None},
    {"name": "Dr. Isha Batra", "uid": "17451", "designation": "Professor", "role": "COD", "block": "25", "room": "301", "seating": "C3", "office": None},
    {"name": "Dr. Virat Deveser", "uid": "14591", "designation": "Professor", "role": "COD", "block": "26", "room": "202", "seating": "C1", "office": None},
    {"name": "Arvind Kumar", "uid": "16921", "designation": "Assistant Professor", "role": "COD", "block": "26", "room": "202", "seating": "C3", "office": None},
    {"name": "Dr. Avinash Kaur", "uid": "14557", "designation": "Professor", "role": "COD", "block": "26", "room": "203", "seating": "C1", "office": None},
    {"name": "Dr. Parampreet Kaur", "uid": "18758", "designation": "Associate Professor", "role": "COD", "block": "27", "room": "203", "seating": "C3", "office": None},
    {"name": "Dr. Subhita", "uid": "20260", "designation": "Assistant Professor", "role": "COD", "block": "26", "room": "205", "seating": "C1", "office": None},
    {"name": "Dr. Gurpreet Singh Bhatia", "uid": "11518", "designation": "Associate Professor", "role": "COD", "block": "38", "room": "507", "seating": "C1", "office": None},
    {"name": "Dr. Harwant Singh Arri", "uid": "12975", "designation": "Professor", "role": "COD", "block": "26", "room": "203", "seating": "C4", "office": None},
    {"name": "Timan Kumar", "uid": "13815", "designation": "Officer", "role": "Admin Officer", "block": "26", "room": "204", "seating": None, "office": "Admin Office"},
]


def test_all_44_records_loaded_and_fields_match():
    data_path = PROJECT_ROOT / "js" / "data.js"
    records = load_records(data_path)
    personnel_records = [r for r in records if r.uid is not None]

    assert len(personnel_records) == 44, f"Expected 44 personnel records, found {len(personnel_records)}"

    # Verify duplicate UID 16870
    uid_16870 = [r for r in personnel_records if r.uid == "16870"]
    assert len(uid_16870) == 2, "UID 16870 must exist twice"
    names_16870 = {r.name for r in uid_16870}
    assert names_16870 == {"Dr. Atul Malhotra", "Dr. Max Bhatia"}

    # Verify Parminder Singh has NO seating and notation 34-309
    p_parminder = [r for r in personnel_records if "Parminder" in r.name][0]
    assert p_parminder.seating is None, "Dr. Parminder Singh seating must be None"
    assert p_parminder.location_notation == "34-309"

    # Verify Ajay Kaler has NO seating and notation 34-208
    p_ajay = [r for r in personnel_records if "Ajay" in r.name][0]
    assert p_ajay.seating is None, "Mr. Ajay Kaler seating must be None"
    assert p_ajay.location_notation == "34-208"

    # Check each of the expected 44 records
    for exp in EXPECTED_PERSONNEL:
        # Match by UID and Name
        matched = [r for r in personnel_records if r.uid == exp["uid"] and r.name == exp["name"]]
        assert len(matched) == 1, f"Missing or duplicate record for {exp['name']} ({exp['uid']})"
        rec = matched[0]
        assert rec.designation == exp["designation"]
        assert rec.role == exp["role"]
        assert rec.block == exp["block"]
        assert rec.room == exp["room"]
        assert rec.seating == exp["seating"]
        if "office" in exp:
            assert rec.office == exp["office"]
        if "dept" in exp:
            assert rec.department_or_subject == exp["dept"]
        if "notation" in exp:
            assert rec.location_notation == exp["notation"]


def test_structured_retrieval_all_query_categories():
    data_path = PROJECT_ROOT / "js" / "data.js"
    records = load_records(data_path)

    test_cases = [
        # HOD queries:
        ("Who is the HOD of Data Science and Big Data?", ["Dr. Makul Mahajan"]),
        ("Who is the HOD of Artificial Intelligence and Machine Learning?", ["Dr. Harjeet Kaur"]),
        ("Who is the HOD of AI and ML?", ["Dr. Harjeet Kaur"]),
        ("Who heads Cloud Computing?", ["Dr. Manjit Kaur"]),
        ("Who is the HOD of Network and Cyber Security?", ["Dr. Atul Malhotra"]),
        ("Who is the HOD of Programming?", ["Dr. Vijay Kumar Garg"]),
        ("Who is the HOD of Software Testing?", ["Dr. Max Bhatia"]),
        ("Who heads Full Stack Application Development?", ["Pushpendra Kumar Pateriya"]),
        ("Who is the HOD of DevOps?", ["Dr. Richa Sharma"]),
        ("Who is the HOD of Mathematics?", ["Dr. Deepak Kumar"]),
        ("Who is the HOD of Chemistry?", ["Dr. Gurpinder Singh"]),
        ("Who is the HOD of ECE?", ["Dr. Pawandeep Kaur"]),
        ("Who is the HOD of HOL?", ["Mr. Tejinder Thind"]),
        ("Who is the HOD of Academic Operations?", ["Amandeep Kaur"]),

        # PERSON LOCATION QUERIES:
        ("Where is Dr. Makul Mahajan?", ["Dr. Makul Mahajan"]),
        ("Where does Dr. Harjeet Kaur sit?", ["Dr. Harjeet Kaur"]),
        ("Where can I find Dr. Atul Malhotra?", ["Dr. Atul Malhotra"]),
        ("Where is Dr. Richa Sharma?", ["Dr. Richa Sharma"]),
        ("Where is Dr. Arun Malik?", ["Dr. Arun Malik"]),
        ("Where does Dr. Deepak Kumar sit?", ["Dr. Deepak Kumar"]),
        ("Where is Mr. Tejinder Thind?", ["Mr. Tejinder Thind"]),

        # ROLE QUERIES:
        ("Who is the HOS?", ["Dr. Arun Malik", "Dr. Neeraj Sharma", "Dr. Vikas Verma"]),
        ("Who is the COS?", ["Dr. Dalwinder Singh", "Dr. Parminder Singh", "Raj Karan Singh"]),
        ("Who is the administrator?", ["Mr. Sourabh Kaul", "Dr. Rachit Garg", "Dr. Vinay Anand"]),
        ("Where is the HOS office?", ["Dr. Arun Malik", "Dr. Neeraj Sharma", "Dr. Vikas Verma"]),
        ("Where is the COS office?", ["Dr. Dalwinder Singh", "Raj Karan Singh"]),
        ("Where is the administrator office?", ["Mr. Sourabh Kaul", "Dr. Rachit Garg", "Dr. Vinay Anand"]),

        # BLOCK QUERIES:
        ("Who sits in Block 27?", ["Dr. Arun Malik", "Dr. Baljit Singh Saini", "Dr. Simarjit Singh Malhi"]),
        ("Who works in Block 28?", ["Dr. Rajeev Kumar Patial", "Dr. Harminder Singh Saggu"]),
        ("Who is located in Block 26?", ["Dr. Vikas Verma", "Raj Karan Singh"]),
        ("Who sits in Block 34?", ["Dr. Neeraj Sharma", "Dr. Parminder Singh", "Dr. Makul Mahajan"]),

        # ROOM QUERIES:
        ("Who sits in Room 202 of Block 28?", ["Dr. Gursharan Singh", "Janpreet Singh"]),
        ("Who sits in Room 301 of Block 25?", ["Dr. Shilpa Sharma", "Dr. Isha Batra"]),
        ("Who is in Block 34 Room 202?", ["Dr. Manjit Kaur", "Dr. Atul Malhotra"]),
        ("Who is in 34-202-C3?", ["Dr. Atul Malhotra"]),
        ("Who is in 34-209-C1?", ["Dr. Makul Mahajan"]),

        # UID QUERIES:
        ("Who is UID 14575?", ["Dr. Makul Mahajan"]),
        ("Who is UID 17442?", ["Dr. Arun Malik"]),
        ("Who is UID 16870?", ["Dr. Atul Malhotra", "Dr. Max Bhatia"]),
        ("Where is UID 18364?", ["Dr. Richa Sharma"]),

        # NATURAL LANGUAGE QUERIES:
        ("Where can I find the DevOps HOD?", ["Dr. Richa Sharma"]),
        ("I need to meet the AI and ML HOD.", ["Dr. Harjeet Kaur"]),
        ("Where is the HOD for Data Science?", ["Dr. Makul Mahajan"]),
        ("Who handles Network and Cyber Security?", ["Dr. Atul Malhotra"]),
        ("Where does the Programming HOD sit?", ["Dr. Vijay Kumar Garg"]),
        ("Which block has the HOS?", ["Dr. Arun Malik", "Dr. Neeraj Sharma", "Dr. Vikas Verma"]),
        ("Where can I find the COS?", ["Dr. Dalwinder Singh", "Dr. Parminder Singh", "Raj Karan Singh"]),
        ("Who should I contact for Academic Operations?", ["Amandeep Kaur"]),
    ]

    for q, expected in test_cases:
        matches = find_structured_matches(q, records)
        matched_names = [m.name for m in matches]
        for exp in expected:
            assert exp in matched_names, f"Query '{q}' failed to retrieve {exp}. Retrieved: {matched_names}"


def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    import zlib, re
    dim = 256
    vectors = []
    for text in texts:
        vec = [0.0] * dim
        tokens = {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 1}
        for word in tokens:
            vec[zlib.crc32(word.encode()) % dim] += 1.0
        vectors.append(vec)
    return vectors


def _fake_embed_query(text: str) -> list[float]:
    return _fake_embed_texts([text])[0]


def _fake_generate_reply(question: str, context_records: list[dict], match_quality: str, **kwargs) -> str:
    if match_quality == "none":
        return "I don't have anything on that in the campus data."
    if not context_records:
        return "No records found."
    first = context_records[0]
    hours = first.get("hours", "")
    hours_info = f", Hours: {hours}" if hours else ""
    return f"{first.get('name')} is located in Block {first.get('block')}, Room {first.get('room')}{hours_info}."


@pytest.fixture
def chat_client(monkeypatch):
    monkeypatch.setattr(main_module, "embed_texts", _fake_embed_texts)
    monkeypatch.setattr(main_module, "embed_query", _fake_embed_query)
    monkeypatch.setattr(main_module, "generate_reply", _fake_generate_reply)
    monkeypatch.setattr(rag_module, "embed_texts", _fake_embed_texts)
    monkeypatch.setattr(rag_module, "embed_query", _fake_embed_query)
    monkeypatch.setattr(rag_module, "generate_reply", _fake_generate_reply)
    with TestClient(main_module.app) as c:
        yield c


def test_chat_endpoint_retrieves_personnel_with_location_id(chat_client):
    # Test HOD query
    resp = chat_client.post("/api/chat", json={"message": "Who is the HOD of DevOps?"})
    assert resp.status_code == 200
    data = resp.json()
    assert "Dr. Richa Sharma" in data["reply"] or "Richa Sharma" in data["title"]
    assert data["locationId"] is not None

    # Test UID query
    resp = chat_client.post("/api/chat", json={"message": "Who is UID 14575?"})
    assert resp.status_code == 200
    data = resp.json()
    assert "Dr. Makul Mahajan" in data["reply"] or "Makul Mahajan" in data["title"]
    assert data["locationId"] is not None

    # Test Notation query
    resp = chat_client.post("/api/chat", json={"message": "Who is in 34-202-C3?"})
    assert resp.status_code == 200
    data = resp.json()
    assert "Dr. Atul Malhotra" in data["reply"] or "Atul Malhotra" in data["title"]
    assert data["locationId"] is not None


def test_standalone_ambiguous_question_triggers_clarification(chat_client):
    """Requirement 3: An incomplete question without previous topic must not guess or invent a place."""
    resp = chat_client.post("/api/chat", json={"message": "What are its opening hours?"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["locationId"] is None
    assert "don't have" in data["reply"].lower() or "no records" in data["reply"].lower()

    resp_map = chat_client.post("/api/chat", json={"message": "Show it on map"})
    assert resp_map.status_code == 200
    data_map = resp_map.json()
    assert data_map["locationId"] is None


def test_followup_question_correctly_uses_previous_topic(chat_client):
    """Requirement 2: Follow-up questions resolve to the earlier topic naturally."""
    # 1. Turn 1: Ask about Block 28
    resp1 = chat_client.post("/api/chat", json={"message": "Where is Block 28?"})
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["locationId"] == "block-28"

    # 2. Turn 2: Follow-up asking for opening hours
    resp2 = chat_client.post(
        "/api/chat",
        json={
            "message": "What are its opening hours?",
            "history": [
                {"role": "user", "content": "Where is Block 28?"},
                {"role": "assistant", "content": data1["reply"]},
            ],
            "last_entity": {"id": "block-28", "name": "Block 28"},
        },
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["locationId"] == "block-28"
    assert "Block 28" in data2["title"]
    assert "Hours: 8:00 AM - 5:30 PM" in data2["reply"] or "Block 28" in data2["reply"]

    # 3. Turn 3: Follow-up asking to show on map
    resp3 = chat_client.post(
        "/api/chat",
        json={
            "message": "Show it on map",
            "last_entity": {"id": "block-28", "name": "Block 28"},
        },
    )
    assert resp3.status_code == 200
    data3 = resp3.json()
    assert data3["locationId"] == "block-28"
    assert "Block 28" in data3["title"]


def test_explicit_new_location_overrides_prior_context(chat_client):
    """Requirement 4: An explicit new place or person in current message overrides prior context."""
    # Even though last_entity was Block 28, user asks explicitly about Block 34
    resp = chat_client.post(
        "/api/chat",
        json={
            "message": "Where is Block 34?",
            "history": [
                {"role": "user", "content": "Where is Block 28?"},
                {"role": "assistant", "content": "Block 28 is located in Block 28"},
            ],
            "last_entity": {"id": "block-28", "name": "Block 28"},
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["locationId"] == "block-34"
    assert "Block 34" in data["title"]


def test_faculty_cabin_conversational_context(chat_client):
    """Requirement 2: Faculty/personnel follow-ups resolve cabin and directions."""
    # Turn 1: Find HOD of DevOps
    resp1 = chat_client.post("/api/chat", json={"message": "Where can I find the DevOps HOD?"})
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["locationId"] is not None
    assert "Richa Sharma" in data1["title"] or "Richa Sharma" in data1["reply"]

    # Turn 2: Follow-up asking for cabin
    resp2 = chat_client.post(
        "/api/chat",
        json={
            "message": "Where is her cabin?",
            "history": [
                {"role": "user", "content": "Where can I find the DevOps HOD?"},
                {"role": "assistant", "content": data1["reply"]},
            ],
            "last_entity": {"id": data1["locationId"], "name": "Dr. Richa Sharma"},
        },
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["locationId"] == data1["locationId"]
    assert "Richa Sharma" in data2["title"] or "Richa Sharma" in data2["reply"]
