#!/usr/bin/env python3
import sys
import os
from pathlib import Path

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

ROOT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT_DIR))

from api.rag import load_campus_records, retrieve_relevant_records, generate_chat_reply

records = load_campus_records()
print(f"=== Total Loaded Campus Records: {len(records)} ===\n")

test_questions = [
    "Where is Block 28?",
    "Where can I report a lost item?",
    "Where is the CSE department?",
    "Where is Uni Health Center?",
    "What services does the office in Room 209 provide?",
    "Where can I park my vehicle?",
]

for question in test_questions:
    print(f"User: {question}")
    relevant = retrieve_relevant_records(question, records, limit=3)
    reply = generate_chat_reply(question, relevant)
    print("Bot Reply:")
    print(reply)
    print("-" * 60)
