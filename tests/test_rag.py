import unittest

from api.rag import CAMPUS_RECORDS, build_context_block, load_campus_records, retrieve_relevant_records


class TestRAGRetrieval(unittest.TestCase):
    def test_load_campus_records_from_data_js(self):
        records = load_campus_records()
        self.assertIsInstance(records, list)
        self.assertGreater(len(records), 0)

        # Check that groups, blocks/locations, and offices exist
        kinds = {r.get("kind") for r in records}
        self.assertIn("group", kinds)
        self.assertTrue("block" in kinds or "location" in kinds)
        self.assertIn("office", kinds)

        # Verify fashion design, cse, and admin office are loaded
        ids = {r.get("id") for r in records}
        self.assertIn("fashion-design-dept", ids)
        self.assertIn("cse-dept", ids)
        self.assertIn("office-admin-28-209", ids)

    def test_default_retrieval_uses_dynamic_records(self):
        top_records = retrieve_relevant_records("where can I report a lost item")
        self.assertTrue(top_records)
        self.assertEqual(top_records[0]["id"], "office-admin-28-209")

    def test_custom_records_retrieval(self):
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

    def test_build_context_block(self):
        records = retrieve_relevant_records("where is CSE department")
        self.assertTrue(records)
        context = build_context_block(records)
        self.assertIn("Computer Science", context)


if __name__ == "__main__":
    unittest.main()

