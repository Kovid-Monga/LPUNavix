"""
main.py — LPUNavix Backend & Live Kart Tracker Server (FastAPI)
=================================================================
Accepts location updates from driver phones / GPS Logger clients
and serves the complete LPUNavix Smart Campus Navigation frontend.

Run it with:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 3000
"""

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="LPUNavix Live Tracking & Campus Navigation")

# Allow requests from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store of the latest known location for each kart.
# Shape: { "kart-1": {"lat": .., "lng": .., "timestamp": .., "last_seen": ..} }
karts = {}

# A kart is "active" only if it sent an update within this many seconds.
ACTIVE_WINDOW_SECONDS = 30


class LocationUpdate(BaseModel):
    id: str
    lat: float
    lng: float
    timestamp: Optional[str] = None


class KartStatus(BaseModel):
    id: str
    lat: float
    lng: float
    timestamp: str


# -------- The sender / GPS logger POSTs here every few seconds --------
@app.post("/api/location")
def receive_location(update: LocationUpdate):
    karts[update.id] = {
        "lat": update.lat,
        "lng": update.lng,
        "timestamp": update.timestamp or datetime.now(timezone.utc).isoformat(),
        "last_seen": time.time(),
    }
    return {"status": "ok"}


# -------- LPUNavix map dashboard polls this to get current karts --------
@app.get("/api/locations", response_model=List[KartStatus])
def get_active_locations():
    now = time.time()
    active = [
        {"id": kid, "lat": k["lat"], "lng": k["lng"], "timestamp": k["timestamp"]}
        for kid, k in karts.items()
        if now - k["last_seen"] < ACTIVE_WINDOW_SECONDS
    ]
    return active


# Serves LPUNavix navigation frontend directly from the current directory.
# Registered LAST so it doesn't swallow the /api/... routes defined above.
STATIC_DIR = Path(__file__).resolve().parent
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3000, reload=True)

