#!/usr/bin/env python3
"""
LPUNavix - Full Footpaths & Layers Recreator
---------------------------------------------
Reads:
  - geoJson/footpath.geojson
Updates and recreates the whole footpath dataset:
  1. geoJson/footpath.geojson (refreshes area_geometry for ALL footpaths)
  2. geoJson/footpath_areas.geojson (recreates merged corridor polygon areas from scratch)
  3. geoJson/footpath_casings.geojson (recreates all border casings from scratch)

Run with:
  python scripts/recreate_footpath_layers.py
  or:
  node scripts/recreate_footpath_layers.js
"""

import sys
import subprocess
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
NODE_SCRIPT = ROOT_DIR / "scripts" / "recreate_footpath_layers.js"


def main():
    if not NODE_SCRIPT.is_file():
        print(f"[ERROR] Node script not found at {NODE_SCRIPT}", file=sys.stderr)
        sys.exit(1)

    try:
        res = subprocess.run(["node", str(NODE_SCRIPT)], cwd=str(ROOT_DIR), check=True)
        sys.exit(res.returncode)
    except FileNotFoundError:
        print("[ERROR] 'node' executable not found in PATH. Please install or ensure Node.js is accessible.", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        sys.exit(e.returncode)


if __name__ == "__main__":
    main()
