# Campus Assistant — Prototype

A standalone, runnable prototype of the campus AI assistant, built to be
tested here before merging into your real project. Structure mirrors
your project's real file layout (`api/`, `js/`, `css/`, `tests/`) so
merging later is mostly copy-paste.

## What's already been verified (offline, no API key needed)

- `api/data_loader.py` was run against your **actual** `js/data.js` —
  it correctly parses 2 groups, 18 locations, and 1 office (21 records
  total) into normalized text blobs.
- `api/retrieval.py`'s ranking + confidence-tier logic (`confident` /
  `weak` / `none`) was run end-to-end against your real data using a
  deterministic word-overlap stand-in for embeddings (see "About the
  test mocks" below) — it correctly retrieves `uni-health-center` for
  a medical question, correctly returns `none` for a question with no
  matching data (e.g. cafeteria/food — you don't have any food records
  yet), and correctly nulls `locationId`/`title` on no-match.
- All 4 tests in `tests/test_chat.py` pass against your real data
  using this same offline logic.

**Not yet verified: real Gemini embedding/generation quality.** This
sandbox has no internet access, so I could not call the live Gemini
API. That's the one thing you need to test locally — everything else
(parsing, ranking, fallback tiers, endpoint contract, frontend wiring)
has been exercised against your real data already.

## About the test mocks

`tests/test_chat.py` monkeypatches the Gemini calls with a
deterministic bag-of-words "embedding" (stopword-filtered, hashed into
a 256-dim vector). Two bugs were caught and fixed while building this:
Python's built-in `hash()` is randomized per process (fixed by using
`zlib.crc32` instead), and raw word counts let repeated tags/desc
words skew a record's vector magnitude (fixed by de-duplicating tokens
per record). This proves the *pipeline logic* is correct; it says
nothing about real Gemini embedding quality, which you should
sanity-check manually once you have a key.

## Setup

```bash
cd campus-assistant
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env and paste your Gemini API key (from https://aistudio.google.com/apikey)
```

## Run

```bash
uvicorn api.main:app --reload --app-dir .
```

Then open http://127.0.0.1:8000 — you'll see a placeholder page (your
real map isn't part of this prototype) with the chat panel in the
bottom-right corner. Try:

- "Where can I get medical help?" → should find Uni Health Center with
  a "Show on map" button.
- "What's on the cafeteria menu?" → should get an honest "I don't have
  that" fallback, since your dataset has no food records yet.

## Run tests

```bash
pytest tests/ -v
```

These run offline (no API key needed) since Gemini calls are mocked.

## Tuning retrieval thresholds

`api/retrieval.py` has `RETRIEVAL_CONFIDENT_THRESHOLD` (default 0.60)
and `RETRIEVAL_WEAK_THRESHOLD` (default 0.45), overridable via env
vars. These are starting points based on typical Gemini embedding
similarity distributions — once you're testing with the real API and
your full dataset, watch a few real queries and adjust if confident
matches feel too strict/loose.

## Merging into your real project

| This prototype | Merges into |
|---|---|
| `api/data_loader.py`, `api/retrieval.py`, `api/gemini_client.py` | Copy as-is into your `api/` |
| `api/main.py`'s `/api/chat` route (and lifespan startup block) | Merge into your real `api/main.py`, **before** its `app.mount("/", StaticFiles(...))` line |
| `js/assistant.js` | Copy as-is |
| `js/ui.js` | **Don't copy** — it's a demo stub. In your real `UIController`, just add `'assistant'` to the view list |
| `js/app.js` | **Don't copy** — just add the two `AssistantController` lines to your real init sequence (see comment in the file) |
| `css/panels.css` | Append the `.assistant-*` block to your real `css/panels.css` |
| `tests/test_chat.py` | Copy as-is (adjust the `sys.path` line if your real project structures imports differently) |

Everything is commented inline with `MERGE NOTE:` where a file is
demo-only vs. a real drop-in.
