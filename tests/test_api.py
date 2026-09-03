import unittest
from fastapi.testclient import TestClient

from api.main import app

class TestAPIEndpoints(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_chat_lost_item(self):
        response = self.client.post("/api/chat", json={"message": "Where can I report a lost item?"})
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("reply", data)
        self.assertIn("Administrative Office", data["reply"])
        self.assertEqual(data["locationId"], "office-admin-28-209")

    def test_chat_block_28(self):
        response = self.client.post("/api/chat", json={"message": "Where is Block 28?"})
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("reply", data)
        self.assertIn("Block 28", data["reply"])

    def test_chat_empty_message(self):
        response = self.client.post("/api/chat", json={"message": ""})
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
