import unittest

from api.rag import (
    CAMPUS_RECORDS,
    build_context_block,
    generate_chat_reply,
    generate_direct_reply,
    load_campus_records,
    retrieve_relevant_records,
)


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

    def test_block_number_retrieval(self):
        top_records = retrieve_relevant_records("Where is Block 28?")
        self.assertTrue(top_records)
        # Block 28 or administrative office 28 should be at the top
        matched_ids = [r["id"] for r in top_records[:2]]
        self.assertTrue("block-28" in matched_ids or "office-admin-28-209" in matched_ids)

    def test_health_center_retrieval(self):
        top_records = retrieve_relevant_records("Where is Uni Health Center?")
        self.assertTrue(top_records)
        self.assertEqual(top_records[0]["id"], "uni-health-center")

    def test_generate_direct_reply(self):
        records = retrieve_relevant_records("where can I report a lost item")
        reply = generate_direct_reply("where can I report a lost item", records)
        self.assertIn("Administrative Office", reply)
        self.assertIn("Lost and Found", reply)
        self.assertIn("Room 209", reply)

    def test_generate_chat_reply_fallback(self):
        records = retrieve_relevant_records("Where is CSE department?")
        reply = generate_chat_reply("Where is CSE department?", records)
        self.assertTrue(len(reply) > 0)
        self.assertTrue("Computer Science" in reply or "CSE" in reply)

    def test_build_context_block(self):
        records = retrieve_relevant_records("where is CSE department")
        self.assertTrue(records)
        context = build_context_block(records)
        self.assertIn("Computer Science", context)


if __name__ == "__main__":
    unittest.main()
