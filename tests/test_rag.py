import unittest

from api.rag import retrieve_relevant_records


class TestRAGRetrieval(unittest.TestCase):
    def test_lost_item_query_returns_administrative_office(self):
        records = [
            {
                "id": "cse-dept",
                "kind": "group",
                "name": "School of Computer Science & Engineering (CSE)",
                "category": "academics",
                "type": "Department Zone",
                "tags": ["cse", "computer science", "it", "coding", "software"],
                "desc": "Houses the School of Computer Science & Engineering.",
                "groupName": "",
                "facilities": [],
            },
            {
                "id": "block-31",
                "kind": "block",
                "name": "Block 31 (Admin)",
                "groupId": "cse-dept",
                "groupName": "School of Computer Science & Engineering (CSE)",
                "category": "offices",
                "type": "Administrative & Academic Block",
                "tags": ["block 31", "admin", "administration", "cse"],
                "desc": "Block 31 - Administrative Block & CSE Department.",
                "facilities": ["Administrative Offices", "Classrooms", "Computer Labs"],
            },
            {
                "id": "office-admin-28-209",
                "kind": "office",
                "name": "Administrative Office (Block 28, Room 209)",
                "groupId": "cse-dept",
                "groupName": "School of Computer Science & Engineering (CSE)",
                "category": "offices",
                "type": "Administrative Office",
                "parentBlockIds": ["block-27", "block-28"],
                "tags": ["administrative office", "admin office", "block 27", "block 28", "room 209", "lost and found", "infrastructure", "faculty details"],
                "desc": "Administrative office serving Blocks 27 and 28 for lost and found, infrastructure queries, faculty details, and general queries.",
                "facilities": ["Lost and Found", "Infrastructure Queries", "Faculty Details", "General Queries"],
                "hours": "8:00 AM - 5:30 PM",
            },
        ]

        top_records = retrieve_relevant_records("where can I report a lost item", records)
        self.assertTrue(top_records)
        self.assertEqual(top_records[0]["id"], "office-admin-28-209")
        self.assertIn("lost", top_records[0]["search_text"].lower())


if __name__ == "__main__":
    unittest.main()
