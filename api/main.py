"""
main.py — LPUNavix Backend & Live Kart Tracker Server (FastAPI)
=================================================================
Accepts location updates from driver phones / GPS Logger clients
and serves the complete LPUNavix Smart Campus Navigation frontend.

Run it with:
    pip install -r requirements.txt
    uvicorn api.main:app --host 0.0.0.0 --port 3000
"""

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException, Request
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
    # Accept both the website format (lat/lng) and common GPS-app names.
    lat: Optional[float] = None
    lng: Optional[float] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    lon: Optional[float] = None
    timestamp: Optional[str] = None


class KartStatus(BaseModel):
    id: str
    lat: float
    lng: float
    timestamp: str


# -------- Senders and Traccar Client post location updates here --------
@app.api_route("/api/location", methods=["GET", "POST"])
async def receive_location(request: Request):
    data = dict(request.query_params)

    if request.method == "POST":
        raw_body = await request.body()
        if raw_body:
            content_type = request.headers.get("content-type", "")
            try:
                if "application/json" in content_type:
                    data.update(json.loads(raw_body))
                else:
                    form_data = parse_qs(raw_body.decode("utf-8"), keep_blank_values=True)
                    data.update({key: values[-1] for key, values in form_data.items()})
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                raise HTTPException(status_code=422, detail="Invalid location request body.")

    kart_id = data.get("id") or data.get("deviceId")
    lat_value = data.get("lat") or data.get("latitude")
    lng_value = data.get("lng") or data.get("lon") or data.get("longitude")

    if not kart_id or lat_value is None or lng_value is None:
        raise HTTPException(
            status_code=422,
            detail="Location must include id, lat, and lon/lng coordinates.",
        )

    try:
        lat = float(lat_value)
        lng = float(lng_value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="Latitude and longitude must be numbers.")

    karts[str(kart_id)] = {
        "lat": lat,
        "lng": lng,
        "timestamp": data.get("timestamp") or datetime.now(timezone.utc).isoformat(),
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


# Serves LPUNavix navigation frontend from the project root.
# Registered LAST so it doesn't swallow the /api/... routes defined above.
STATIC_DIR = Path(__file__).resolve().parent.parent
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

