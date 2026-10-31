#!/usr/bin/env python3
"""
scripts/sync_geojson_from_data.py
==================================
Automatically synchronizes geoJson/campus_data.geojson with the master
definitions in js/data.js.

Workflow:
1. Make changes (add, edit, update coordinates/timings) in js/data.js
2. Run: python scripts/sync_geojson_from_data.py
3. Run: python scripts/build_canonical_dataset.py
(or run with --build to run both automatically!)
"""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_JS = ROOT_DIR / "js" / "data.js"
GEOJSON_FILE = ROOT_DIR / "geoJson" / "campus_data.geojson"


def extract_data_js():
    """Extracts CAMPUS_LOCATIONS and CAMPUS_OFFICES from js/data.js using Node.js."""
    node_script = """
    const fs = require('fs');
    let code = fs.readFileSync('./js/data.js', 'utf8');
    code = code.replace(/const\\s+CAMPUS_GROUPS\\s*=/, 'window.CAMPUS_GROUPS =');
    code = code.replace(/const\\s+CAMPUS_CENTER\\s*=/, 'window.CAMPUS_CENTER =');
    const ctx = { window: {} };
    ctx.window = ctx;
    require('vm').runInNewContext(code, ctx);

    const locations = ctx.window.CAMPUS_LOCATIONS || [];
    const offices = ctx.window.CAMPUS_OFFICES || [];
    console.log(JSON.stringify({ locations, offices }));
    """
    res = subprocess.run(
        ["node", "-e", node_script],
        cwd=ROOT_DIR,
        capture_output=True,
        text=True,
        check=True
    )
    return json.loads(res.stdout)


def sync_geojson(dry_run=False):
    print("=" * 60)
    print("SYNCING geoJson/campus_data.geojson FROM js/data.js")
    print("=" * 60)

    # 1. Read data from js/data.js
    raw_data = extract_data_js()
    locations = raw_data.get("locations", [])
    offices = raw_data.get("offices", [])
    print(f"[1/3] Extracted {len(locations)} locations and {len(offices)} offices from js/data.js")

    # 2. Read existing campus_data.geojson
    if not GEOJSON_FILE.exists():
        print(f"Error: {GEOJSON_FILE} does not exist!")
        sys.exit(1)

    with open(GEOJSON_FILE, "r", encoding="utf-8") as f:
        geojson = json.load(f)

    features = geojson.get("features", [])
    feature_map = {}
    for idx, feat in enumerate(features):
        fid = feat.get("id") or feat.get("properties", {}).get("id")
        if fid:
            feature_map[fid] = idx

    updated_count = 0
    added_count = 0

    # 3. Synchronize locations
    all_items = []
    for loc in locations:
        loc_copy = dict(loc)
        loc_copy["_source_type"] = "location"
        all_items.append(loc_copy)

    for off in offices:
        off_copy = dict(off)
        off_copy["_source_type"] = "office"
        all_items.append(off_copy)

    for item in all_items:
        item_id = item.get("id")
        if not item_id:
            continue

        lat = item.get("lat")
        lng = item.get("lng")
        if lat is None or lng is None:
            continue

        source_type = item.pop("_source_type", "location")

        if item_id in feature_map:
            # Update existing feature
            idx = feature_map[item_id]
            feat = features[idx]

            # Update coordinates [lng, lat]
            feat["geometry"]["coordinates"] = [lng, lat]

            # Merge / update properties from data.js
            props = feat.setdefault("properties", {})
            for k, v in item.items():
                props[k] = v

            # Ensure id matches
            feat["id"] = item_id
            props["id"] = item_id

            updated_count += 1
        else:
            # Add new Point feature
            new_feat = {
                "type": "Feature",
                "id": item_id,
                "geometry": {
                    "type": "Point",
                    "coordinates": [lng, lat]
                },
                "properties": dict(item)
            }
            new_feat["properties"]["id"] = item_id
            features.append(new_feat)
            feature_map[item_id] = len(features) - 1
            added_count += 1
            print(f"  + Added new GeoJSON feature: {item_id} ({item.get('name')})")

    geojson["features"] = features

    print(f"[2/3] Sync results: {updated_count} updated, {added_count} newly added. Total features: {len(features)}")

    # 4. Save updated campus_data.geojson
    if not dry_run:
        with open(GEOJSON_FILE, "w", encoding="utf-8") as f:
            json.dump(geojson, f, indent=2, ensure_ascii=False)
        print(f"[3/3] Successfully saved updated {GEOJSON_FILE.relative_to(ROOT_DIR)}!")
    else:
        print("[3/3] Dry run mode - file not modified.")

    print("=" * 60)


if __name__ == "__main__":
    auto_build = "--build" in sys.argv or "-b" in sys.argv
    sync_geojson()

    if auto_build:
        print("\n--> Running build_canonical_dataset.py as requested...")
        build_script = ROOT_DIR / "scripts" / "build_canonical_dataset.py"
        subprocess.run([sys.executable, str(build_script)], cwd=ROOT_DIR, check=True)
