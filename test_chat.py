#!/usr/bin/env python3
import sys
import os
sys.path.insert(0, '.')
os.chdir('d:\\LPUNavix')

from api.rag import load_campus_records, retrieve_relevant_records, generate_chat_reply

# Test loading campus records
try:
    records = load_campus_records()
    print(f"Loaded {len(records)} campus records")
except Exception as e:
    print(f"Error loading records: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test retrieval
try:
    message = "Where is block A?"
    relevant = retrieve_relevant_records(message, records, limit=5)
    print(f"Found {len(relevant)} relevant records")
    for r in relevant:
        print(f"  - {r['name']} (score: {r['score']})")
except Exception as e:
    print(f"Error retrieving records: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test chat reply
try:
    if relevant:
        reply = generate_chat_reply(message, relevant)
        print(f"Reply: {reply}")
    else:
        print("No relevant records found")
except Exception as e:
    print(f"Error generating reply: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
