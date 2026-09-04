#!/usr/bin/env python3
"""
LPU Campus OSM Data Synchronizer
--------------------------------
Fetches:
  1. Campus boundary polygon from OpenStreetMap (way 422435593) -> updates js/boundary.js
  2. Roads & footpaths inside campus boundary -> updates js/campus_roads.js

Only runs when manually executed:
  python sync_campus_osm.py

Does not touch or modify any other files in the project.
"""

import sys
import os
import re
import json
import argparse
import urllib.request
import urllib.parse
from datetime import datetime
from typing import List, Dict, Any, Tuple

# Fix UTF-8 terminal encoding on Windows if needed
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Default target file paths
DEFAULT_BOUNDARY_FILE = os.path.join("js", "boundary.js")
DEFAULT_ROADS_FILE = os.path.join("js", "campus_roads.js")

# OSM LPU Boundary Way ID
LPU_BOUNDARY_WAY_ID = 422435593

# Bounding box covering Lovely Professional University
CAMPUS_BBOX = (31.245, 75.697, 31.262, 75.710)

# Overpass API mirror endpoints for maximum reliability
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# Highway classifications allowed for campus
ALLOWED_HIGHWAY_TYPES = {
    "footway", "path", "steps", "pedestrian", "track", "cycleway",
    "service", "residential", "unclassified", "tertiary", "living_street", "road"
}


# ==============================================================================
# Overpass API Helper
# ==============================================================================
def query_overpass(query_str: str, timeout_sec: int = 40) -> Dict[str, Any]:
    """Execute an Overpass QL query across mirror endpoints with timeout fallback."""
    headers = {
        "User-Agent": "LPUNavix-Sync/1.0 (Campus boundary and roads synchronizer)",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "application/json"
    }

    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            print(f"[INFO] Querying Overpass endpoint: {endpoint} ...")
            post_data = urllib.parse.urlencode({"data": query_str}).encode("utf-8")
            req = urllib.request.Request(endpoint, data=post_data, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                if resp.status == 200:
                    payload = json.loads(resp.read().decode("utf-8"))
                    elements = payload.get("elements", [])
                    print(f"[SUCCESS] Received {len(elements)} elements from {endpoint}")
                    return payload
        except Exception as e:
            print(f"[WARN] Endpoint failed: {endpoint} ({e})")
            last_err = e

    raise RuntimeError(f"All Overpass mirrors failed. Last error: {last_err}")


# ==============================================================================
# Point-In-Polygon Ray-Casting
# ==============================================================================
def point_in_polygon(lat: float, lon: float, poly: List[List[float]]) -> bool:
    """Ray casting algorithm to determine if (lat, lon) is within polygon."""
    n = len(poly)
    inside = False
    p1lat, p1lon = poly[0]
    for i in range(1, n + 1):
        p2lat, p2lon = poly[i % n]
        if min(p1lon, p2lon) < lon <= max(p1lon, p2lon):
            if p1lon != p2lon:
                xinters = (lon - p1lon) * (p2lat - p1lat) / (p2lon - p1lon) + p1lat
                if p1lat == p2lat or lat <= xinters:
                    inside = not inside
        p1lat, p1lon = p2lat, p2lon
    return inside


# ==============================================================================
# 1. Fetch & Build Boundary (js/boundary.js)
# ==============================================================================
def fetch_campus_boundary(fallback_file: str) -> List[List[float]]:
    """Fetch official LPU boundary coordinates from OSM way 422435593."""
    print(f"\n[STEP 1] Fetching LPU boundary (OSM way/{LPU_BOUNDARY_WAY_ID})...")
    query = f"""[out:json][timeout:30];
way({LPU_BOUNDARY_WAY_ID});
out body geom;
"""
    try:
        res = query_overpass(query)
        elements = res.get("elements", [])
        if elements and "geometry" in elements[0]:
            boundary = [[round(p["lat"], 7), round(p["lon"], 7)] for p in elements[0]["geometry"]]
            print(f"[SUCCESS] Fetched {len(boundary)} boundary vertices from OpenStreetMap.")
            return boundary
    except Exception as e:
        print(f"[WARN] Live boundary fetch failed: {e}")

    # Fallback to current boundary file if network fails
    if os.path.exists(fallback_file):
        print(f"[INFO] Using existing boundary from {fallback_file} as reliable fallback...")
        with open(fallback_file, "r", encoding="utf-8") as f:
            matches = re.findall(r'\[([0-9.]+),\s*([0-9.]+)\]', f.read())
            if matches:
                boundary = [[float(lat), float(lon)] for lat, lon in matches]
                print(f"[INFO] Loaded {len(boundary)} vertices from local fallback.")
                return boundary

    raise RuntimeError("Failed to obtain LPU boundary from both OSM and local fallback.")


def generate_boundary_js(boundary: List[List[float]]) -> str:
    """Generate js/boundary.js file content."""
    today = datetime.now().strftime("%b %d, %Y")
    coords_lines = []
    for i, pt in enumerate(boundary):
        suffix = " (start)" if i == 0 else (" (closed back to start)" if i == len(boundary) - 1 else "")
        coords_lines.append(f"  [{pt[0]:.7f}, {pt[1]:.7f}],{suffix and f' // {suffix.strip()}'}")

    formatted_coords = "\n".join(coords_lines)
    return f"""// LPU Campus Boundary Coordinates
// Source: OpenStreetMap way/{LPU_BOUNDARY_WAY_ID}
// Last synced: {today}
// Total nodes: {len(boundary)}

const LPU_BOUNDARY = [
{formatted_coords}
];

if (typeof window !== "undefined") {{
  window.LPU_BOUNDARY = LPU_BOUNDARY;
}}
"""


# ==============================================================================
# 2. Fetch & Filter Roads and Footpaths (js/campus_roads.js)
# ==============================================================================
def fetch_campus_highways(bbox: Tuple[float, float, float, float], fallback_file: str) -> List[Dict[str, Any]]:
    """Fetch highway ways within LPU bounding box."""
    min_lat, min_lon, max_lat, max_lon = bbox
    print(f"\n[STEP 2] Fetching roads and footpaths in bbox {bbox}...")
    query = f"""[out:json][timeout:60];
(
  way["highway"]({min_lat},{min_lon},{max_lat},{max_lon});
);
out body geom;
"""
    try:
        res = query_overpass(query)
        return res.get("elements", [])
    except Exception as e:
        print(f"[WARN] Live highway fetch failed: {e}")

    # Fallback to current campus_roads.js if network fails
    if os.path.exists(fallback_file):
        print(f"[INFO] Using existing road dataset from {fallback_file} as reliable fallback...")
        with open(fallback_file, "r", encoding="utf-8") as f:
            text = f.read()
            m = re.search(r'const LPU_ROAD_NETWORK = (\[.*?\]);', text, re.DOTALL)
            if m:
                parsed = json.loads(m.group(1))
                return [
                    {
                        "type": "way",
                        "id": w["id"],
                        "tags": {
                            "highway": w.get("highway", "road"),
                            "name": w.get("name", ""),
                            "oneway": w.get("oneway", ""),
                            "junction": w.get("junction", "")
                        },
                        "geometry": [{"lat": p[0], "lon": p[1]} for p in w.get("geometry", [])]
                    }
                    for w in parsed
                ]

    raise RuntimeError("Failed to fetch highways from both OSM and local fallback.")


def filter_campus_ways(raw_ways: List[Dict[str, Any]], boundary: List[List[float]]) -> List[Dict[str, Any]]:
    """Filter ways strictly inside LPU boundary and main gate connectors."""
    print("\n[STEP 3] Filtering ways strictly inside LPU boundary...")
    campus_ways = []
    seen_ids = set()

    for el in raw_ways:
        if el.get("type") != "way":
            continue

        tags = el.get("tags", {})
        hw = tags.get("highway", "")

        # Exclude external trunk highways (e.g. NH44 / GT Road)
        if hw not in ALLOWED_HIGHWAY_TYPES:
            continue

        geom = el.get("geometry", [])
        if not geom or len(geom) < 2:
            continue

        pts = [[round(p["lat"], 6), round(p["lon"], 6)] for p in geom]

        # Count points inside boundary polygon
        inside_count = sum(1 for p in pts if point_in_polygon(p[0], p[1], boundary))

        # Check for main gate entry connector driveways
        is_gate_connector = (
            any(31.258 <= p[0] <= 31.261 and 75.706 <= p[1] <= 75.7075 for p in pts)
            and hw in {"service", "tertiary", "unclassified", "footway", "living_street"}
        )

        # Accept if at least 40% of vertices are inside, or gate connector
        if inside_count >= len(pts) * 0.4 or (inside_count > 0 and is_gate_connector):
            if el["id"] in seen_ids:
                continue
            seen_ids.add(el["id"])

            campus_ways.append({
                "id": el["id"],
                "highway": hw,
                "name": tags.get("name", ""),
                "oneway": tags.get("oneway", ""),
                "junction": tags.get("junction", ""),
                "geometry": pts
            })

    campus_ways.sort(key=lambda w: (w["highway"], w["id"]))
    print(f"[SUCCESS] Filtered to {len(campus_ways)} ways inside LPU boundary.")
    return campus_ways


def generate_roads_js(campus_ways: List[Dict[str, Any]]) -> str:
    """Generate js/campus_roads.js file content with backward compatibility."""
    header = f"""/**
 * LPU Campus Road & Footpath Static Network
 * Filtered strictly within LPU campus boundary from OpenStreetMap.
 * Total ways: {len(campus_ways)}
 * Immune to external OSM edits and loads with 0ms network latency.
 */

const LPU_ROAD_NETWORK = """

    export_block = """

// Ensure global compatibility across LPUNavix controllers
if (typeof window !== "undefined") {
  window.LPU_ROAD_NETWORK = LPU_ROAD_NETWORK;
  // Map to the CAMPUS_ROADS_DATA schema (tags + coords) expected by map.js & directions.js
  window.CAMPUS_ROADS_DATA = LPU_ROAD_NETWORK.map(way => ({
    id: way.id,
    tags: {
      highway: way.highway,
      name: way.name || "",
      oneway: way.oneway || "",
      junction: way.junction || ""
    },
    coords: way.geometry
  }));
}
"""
    return header + json.dumps(campus_ways, indent=2) + ";" + export_block


# ==============================================================================
# Main Entry Point
# ==============================================================================
def main():
    parser = argparse.ArgumentParser(
        description="Sync LPU boundary, roads, and footpaths from OpenStreetMap into js/boundary.js and js/campus_roads.js."
    )
    parser.add_argument("--boundary-file", default=DEFAULT_BOUNDARY_FILE, help=f"Path to boundary.js (default: {DEFAULT_BOUNDARY_FILE})")
    parser.add_argument("--roads-file", default=DEFAULT_ROADS_FILE, help=f"Path to campus_roads.js (default: {DEFAULT_ROADS_FILE})")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and process without saving changes to disk")
    args = parser.parse_args()

    print("=" * 70)
    print(">> LPU Campus OSM Synchronizer")
    print(">> Target 1: js/boundary.js     (Campus Boundary)")
    print(">> Target 2: js/campus_roads.js (Roads & Footpaths inside boundary)")
    print("=" * 70)

    try:
        # 1. Boundary
        boundary = fetch_campus_boundary(args.boundary_file)
        boundary_content = generate_boundary_js(boundary)

        # 2. Highways
        raw_ways = fetch_campus_highways(CAMPUS_BBOX, args.roads_file)
        campus_ways = filter_campus_ways(raw_ways, boundary)
        roads_content = generate_roads_js(campus_ways)

        # 3. Save
        print("\n" + "=" * 70)
        if args.dry_run:
            print("[INFO] Dry-run mode enabled: No files were modified.")
            print(f"[SUMMARY] Boundary vertices: {len(boundary)}")
            print(f"[SUMMARY] Campus ways: {len(campus_ways)}")
        else:
            with open(args.boundary_file, "w", encoding="utf-8") as f:
                f.write(boundary_content)
            print(f"[SUCCESS] Updated {args.boundary_file} ({len(boundary)} boundary nodes)")

            with open(args.roads_file, "w", encoding="utf-8") as f:
                f.write(roads_content)
            print(f"[SUCCESS] Updated {args.roads_file} ({len(campus_ways)} campus ways)")

        print("=" * 70)
        print("Done! No other files in the project were modified.")

    except Exception as e:
        print(f"\n[FATAL ERROR] {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
