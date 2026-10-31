# LPUNavix Project Memory & State

## Architecture & Technology Stack
- **Backend**: FastAPI (Python 3.14, Uvicorn)
- **Primary Retrieval**: Canonical Campus Property Knowledge Graph (`data.js`) + Gemini Vector Embeddings (`gemini-embedding-001`, 3072 dimensions)
- **Primary LLM Generation**: Google Gemini 2.5 Flash (`gemini-2.5-flash` via `google-genai` SDK) with multi-model fallback (`gemini-2.5-flash-lite`, `gemini-1.5-flash`)
- **Strict Data Grounding**: All responses strictly grounded in `data.js`. Absolutely zero hallucinated buildings or dining halls.
- **Dynamic Conversational Engine**: Comprehensive interactive conversational resolver (`resolve_conversational_interaction`) handling fillers (`hmm`, `um`), confirmations (`ok`, `cool`), gratitude (`thanks`), greetings, farewells, and chatter with real conversational memory.
- **Ollama Status**: Completely eliminated from the codebase (no local 11434 daemon, no background threads, no config variables).

## Verified Test Suites
- `pytest tests/`: 36 / 36 passed.
- `tests/validate_user_test_cases.py`: 9 / 9 passed.
- `pytest tests/test_criteria.py`: 3 / 3 passed.
  - Criterion 1: 0 negative queries in confident tier.
  - Criterion 2: >= 90% of typo queries resolve at rank 1.
  - Criterion 3: "how many HODs" returns 13 from data_loader.

## Key Fixes Applied
1. **Interactive Conversational Engine**:
   - Fixed regex boundary issue that previously prevented chitchat detection.
   - Added contextual handling for hesitation/thinking phrases (`hmm`, `hmmm`, `um`, `well`): dynamically checks `last_entity` from conversation history and invites the user to continue or explore nearby places, eliminating the robotic `"couldn't find matching record related to 'hmm'"`.
   - Handled acknowledgments (`ok`, `cool`, `got it`, `sure`), gratitude (`thanks`, `thank you`), positive feedback (`nice`, `great`), and farewells (`bye`, `see you`).
   - Removed robotic `"Hmm, "` prefix from fallback error messages.
2. **Ollama Complete Removal**:
   - Cleared `OLLAMA_HOST` and `OLLAMA_MODEL` from `.env`.
   - Removed `_warmup_ollama` and background threads from `api/main.py`.
   - Replaced all local Ollama HTTP requests in `api/agent.py` with `api.gemini_client.generate_reply`.
3. **Stopwords & Token Booster Fix (`api/vector_store.py`)**:
   - Expanded `_STOPWORDS` to cover all English pronouns (`you`, `your`, `we`, `they`, etc.), conversational verbs (`how`, `are`, `is`, etc.), and filler words.
   - Guarded subword token boosting so low-similarity queries (< 0.20 cosine) are never boosted to 0.900 confident tier.
   - Eliminated false matches for "how are you" (previously boosted `conn-33-34` to 0.900).
4. **Healthcare & Hospital Intent**:
   - "not feeling well", "hospital", "clinic", "doctor", "injured", "headache" route directly to `Uni Health Center` with location card and directions, preventing incorrect routing to DSR/DSW or canned refusals.
5. **Food Grounding (Anti-Hallucination)**:
   - Specific food queries (e.g. "paneer doss", "pizza", "burger") explain that while individual dish menus are not itemized, UniMall Food Court and block tuck shops offer complete multi-cuisine options. Strictly forbids inventing non-existent buildings (like "North Block, Dining Hall 2").
6. **Dynamic LLM Generation**:
   - "lost" queries now pass campus boundary and landmark context into dynamic LLM synthesis rather than returning static canned text.
7. **Semantic Vector Entity Resolution & LLM Thinking for Navigation**:
   - Upgraded 
esolve_location_token with Step 3 Vector Semantic Resolution Fallback (campus_vectors.npy 3072-dim). Unfamiliar, misspelled, or slang tokens (e.g. 'indoor badminton', 'reading room', 'vehicle entrance', 'unihealth') automatically resolve to authentic campus entities and coordinates.
   - Added extract_navigation_route_via_llm powered by Gemini Reasoning & Thinking with structured JSON output, allowing the agent to extract navigation intent and endpoints from natural conversational requests when regex templates don't match.
