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

    def test_location_post_and_get(self):
        post_response = self.client.post("/api/location", json={
            "id": "kart-test-1",
            "lat": 31.2530,
            "lng": 75.7035
        })
        self.assertEqual(post_response.status_code, 200)
        self.assertEqual(post_response.json(), {"status": "ok"})

        get_response = self.client.get("/api/locations")
        self.assertEqual(get_response.status_code, 200)
        locations = get_response.json()
        self.assertIsInstance(locations, list)
        kart_ids = [k["id"] for k in locations]
        self.assertIn("kart-test-1", kart_ids)


if __name__ == "__main__":
    unittest.main()
