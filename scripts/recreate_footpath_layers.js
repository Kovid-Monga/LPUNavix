#!/usr/bin/env node
/**
 * LPUNavix - Footpath Layers & Geometry Recreator
 * ------------------------------------------------
 * Reads:  geoJson/footpath.geojson
 * Updates:
 *   1. geoJson/footpath.geojson (recomputes area_geometry for EVERY footpath centerline)
 *   2. geoJson/footpath_areas.geojson (recreates all merged corridor polygon areas from scratch)
 *   3. geoJson/footpath_casings.geojson (recreates all border casing lines from scratch)
 *
 * This ensures that when you edit footpaths in QGIS (moving points, adding new paths,
 * or deleting obsolete paths), running this script updates the WHOLE footpath dataset
 * cleanly, keeping centerline geometries, properties, corridor polygons, and border casings
 * 100% in sync across the entire project.
 *
 * Run with:
 *   node scripts/recreate_footpath_layers.js
 *   or: python scripts/recreate_footpath_layers.py
 */

const fs = require('fs');
const path = require('path');
const martinez = require('../js/martinez.min.js');

const ROOT_DIR = path.resolve(__dirname, '..');
const GEOJSON_DIR = path.join(ROOT_DIR, 'geoJson');

const FOOTPATH_FILE = path.join(GEOJSON_DIR, 'footpath.geojson');
const AREAS_FILE = path.join(GEOJSON_DIR, 'footpath_areas.geojson');
const CASINGS_FILE = path.join(GEOJSON_DIR, 'footpath_casings.geojson');

function getFootpathWidthMeters(highway) {
  switch (highway) {
    case 'pedestrian': return 4.6;
    case 'track': return 3.6;
    case 'cycleway': return 3.4;
    case 'steps': return 2.0;
    default: return 3.7;
  }
}

/**
 * Creates a miter-joined ribbon polygon ring around a centerline [lng, lat] coordinate list.
 */
function bufferCenterline(coords, widthMeters = 3.7) {
  if (!coords || !Array.isArray(coords) || coords.length < 2) return null;
  const halfWidth = widthMeters / 2;
  const meanLat = (coords.reduce((sum, p) => sum + p[1], 0) / coords.length) * Math.PI / 180;
  const originLng = coords[0][0];
  const originLat = coords[0][1];
  const metersPerLng = 111320 * Math.cos(meanLat);
  const metersPerLat = 110540;

  let points = coords.map(([lng, lat]) => [
    (lng - originLng) * metersPerLng,
    (lat - originLat) * metersPerLat
  ]);

  // Discard points that are virtually identical (< 0.05 meters) to avoid zero-length normals
  points = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.05);
  if (points.length < 2) return null;

  const directions = [];
  const normals = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const len = Math.hypot(dx, dy);
    directions.push([dx / len, dy / len]);
    normals.push([-dy / len, dx / len]);
  }

  function offsetSide(side) {
    const edge = [];
    for (let i = 0; i < points.length; i++) {
      if (i === 0) {
        edge.push([
          points[0][0] - directions[0][0] * halfWidth + normals[0][0] * halfWidth * side,
          points[0][1] - directions[0][1] * halfWidth + normals[0][1] * halfWidth * side
        ]);
      } else if (i === points.length - 1) {
        const last = points.length - 1;
        const d = directions[directions.length - 1];
        const n = normals[normals.length - 1];
        edge.push([
          points[last][0] + d[0] * halfWidth + n[0] * halfWidth * side,
          points[last][1] + d[1] * halfWidth + n[1] * halfWidth * side
        ]);
      } else {
        const before = [normals[i - 1][0] * side, normals[i - 1][1] * side];
        const after = [normals[i][0] * side, normals[i][1] * side];
        let mx = before[0] + after[0];
        let my = before[1] + after[1];
        let mag = Math.hypot(mx, my);
        if (mag < 1e-8) {
          mx = after[0];
          my = after[1];
          mag = Math.hypot(mx, my);
        }
        mx /= mag;
        my /= mag;
        const denom = mx * after[0] + my * after[1];
        let dist = halfWidth / Math.max(Math.abs(denom), 0.5);
        dist = Math.min(dist, halfWidth * 2);
        edge.push([points[i][0] + mx * dist, points[i][1] + my * dist]);
      }
    }
    return edge;
  }

  const left = offsetSide(1);
  const right = offsetSide(-1).reverse();
  const ringXY = left.concat(right);
  const ring = ringXY.map(([x, y]) => [
    Number((originLng + x / metersPerLng).toFixed(7)),
    Number((originLat + y / metersPerLat).toFixed(7))
  ]);
  if (ring.length >= 3) {
    ring.push([...ring[0]]); // Close polygon ring
  }
  return ring;
}

function extractLineStrings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

function main() {
  console.log("==================================================");
  console.log(">> LPUNavix - Full Footpaths & Layers Recreator");
  console.log(`>> Source: ${FOOTPATH_FILE}`);
  console.log("==================================================");

  if (!fs.existsSync(FOOTPATH_FILE)) {
    console.error(`[ERROR] File not found: ${FOOTPATH_FILE}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(FOOTPATH_FILE, 'utf8');
  const footpathCollection = JSON.parse(rawData);

  if (!footpathCollection || !Array.isArray(footpathCollection.features)) {
    console.error(`[ERROR] Invalid GeoJSON structure in ${FOOTPATH_FILE}`);
    process.exit(1);
  }

  console.log(`[INFO] Loaded ${footpathCollection.features.length} footpath features.`);

  const polys = [];
  let updatedFeaturesCount = 0;

  // STEP 1: Recalculate whole footpaths and update area_geometry for all features
  footpathCollection.features.forEach((feature, idx) => {
    feature.properties = feature.properties || {};
    const hw = feature.properties.highway || 'footway';
    const width = getFootpathWidthMeters(hw);

    const lineParts = extractLineStrings(feature.geometry);
    if (lineParts.length === 0) return;

    let primaryAreaCoords = null;

    lineParts.forEach(coords => {
      if (coords.length < 2) return;
      // Always re-buffer from current centerline coordinates to reflect any edits made in QGIS
      const ring = bufferCenterline(coords, width);
      if (ring && ring.length >= 4) {
        if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
          ring.push([...ring[0]]);
        }
        polys.push([ring]);
        if (!primaryAreaCoords) {
          // Convert [lng, lat] back to [lat, lng] for properties.area_geometry
          primaryAreaCoords = ring.map(([lng, lat]) => [lat, lng]);
        }
      }
    });

    if (primaryAreaCoords) {
      feature.properties.area_geometry = primaryAreaCoords;
      updatedFeaturesCount++;
    }
  });

  // Save the freshly updated footpath.geojson with updated area geometries
  fs.writeFileSync(FOOTPATH_FILE, JSON.stringify(footpathCollection, null, 2) + "\n", 'utf8');
  console.log(`[SUCCESS] Refreshed all ${updatedFeaturesCount} footpaths in ${FOOTPATH_FILE}`);
  console.log(`[INFO] Prepared ${polys.length} freshly calculated corridor ribbons for union.`);

  if (polys.length === 0) {
    console.warn("[WARN] No valid walkway polygons could be created.");
    return;
  }

  // STEP 2: Union overlapping polygons using Martinez polygon clipping algorithm
  let merged = polys[0];
  let unionErrors = 0;

  for (let i = 1; i < polys.length; i++) {
    try {
      const res = martinez.union(merged, polys[i]);
      if (res && res.length > 0) {
        merged = res;
      }
    } catch (err) {
      unionErrors++;
      // If a complex non-manifold junction cannot be clipped, preserve as independent polygon
      merged.push(...polys[i]);
    }
  }

  if (unionErrors > 0) {
    console.log(`[INFO] Handled ${unionErrors} non-manifold junctions by preserving separate polygons.`);
  }

  // STEP 3: Construct clean footpath_areas.geojson
  const areaFeatures = merged.map((poly, pi) => ({
    type: "Feature",
    properties: { id: pi },
    geometry: {
      type: "Polygon",
      coordinates: poly
    }
  }));

  const areasGeoJson = {
    type: "FeatureCollection",
    features: areaFeatures
  };

  // STEP 4: Construct clean footpath_casings.geojson
  const casingFeatures = [];
  merged.forEach((poly, pi) => {
    poly.forEach((ring, ri) => {
      casingFeatures.push({
        type: "Feature",
        properties: {
          polyId: pi,
          ringId: ri,
          isHole: ri > 0
        },
        geometry: {
          type: "LineString",
          coordinates: ring
        }
      });
    });
  });

  const casingsGeoJson = {
    type: "FeatureCollection",
    features: casingFeatures
  };

  // STEP 5: Save newly created areas and casings GeoJSON files
  fs.writeFileSync(AREAS_FILE, JSON.stringify(areasGeoJson, null, 2) + "\n", 'utf8');
  console.log(`[SUCCESS] Recreated ${AREAS_FILE} (${areaFeatures.length} polygon areas)`);

  fs.writeFileSync(CASINGS_FILE, JSON.stringify(casingsGeoJson, null, 2) + "\n", 'utf8');
  console.log(`[SUCCESS] Recreated ${CASINGS_FILE} (${casingFeatures.length} border casings)`);

  console.log("==================================================");
  console.log("✔ Whole footpath network and all layers updated successfully!");
}

if (require.main === module) {
  main();
}

module.exports = { main, bufferCenterline, getFootpathWidthMeters };
