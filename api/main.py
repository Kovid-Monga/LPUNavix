"""
main.py — LPUNavix Backend & Live Kart Tracker Server (FastAPI)
=================================================================
Accepts location updates from driver phones / GPS Logger clients,
serves the AI Campus Assistant, and serves the complete LPUNavix frontend.

Run it with:
    pip install -r requirements.txt
    uvicorn api.main:app --host 0.0.0.0 --port 3000
"""

import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import List
from urllib.parse import parse_qs

try:
    from dotenv import load_dotenv
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.exists():
        load_dotenv(dotenv_path=env_file)
    else:
        load_dotenv()
except ImportError:
    pass

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from api.rag import (
    init_rag,
    router as rag_router,
    shutdown_rag,
    embed_texts,
    embed_query,
    generate_reply,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_rag()
    yield
    shutdown_rag()


app = FastAPI(title="LPUNavix Live Tracking & Campus Navigation", lifespan=lifespan)


# Allow requests from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Automatically compress HTML, JS, CSS, GeoJSON responses (70%-80% bandwidth reduction)
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def smart_cache_middleware(request: Request, call_next):
    """
    Low-bandwidth smart caching policy:
    - Long-term caching (1 day) for heavy media & images (saves ~2.2 MB on mobile).
    - Conditional ETag revalidation ('no-cache') for code assets (HTML, JS, CSS, GeoJSON)
      guaranteeing code changes appear immediately on refresh, while unchanged files return 304 (0 bytes).
    - 'no-store' for dynamic live tracking API endpoints (/api/*).
    """
    response = await call_next(request)
    path = request.url.path.lower()

    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    elif any(path.endswith(ext) for ext in [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf"]):
        response.headers["Cache-Control"] = "public, max-age=86400"
        if "Pragma" in response.headers:
            del response.headers["Pragma"]
        if "Expires" in response.headers:
            del response.headers["Expires"]
    else:
        # Revalidate with server via ETag/Last-Modified.
        # Changes show up immediately on refresh; unchanged files cost 0 bytes.
        response.headers["Cache-Control"] = "no-cache"
        if "Pragma" in response.headers:
            del response.headers["Pragma"]
        if "Expires" in response.headers:
            del response.headers["Expires"]

    return response


@app.get("/health")
def health_check():
    return {"status": "ok"}


# Mount the Campus Assistant RAG router
app.include_router(rag_router)


# In-memory store of the latest known location for each kart.
# Shape: { "kart-1": {"lat": .., "lng": .., "timestamp": .., "last_seen": ..} }
karts = {}

# A kart is "active" only if it sent an update within this many seconds.
ACTIVE_WINDOW_SECONDS = 30




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