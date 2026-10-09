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
import math
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
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BOUNDARY_FILE = os.path.join(SCRIPT_DIR, "js", "boundary.js")
DEFAULT_ROADS_FILE = os.path.join(SCRIPT_DIR, "js", "campus_roads.js")

# OSM LPU Boundary Relation & Way IDs (supports multipolygon split boundary ways)
LPU_BOUNDARY_RELATION_ID = 21599790
LPU_BOUNDARY_WAY_IDS = [422435593, 1566901467]

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


def footpath_width_m(highway: str) -> float:
    """Return an estimated display width for an OSM footpath centerline."""
    return {
        "pedestrian": 4.6,
        "track": 3.6,
        "cycleway": 3.4,
        "steps": 2.0,
    }.get(highway, 3.7)


def buffer_centerline_to_area(coords: List[List[float]], width_m: float) -> List[List[float]]:
    """Build a simple miter-joined polygon around a lat/lon centerline."""
    if len(coords) < 2:
        return []

    half_width = width_m / 2
    mean_lat = math.radians(sum(point[0] for point in coords) / len(coords))
    origin_lat, origin_lon = coords[0]
    meters_per_lon = 111320 * math.cos(mean_lat)
    meters_per_lat = 110540
    points = [
        ((lon - origin_lon) * meters_per_lon, (lat - origin_lat) * meters_per_lat)
        for lat, lon in coords
    ]
    points = [point for index, point in enumerate(points)
              if index == 0 or math.dist(point, points[index - 1]) > 0.02]
    if len(points) < 2:
        return []

    directions = []
    normals = []
    for start, end in zip(points, points[1:]):
        dx, dy = end[0] - start[0], end[1] - start[1]
        length = math.hypot(dx, dy)
        directions.append((dx / length, dy / length))
        normals.append((-dy / length, dx / length))

    def offset_side(side: float) -> List[tuple[float, float]]:
        edge = []
        for index, point in enumerate(points):
            if index == 0:
                dx, dy = directions[0]
                nx, ny = normals[0]
                edge.append((point[0] - dx * half_width + nx * half_width * side,
                             point[1] - dy * half_width + ny * half_width * side))
            elif index == len(points) - 1:
                dx, dy = directions[-1]
                nx, ny = normals[-1]
                edge.append((point[0] + dx * half_width + nx * half_width * side,
                             point[1] + dy * half_width + ny * half_width * side))
            else:
                before = (normals[index - 1][0] * side, normals[index - 1][1] * side)
                after = (normals[index][0] * side, normals[index][1] * side)
                mx, my = before[0] + after[0], before[1] + after[1]
                magnitude = math.hypot(mx, my)
                if magnitude < 1e-8:
                    mx, my = after
                    magnitude = math.hypot(mx, my)
                mx, my = mx / magnitude, my / magnitude
                denominator = mx * after[0] + my * after[1]
                distance = half_width / max(abs(denominator), 0.5)
                distance = min(distance, half_width * 2)
                edge.append((point[0] + mx * distance, point[1] + my * distance))
        return edge

    ring_xy = offset_side(1) + list(reversed(offset_side(-1)))
    ring = [
        [round(origin_lat + y / meters_per_lat, 7),
         round(origin_lon + x / meters_per_lon, 7)]
        for x, y in ring_xy
    ]
    if ring:
        ring.append(ring[0])
    return ring


# ==============================================================================
# 1. Fetch & Build Boundary (js/boundary.js)
# ==============================================================================
def stitch_boundary_segments(segments: List[List[List[float]]]) -> List[List[float]]:
    """Stitch multiple connected boundary way segments into a single closed ring."""
    if not segments:
        return []
    if len(segments) == 1:
        ring = list(segments[0])
        if math.hypot(ring[0][0] - ring[-1][0], ring[0][1] - ring[-1][1]) > 1e-6:
            ring.append(ring[0])
        return ring

    chain = list(segments[0])
    rem = list(segments[1:])
    tol = 0.00015  # ~15 meters tolerance for junction matching

    while rem:
        matched = False
        for i, s in enumerate(rem):
            # Connect to end of chain
            if math.hypot(chain[-1][0] - s[0][0], chain[-1][1] - s[0][1]) < tol:
                chain.extend(s[1:])
                rem.pop(i)
                matched = True
                break
            elif math.hypot(chain[-1][0] - s[-1][0], chain[-1][1] - s[-1][1]) < tol:
                chain.extend(list(reversed(s[:-1])))
                rem.pop(i)
                matched = True
                break
            # Connect to start of chain
            elif math.hypot(chain[0][0] - s[-1][0], chain[0][1] - s[-1][1]) < tol:
                chain = s[:-1] + chain
                rem.pop(i)
                matched = True
                break
            elif math.hypot(chain[0][0] - s[0][0], chain[0][1] - s[0][1]) < tol:
                chain = list(reversed(s[1:])) + chain
                rem.pop(i)
                matched = True
                break

        if not matched:
            print(f"[WARN] Could not connect {len(rem)} boundary segment(s); continuing with stitched chain.")
            break

    # Ensure the polygon is closed
    if math.hypot(chain[0][0] - chain[-1][0], chain[0][1] - chain[-1][1]) > 1e-6:
        chain.append(chain[0])
    return chain


def fetch_campus_boundary(fallback_file: str) -> List[List[float]]:
    """Fetch official LPU boundary coordinates from OSM relation or connected ways."""
    print(f"\n[STEP 1] Fetching LPU boundary (OSM relation {LPU_BOUNDARY_RELATION_ID} & ways {LPU_BOUNDARY_WAY_IDS})...")
    way_queries = " ".join(f"way({wid});" for wid in LPU_BOUNDARY_WAY_IDS)
    query = f"""[out:json][timeout:30];
(
  relation({LPU_BOUNDARY_RELATION_ID});
  way({LPU_BOUNDARY_WAY_IDS[0]}); rel(bw);
  {way_queries}
);
out body geom;
"""
    try:
        res = query_overpass(query)
        elements = res.get("elements", [])

        # 1. First priority: Check if multipolygon relation is present with outer members
        segments = []
        for el in elements:
            if el.get("type") == "relation":
                for m in el.get("members", []):
                    if m.get("role") in ("outer", "") and m.get("geometry"):
                        pts = [[round(p["lat"], 7), round(p["lon"], 7)] for p in m["geometry"]]
                        if len(pts) >= 2:
                            segments.append(pts)
                if segments:
                    break

        # 2. Second priority: If relation was not returned, collect from member ways
        if not segments:
            seen_ways = set()
            for el in elements:
                if el.get("type") == "way" and el.get("geometry"):
                    wid = el.get("id")
                    if wid not in seen_ways:
                        seen_ways.add(wid)
                        pts = [[round(p["lat"], 7), round(p["lon"], 7)] for p in el["geometry"]]
                        if len(pts) >= 2:
                            segments.append(pts)

        if segments:
            boundary = stitch_boundary_segments(segments)
            print(f"[SUCCESS] Fetched {len(segments)} boundary segments, stitched into {len(boundary)} vertices from OpenStreetMap.")
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
// Source: OpenStreetMap (relation/{LPU_BOUNDARY_RELATION_ID} & ways {LPU_BOUNDARY_WAY_IDS})
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
                "geometry": pts,
                "area_geometry": buffer_centerline_to_area(pts, footpath_width_m(hw))
                    if hw in {"footway", "path", "steps", "pedestrian", "track", "cycleway"}
                    else None
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
    coords: way.geometry,
    areaGeometry: way.area_geometry || null
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
