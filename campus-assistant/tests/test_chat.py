"""
Tests for POST /api/chat.

Gemini embedding + generation calls are monkeypatched with a
deterministic, word-overlap-based stand-in so these tests run offline
and don't burn API quota. This verifies the retrieval/ranking/fallback
*logic* is correct; it does not verify real Gemini embedding quality
(you should sanity-check that separately against the live API).
"""

import re
import sys
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import api.main as main_module  # noqa: E402


_STOPWORDS = {
    "a", "an", "the", "is", "are", "on", "in", "at", "to", "of", "for", "and",
    "or", "i", "can", "get", "where", "what", "which", "find", "do", "does",
    "how", "me", "my", "campus", "lpu", "today", "s", "help", "near",
    "please", "tell", "about", "there",
}


def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    """Deterministic bag-of-words 'embedding' with stopwords filtered out
    — good enough to prove ranking/fallback logic works without calling
    the real API. (Without stopword filtering, common words like "on" and
    "campus" dominate and drown out the actual signal — caught this while
    testing against the real dataset, so keeping the filter. Uses
    zlib.crc32 rather than Python's built-in hash(), which is randomized
    per process and would make this test flaky across separate runs.
    Dimension is 256 and tokens are de-duplicated per text — both fixes
    came from running this against the real dataset: a smaller dimension
    caused hash collisions between unrelated words, and raw word counts
    let repeated tags/desc words skew a record's vector magnitude.)"""
    dim = 256
    vectors = []
    for text in texts:
        vec = [0.0] * dim
        tokens = {
            w for w in re.findall(r"[a-z0-9]+", text.lower())
            if w not in _STOPWORDS and len(w) > 1
        }
        for word in tokens:
            vec[zlib.crc32(word.encode()) % dim] += 1.0
        vectors.append(vec)
    return vectors


def _fake_embed_query(text: str) -> list[float]:
    return _fake_embed_texts([text])[0]


def _fake_generate_reply(question: str, context_records: list[dict], match_quality: str) -> str:
    if match_quality == "none":
        return (
            "I don't have anything on that in the campus data. I can help with "
            "buildings, hostels, food, offices, and departments though."
        )
    name = context_records[0]["name"] if context_records else "that place"
    if match_quality == "weak":
        return f"I don't have an exact match, but did you mean {name}?"
    return f"That's {name}."


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main_module, "embed_texts", _fake_embed_texts)
    monkeypatch.setattr(main_module, "embed_query", _fake_embed_query)
    monkeypatch.setattr(main_module, "generate_reply", _fake_generate_reply)
    with TestClient(main_module.app) as c:
        yield c


def test_known_location_is_retrieved(client):
    """A question that clearly matches a real record should retrieve it."""
    resp = client.post(
        "/api/chat",
        json={"message": "Where can I get medical help or first aid on campus?"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["locationId"] == "uni-health-center"
    assert data["title"] == "Uni Health Center"
    assert data["reply"]


def test_unrelated_question_gets_honest_fallback(client):
    """A question with no relevant data should get the honest fallback,
    not a dead-end apology, and should mention what the assistant can help with."""
    resp = client.post(
        "/api/chat",
        json={"message": "Completely unrelated gibberish query xyzzy plugh wibble"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert any(word in data["reply"].lower() for word in ["buildings", "hostels", "food", "offices"])


def test_fallback_locationid_and_title_are_null(client):
    """No-match responses must not point the map button at a location."""
    resp = client.post(
        "/api/chat",
        json={"message": "Completely unrelated gibberish query xyzzy plugh wibble"},
    )
    data = resp.json()
    assert data["locationId"] is None
    assert data["title"] is None


def test_empty_message_is_rejected(client):
    resp = client.post("/api/chat", json={"message": "   "})
    assert resp.status_code == 400
