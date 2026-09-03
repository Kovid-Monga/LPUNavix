import sys, os
if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from api.rag import load_campus_records, retrieve_relevant_records

records = load_campus_records()
queries = [
    'Where is CSE department?',
    'Where is Block 28?',
    'Where is Room 209?',
    'Where is Lost and Found?',
    'Where can I report a lost item?',
    'Where is health center?',
    'Where is School of Fashion Design?',
    'Where is vehicle parking?',
    'What are the timings of administrative office in Block 28?',
    'Where to go for infrastructure queries?',
    'Who do I ask about faculty details?',
    'Where are the computer labs in block 25?'
]

for q in queries:
    res = retrieve_relevant_records(q, records, limit=3)
    print(f"Q: {q}")
    if res:
        for r in res:
            print(f"   -> [{r['score']}] {r['name']} ({r['kind']}) (matches: {r['matches']})")
    else:
        print("   -> NO MATCH")
    print()
