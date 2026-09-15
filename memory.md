# 🧠 LPUNavix — Core Project Memory & Architecture Guide

> **Note for AI Models & Developers**:  
> This file is the single source of architectural truth for **LPUNavix**. Read this file before inspecting or modifying code. It details the complete system design, component responsibilities, data contracts, algorithms, conventions, and common modification workflows so you do not need to re-index or re-analyze the entire codebase from scratch.

---

## 1. Project Overview & Mission

**LPUNavix** is an interactive, real-time smart campus navigation and live electric kart tracking web platform custom-built for Lovely Professional University (LPU), Punjab, India.

### Key Capabilities
1. **Interactive Campus Map**: Leaflet-based map with custom layers (CartoDB Positron, OSM, Google Satellite), campus boundary geo-fencing, POI markers, and category filtering.
2. **Turn-by-Turn Multimodal Routing**: Graph-based pathfinding (A*/Dijkstra) running entirely on an internal campus road/footpath network graph with walking and driving modes.
3. **Real-Time Live Kart Tracker**: GPS telemetry ingestion server (FastAPI) and live frontend viewer with EMA (Exponential Moving Average) smoothing, deadband filtering, and animated interpolation for campus shuttles.

---

## 2. Technology Stack & Runtime Environment

| Layer | Technologies / Libraries |
|---|---|
| **Frontend Core** | Vanilla HTML5, Vanilla CSS3 (modular stylesheets), Vanilla JavaScript (ES6+ modular controllers) |
| **Mapping Engine** | [Leaflet.js 1.9.4](https://leafletjs.com/), `leaflet-rotate-src.js`, `leaflet.polylineDecorator.js` |
| **Backend API** | Python 3.10+, [FastAPI](https://fastapi.tiangolo.com/), Uvicorn, Pydantic v2 |
| **Testing** | `unittest`, `pytest`, `httpx` (for FastAPI test client), Node test scripts |
| **Deployment** | Render Web Service (`render.yaml`), Uvicorn on `$PORT` serving both API routes and static frontend |

---

## 3. Directory Structure & File Responsibilities

```text
d:\LPUNavix\
├── api\
│   ├── __init__.py
│   ├── main.py              # FastAPI server: kart tracking endpoints, static file mount
│   ├── rag.py               # Campus Assistant RAG pipeline, cache hashing, and POST /api/chat router
│   ├── data_loader.py       # Parses js/data.js into Record objects for embedding
│   ├── retrieval.py         # Vector similarity search, ranking, and match classification
│   ├── gemini_client.py     # Google Gemini GenAI SDK client for embedding and reply generation
│   └── embeddings_cache.json # Zero-latency pre-computed embeddings cache
├── css\
│   ├── main.css             # Theme variables, typography, animations, base resets
│   ├── sidebar.css          # Left vertical navigation sidebar
│   ├── topbar.css           # Top search bar, category pills, mobile header
│   ├── map.css              # Leaflet map container, custom marker pins, pulse animations
│   ├── panels.css           # Sliding drawers, location cards, directions sheet
│   └── mobile.css           # Responsive breakpoints (<768px), mobile bottom sheets
├── js\
│   ├── app.js               # Application bootstrap: calls init() across all controllers on DOMContentLoaded
│   ├── boundary.js          # GeoJSON polygon array for the LPU campus outer boundary
│   ├── campus_roads.js      # Raw coordinate arrays and geometry tags for roads & footpaths
│   ├── data.js              # Ground truth database: CAMPUS_LOCATIONS, CAMPUS_GROUPS, CAMPUS_OFFICES, etc.
│   ├── directions.js        # Graph builder (CampusRoadGraph), A* pathfinder, turn instructions, preview sheet
│   ├── karts.js             # KartTrackingController: polls /api/locations, EMA smoothing, marker animator
│   ├── map.js               # CampusMap controller: Leaflet instance, tile switchers, markers, layers, click handler
│   └── ui.js                # UIController: search suggestions, category filtering, drawer views, modals
├── tests\
│   ├── test_api.py          # Unit tests for /health, /api/location, /api/locations
│   ├── test_navigation_flow.js # Navigation state and back-button flow tests
│   ├── test_restyle_directions.js # Directions UI and markup tests
│   ├── test_stop_routing_flow.js  # Intermediate stops and connector tests
│   └── verify_all.py        # Comprehensive project structural assertions
├── .env                     # Local environment configuration
├── index.html               # Main SPA markup: map canvas, sidebars, sheets
├── render.yaml              # Render deployment configuration
├── requirements.txt         # Python dependencies
└── sync_campus_osm.py       # Developer script: queries Overpass API to refresh boundary and road nodes
```

---

## 4. Frontend Controller Architecture & Inter-Module Communication

All frontend modules register on the global `window` object and are initialized in sequence by `js/app.js`:

```text
DOMContentLoaded
       │
       ├─► window.CampusMap.init()          (js/map.js)
       ├─► window.UIController.init()       (js/ui.js)
       ├─► window.Directions.init()         (js/directions.js)
       └─► window.KartTracker.init()        (js/karts.js)
```

### Module Roles & Interfaces

1. **`window.CampusMap` (`js/map.js`)** — class: `CampusMapController`:
   - Holds `this.map` (Leaflet Map instance, initial zoom `15.25`, center `CAMPUS_CENTER`).
   - Tile layers: `satellite` (Google Maps), `street` (OpenStreetMap), `carto` (CartoDB Voyager). Default: `satellite`.
   - Layer groups (stacked in z-order): `roadsLayer`, `footpathsLayer`, `routesLayer` (custom `routePane`, z-index 580), `markersLayer`, `kartsLayer`.
   - Has a `CAMPUS_STYLE_CONFIG` object at the top of the file — edit colors for roads, footpaths, boundary, and outside-dim mask here.
   - Key public methods:
     - `flyToLocation(lat, lng, zoom = 17)`: Animated pan/zoom to coordinate.
     - `clearRoute()` / `clearRoutes()`: Clears active navigation polylines from `routesLayer`.
     - `renderLocationMarkers(category)`: Renders/filters markers by category.
     - `revealLocation(locationId)`: Zooms into and highlights an individual office or block.
     - `recenterCampus()`: Fits the full campus boundary in view.
     - `locateUser()`: Triggers geolocation and flies to user position.
     - `setBaseLayer(name)`: Switches tile layer (`'satellite'` | `'street'` | `'carto'`).
     - `drawRoute(path, skipFitBounds, ...)`: Renders dotted route polyline with origin/dest markers.
     - `zoomIn()` / `zoomOut()` / `resetOrientation()`: Map control helpers.

2. **`window.UIController` (`js/ui.js`)** — class: `UIController`:
   - Manages sidebar views: `home`, `map`, `directions`, `karts`, `alerts`, `settings`.
   - Theme persisted in `localStorage` as `lpu_theme` (`light` | `dark`).
   - Key public methods:
     - `switchView(viewName, customOrigin, customDest)`: Routes to the correct panel; if `directions` with a dest, calls `window.Directions.showDirections()` immediately.
     - `showLocationDetails(loc)`: Populates and opens the `#details-panel` drawer with a CAMPUS_LOCATIONS/CAMPUS_OFFICES object.
     - `showGroupDetails(group)`: Same but for a `CAMPUS_GROUPS` entry; lists all child block members.
     - `triggerShowOnMap(locationId, targetTitle)`: Resolves `locationId` → destination name, then calls `switchView('directions', ..., destName)`.
     - `selectSearchResult(locationId)`: Called when user picks from search dropdown for a location.
     - `selectGroupSearchResult(groupId)`: Called when user picks from search dropdown for a department group.
     - `startActiveNavigation(destName, duration, distance, mode, routePath)`: Shows mobile ETA bar, closes drawers, draws route.
     - `endActiveNavigation()`: Hides ETA bar, clears route.
     - `applyTheme(theme)`: Applies theme to `<html data-theme>` and switches tile layer for contrast.

3. **`window.Directions` (`js/directions.js`)**:
   - Encapsulates `CampusRoadGraph`: builds an in-memory adjacency list from `CAMPUS_ROADS_DATA`.
   - Implements multimodal pathfinding (drive/car vs walk modes).
   - Computes turn-by-turn maneuvers (e.g. "Turn left onto Central Avenue in 45m").
   - Displays Google Maps-style route preview page (`#gmaps-route-topbar` and `#gmaps-route-preview-sheet`, `body.gmaps-route-active`) showing ETA duration, distance, fastest route notice, and Car/Walk toggle tabs.
   - Touch-safe autocomplete recommendations: uses touch-distance tracking (`touchstart`, `touchmove` > 6px, `touchend`) to prevent accidental selection when users touch to scroll through recommendations.
   - History & Back Button Management: uses `{ panel: "directions" }` history state. When user presses phone back button or taps "✕", it safely resets route and returns to map without closing the application.
   - Primary public methods: `showDirections(origin, dest)`, `selectDestination(name)`, `hideRoutePreview()`, `closeRouteAndReset()`, `exitDirections()`.

4. **`window.KartTracker` (`js/karts.js`)** — class: `KartTrackingController`:
   - Polling loop (every 3000ms) against `GET /api/locations`.
   - EMA smoothing (`EMA_ALPHA = 0.25`), deadband filter (`MIN_MOVE_DEG = 0.00003`, ~3 m), animated interpolation (`ANIM_DURATION_MS = 2500 ms`).
   - GPS positions glide smoothly to new coords via `requestAnimationFrame`.

---

## 5. Backend Architecture & API Specifications

The backend is built with **FastAPI** (`api/main.py`). It serves both the API and the frontend static files. There are **exactly 3 HTTP endpoints**:

### 1. Health Check
- **Route**: `GET /health`
- **Response**: `{"status": "ok"}` — used by Render's `healthCheckPath`.

### 2. Kart Telemetry Ingestion
- **Route**: `GET /api/location` and `POST /api/location` (both handled by the same async function via `@app.api_route`)
- **Purpose**: Receives live GPS from driver phones, Traccar clients, or GPS logger apps.
- **Accepted field names** (any combination works):
  - ID: `id` or `deviceId`
  - Latitude: `lat` or `latitude`
  - Longitude: `lng`, `lon`, or `longitude`
  - Optional: `timestamp` (ISO string; auto-generated if absent)
- **Accepted body formats**: JSON (`application/json`), form URL-encoded, or query parameters.
- **In-Memory Store**: `karts: dict` — `{ kart_id: { lat, lng, timestamp, last_seen } }`. Volatile — **data is lost on server restart**.
- **Active window**: `ACTIVE_WINDOW_SECONDS = 30`. Karts not seen for >30 s are excluded from `/api/locations`.
- **Response**: `{"status": "ok"}`

### 3. Active Karts Polling
- **Route**: `GET /api/locations`
- **Pydantic model**: `KartStatus { id: str, lat: float, lng: float, timestamp: str }`
- **Response**: Array of currently active karts (seen within last 30 s):
  ```json
  [
    {
      "id": "kart-1",
      "lat": 31.2541,
      "lng": 75.7021,
      "timestamp": "2026-09-06T01:12:00Z"
    }
  ]
  ```

### Static File Serving
- `app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")` is mounted **last** (after all API routes). `STATIC_DIR` is the project root (`d:\LPUNavix\`).
- ⚠️ If this mount is moved above any `/api/*` route, those routes will be silently intercepted by the static file handler.

---

## 6. Data Schemas (`js/data.js`)

`data.js` contains the core campus data dictionaries:

---

### Section 1 — `CAMPUS_GROUPS` (Departments / Zones)
> Groups are parent containers that cluster multiple blocks under a school/department. They have **no individual lat/lng pin** — only a `centerCoords` for map fly-to. The `blocks` array lists child `CAMPUS_LOCATIONS` IDs.

```javascript
// const CAMPUS_GROUPS = [ ... ]
{
  id: "cse-dept",                          // Unique group ID, referenced by child locations' groupId
  name: "School of Computer Science & Engineering (CSE)",
  category: "academics",                   // 'academics' | 'hostels' | 'food' | 'parking' | 'offices' | 'healthcare' | 'others'
  type: "Department Zone",
  tags: ["cse", "computer science", "it", "coding", "software", "btech cse"],
  blocks: ["block-25", "block-28", ...],   // IDs of child CAMPUS_LOCATIONS belonging to this group
  centerCoords: [31.2525, 75.7030],        // [lat, lng] — used for map fly-to when group is selected
  desc: "Houses the School of Computer Science & Engineering.",
  image: ""                                // Optional image URL
}
```

---

### Section 2 — `CAMPUS_LOCATIONS` (Individual Blocks, Gates, Labs, Services)
> The primary map POI dataset. Each entry gets its own marker pin. Declared as `var CAMPUS_LOCATIONS = window.CAMPUS_LOCATIONS = [...]` — **do not change this declaration**.

```javascript
// var CAMPUS_LOCATIONS = window.CAMPUS_LOCATIONS = [ ... ]
{
  id: "block-25",                          // Unique location ID
  name: "Block 25 (CSE)",
  groupId: "cse-dept",                     // Parent group ID (null if standalone)
  groupName: "School of Computer Science & Engineering (CSE)", // null if standalone
  category: "academics",                   // 'academics' | 'hostels' | 'food' | 'parking' | 'offices' | 'healthcare' | 'others'
  type: "Academic Block",                  // Human-readable type label shown in UI card
  lat: 31.252859,                          // Latitude (always ~31.25 for LPU campus)
  lng: 75.702479,                          // Longitude (always ~75.70 for LPU campus)
  floor: "Multi-storey Block",             // Floor / level description
  facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
  tags: ["block 25", "cse", "computer science", "b25", "academic block"],  // Lowercase, drives search
  desc: "Block 25 - Department of Computer Science & Engineering.",
  hours: "8:00 AM - 5:30 PM",
  phone: "",
  image: ""
}
```

---

### Section 3 — `CAMPUS_OFFICES` (Room-level offices inside blocks)
> Fine-grained office locations visible only at high zoom (zoom ≥ `visibleFromZoom`). Declared as `var CAMPUS_OFFICES = window.CAMPUS_OFFICES = [...]` — merged with `CAMPUS_LOCATIONS` by `getAllCampusLocations()`.

```javascript
// var CAMPUS_OFFICES = window.CAMPUS_OFFICES = [ ... ]
{
  id: "office-admin-28-209",
  name: "Administrative Office (Block 28, Room 209)",
  groupId: "cse-dept",
  groupName: "School of Computer Science & Engineering (CSE)",
  category: "offices",
  type: "Administrative Office",
  parentBlockIds: ["block-27", "block-28"],   // Which blocks this office sits inside
  visibleFromZoom: 19,                         // Only rendered on map at zoom level ≥ 19
  lat: 31.252754,
  lng: 75.703785,
  floor: "Second Floor, Room 209",
  facilities: ["Lost and Found", "Infrastructure Queries", "Faculty Details", "General Queries"],
  tags: ["administrative office", "admin office", "block 28", "room 209", "lost and found"],
  desc: "Administrative office serving Blocks 27 and 28.",
  hours: "8:00 AM - 5:30 PM",
  phone: "",
  image: ""
}
```

---

### Section 4 — `CAMPUS_KARTS` (Live shuttle static config)
> Static default config for each electric shuttle. **Live positions** are overwritten at runtime by the backend `/api/locations` polling — this is just the fallback/initial state.

```javascript
// const CAMPUS_KARTS = [ ... ]
{
  id: "kart-1",                            // Must match the id sent by the GPS tracker device
  name: "Electric Shuttle #1",
  route: "Main Gate ➔ UniMall ➔ Block 31 ➔ Block 28",  // Human-readable route description
  location: "Near Main Gate Stop",         // Last known stop label (display only)
  eta: "2 mins away",                      // Static ETA label (display only)
  status: "active",                        // 'active' | 'inactive'
  lat: 31.2522,                            // Fallback/initial latitude
  lng: 75.6990                             // Fallback/initial longitude
}
```

---

### Campus Road Network Edge (`js/campus_roads.js`)
> Raw OSM-derived road geometry. Used by `directions.js` to build the `CampusRoadGraph` adjacency list.

```javascript
// CAMPUS_ROADS_DATA = [ ... ]   (auto-generated by sync_campus_osm.py)
{
  id: "way/123456",
  tags: {
    highway: "service",    // 'service' | 'residential' | 'footway' | 'path' | 'steps' | 'pedestrian'
    name: "Central Avenue",
    oneway: "no",          // 'yes' | 'no' | '1'
    junction: ""           // 'roundabout' triggers oneway enforcement
  },
  coords: [                // ⚠️ Note: field name is 'coords' in CAMPUS_ROADS_DATA (not 'geometry')
    [31.2536, 75.7037],    // [lat, lng] pairs
    [31.2540, 75.7042]
  ]
}
```

---

## 7. Common Developer Workflows

### A. Adding a New Building or Location
1. Open `js/data.js`.
2. Add a new object to `CAMPUS_LOCATIONS` (or `CAMPUS_OFFICES`) following the schema above.
3. Ensure coordinates are `[lat, lng]` (latitude ~31.25, longitude ~75.70).
4. Provide comprehensive search `tags` (lowercase) for instant search indexing.

### B. Updating Campus Road Graph
1. If adding individual path segments, add them directly to `js/campus_roads.js` under `CAMPUS_ROADS_DATA` with appropriate `highway` tag (`service` for cars/karts, `footway` for walking-only paths).
2. To regenerate from OpenStreetMap: run `python sync_campus_osm.py` (queries Overpass API for LPU bounding box and outputs updated JS arrays).

### C. Adding or Simulating a Kart
1. To send a live GPS coordinate to the tracker:
   ```bash
   curl -X POST "http://localhost:3000/api/location" \
     -H "Content-Type: application/json" \
     -d '{"id": "kart-test", "lat": 31.2536, "lng": 75.7037}'
   ```
2. The frontend `js/karts.js` will automatically pick up `kart-test` on the next 3-second poll and render a marker.

---

## 8. Critical Rules & Gotchas for Future AI Models

1. **Coordinate Format**:
   - Leaflet and this codebase use **`[latitude, longitude]`** format everywhere (`[lat, lng]`). Do NOT invert to `[lng, lat]` unless interfacing with GeoJSON raw specs.
2. **Zero-Cache / No Version Bumping Needed**:
   - `api/main.py` has an HTTP middleware that automatically sets `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` on all served files (HTML, CSS, JS).
   - Browsers and phones will always fetch the newest code on reload. Version bumping (`?v=...`) is no longer required.
3. **Static Route Precedence in FastAPI**:
   - In `api/main.py`, `app.mount("/", StaticFiles(...))` MUST remain the very last route registered. If registered earlier, it will intercept and block `/api/*` endpoints.
4. **Local Development Port & Testing**:
   - Local default server runs on `http://localhost:3000`. Run via:
     ```bash
     uvicorn api.main:app --host 0.0.0.0 --port 3000 --reload
     ```
   - Run automated test suite via:
     ```bash
     python -m unittest discover -s tests -p "test_*.py"
     ```
