/**
 * LPU Map - Map Controller (MapLibre GL JS Engine)
 * Manages tiles, layers, boundary polygon, custom markers, and route paths.
 * Uses exact original LPU_BOUNDARY and pre-cached static CAMPUS_ROADS_DATA.
 * Dynamically scales road/footpath strokes with zoom levels to prevent congestion.
 */

// ============================================================================
// 🎨 CAMPUS THEME & COLOR CONFIGURATION (Change colors here easily)
// ============================================================================
const CAMPUS_STYLE_CONFIG = {
  // Vehicle Roads
  roadCore: '#222d3d',           // Rich dark asphalt charcoal
  roadOpacity: 0.95,
  roadCasing: '#ffffff',          // Crisp clean white border
  roadCasingOpacity: 0.65,       // High clarity white outer border
  showRoadDivider: true,         // White dashed center line for realistic roads
  roadDivider: '#ffffff',        // Clean white painted dashes
  roadArrow: 'rgba(255, 255, 255, 0.9)', // Directional chevron color

  // Footpaths & Walkways (Natural Sandstone & Architectural Paver)
  footpathCore: '#dfd7cc',        // Elegant warm sandstone paver surface
  footpathOpacity: 0.94,
  footpathBrickSeam: '#37332fff',   // Dark, distinct brick joints
  footpathBrickSeamOpacity: 0.80, // High contrast, clearly defined brick lines
  footpathCasing: '#4a3f33',      // Dark stone curb border (stands out clearly against sandstone)
  footpathCasingOpacity: 0.60,    // Defined outer curb border

  // Campus Boundary Perimeter & Outside Dimming
  boundaryLine: '#c5ffc1ff',        // Boundary line color (Green / Blue / Black)
  boundaryOpacity: 0.95,          // ◀️ Boundary line translucency (0.0 to 1.0)
  outsideDimMask: '#020617',      // Dimming color for area outside campus
  outsideDimOpacity: 0.35         // ◀️ ADJUST DIMMING HERE: 0.0 (no dimming) to 1.0 (black), 0.15-0.20 is very gentle!
};

// Point-in-polygon helper using ray-casting algorithm
function isPointInPolygon(point, vs) {
  if (!Array.isArray(vs) || vs.length === 0) return true;
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1];
    const xj = vs[j][0], yj = vs[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

class MapLibreMarkerCollection {
  constructor(map) {
    this.map = map;
    this.markers = new Set();
  }

  addLayer(marker) {
    if (!marker) return this;
    marker.addTo(this.map);
    this.markers.add(marker);
    return this;
  }

  removeLayer(marker) {
    if (!marker) return this;
    marker.remove();
    this.markers.delete(marker);
    return this;
  }

  clearLayers() {
    this.markers.forEach(marker => marker.remove());
    this.markers.clear();
    return this;
  }
}

class CampusMapController {
  constructor() {
    this.map = null;
    this.tileLayers = {};
    this.markersLayer = null;
    this.routesLayer = null;
    this.kartsLayer = null;
    this.userLocationMarker = null;
    this.locationWatchId = null;
    this.currentUserCoords = null;
    this.currentTheme = "light";
    this.currentLayerMode = "satellite";
    this.defaultZoom = 15.7;
    this.defaultPitch = 45;
    this.defaultBearing = -15;
    this.showRoads = true;
    this.showFootpaths = true;
    this.showBoundary = true;
    this.mapResizeObserver = null;
    this.revealedLocationIds = new Set();
    this.selectedLocationId = null;
    this.currentFilterCategory = "all";
    this.initialCenter = null;
    this.initialZoom = null;
    this.mapReady = false;
    this.geoJsonData = {};
    this.hasActiveRoutePreview = false;
    this.routeAnimFrame = null;
    this.routeDashStep = 0;
  }

  init() {
    const isMobile = window.innerWidth <= 768;
    this.map = new maplibregl.Map({
      container: "map",
      style: { version: 8, sources: {}, layers: [] },
      center: [CAMPUS_CENTER[1], CAMPUS_CENTER[0]],
      zoom: this.defaultZoom,
      pitch: this.defaultPitch,
      bearing: this.defaultBearing,
      maxZoom: 20,
      attributionControl: { compact: true },
      cooperativeGestures: false,
      renderWorldCopies: false,
      minPitch: 0,
      maxPitch: 85,
      dragRotate: true,
      touchPitch: true,
      touchZoomRotate: true,
      pitchWithRotate: true
    });
    // Shift + drag and middle-button drag are used for camera rotation below.
    this.map.boxZoom.disable();

    this.markersLayer = new MapLibreMarkerCollection(this.map);
    this.routesLayer = new MapLibreMarkerCollection(this.map);
    this.kartsLayer = new MapLibreMarkerCollection(this.map);

    this.map.on("load", async () => {
      try {
        await this.loadGeoJsonAssets();
        this.addBaseMapSources();
        this.addCampusMapLayers();
        this.mapReady = true;
        this.setBaseLayer(this.currentLayerMode);
        this.renderCampusBoundary();
        this.renderCampusRoadNetwork();
        this.setupIntuitiveRotationHandlers();
        this.startLocationTracking();
        this.renderLocationMarkers();
        if (this.pendingRoute) {
          const pending = this.pendingRoute;
          this.pendingRoute = null;
          this.drawRoute(pending.path, pending.isDetour, pending.closedPathCoords, pending.options);
        }
        this.map.fitBounds(this.getBoundaryBounds(), {
          padding: { top: isMobile ? 95 : 70, right: isMobile ? 10 : 70, bottom: isMobile ? 85 : 70, left: isMobile ? 95 : 70 },
          maxZoom: this.defaultZoom,
          pitch: this.defaultPitch,
          bearing: this.defaultBearing,
          duration: 0
        });
        // fitBounds chooses a zoom that fits the entire campus. Apply the
        // chosen default afterward to start closer in.
        this.map.setZoom(this.defaultZoom);
        const initialCenter = this.map.getCenter();
        this.initialCenter = [initialCenter.lng, initialCenter.lat];
        this.initialZoom = this.map.getZoom();
      } catch (error) {
        console.error("MapLibre map setup failed:", error);
      }
    });

    this.map.on("zoom", () => this.updateMarkerLabelVisibility());
    this.map.on("zoomend", () => {
      this.updateMarkerLabelVisibility();
      this.renderLocationMarkers(this.currentFilterCategory || "all");
    });
    this.map.on("moveend", () => {
      this.updateMarkerLabelVisibility();
      this.renderLocationMarkers(this.currentFilterCategory || "all");
    });
    this.map.on("rotate", () => {
      const dial = document.querySelector("#ctrl-compass .compass-dial");
      if (dial) dial.style.transform = `rotate(${-this.map.getBearing()}deg)`;
    });

    this.map.on("click", (e) => {
      // Ignore if a marker or cluster was just clicked
      if (this._justClickedMarker || (Date.now() - (this._lastMarkerClickTime || 0) < 400)) {
        return;
      }
      if (e && e.originalEvent && e.originalEvent.target && typeof e.originalEvent.target.closest === "function") {
        if (e.originalEvent.target.closest(".custom-campus-pin, .custom-campus-cluster, .campus-pin-wrapper, .maplibregl-marker")) {
          return;
        }
      }
      if (this.selectedLocationId) {
        this.clearRevealedLocations();
        if (window.UIController && typeof window.UIController.closeLocationDetails === "function") {
          window.UIController.closeLocationDetails();
        }
      }
    });

    const refreshMapSize = () => {
      if (this.map) requestAnimationFrame(() => this.map.resize());
    };
    this.mapResizeObserver = new ResizeObserver(refreshMapSize);
    const mapEl = document.getElementById('map');
    if (mapEl) this.mapResizeObserver.observe(mapEl);
    window.addEventListener('orientationchange', refreshMapSize);
    window.addEventListener('resize', refreshMapSize);

    return this;
  }

  getBoundaryCoordinates() {
    if (this.geoJsonData && this.geoJsonData.boundary && Array.isArray(this.geoJsonData.boundary.features) && this.geoJsonData.boundary.features.length > 0) {
      const feat = this.geoJsonData.boundary.features[0];
      if (feat.geometry && feat.geometry.type === "Polygon" && Array.isArray(feat.geometry.coordinates) && feat.geometry.coordinates[0]) {
        return feat.geometry.coordinates[0].map(([lng, lat]) => [lat, lng]);
      }
    }
    if (typeof window !== "undefined" && window.LPU_BOUNDARY && Array.isArray(window.LPU_BOUNDARY) && window.LPU_BOUNDARY.length > 0) {
      return window.LPU_BOUNDARY;
    }
    return (typeof LPU_BOUNDARY !== "undefined" && Array.isArray(LPU_BOUNDARY)) ? LPU_BOUNDARY : [];
  }

  getBoundaryBounds() {
    const coords = this.getBoundaryCoordinates();
    if (!coords.length) return [[75.697, 31.245], [75.710, 31.262]];
    const lngs = coords.map(point => point[1]);
    const lats = coords.map(point => point[0]);
    return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
  }

  async loadGeoJsonAssets() {
    const load = async (file, fallback = { type: "FeatureCollection", features: [] }) => {
      try {
        const response = await fetch(`geoJson/${file}`, { cache: "no-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        console.warn(`Could not load geoJson/${file}`, error);
        return fallback;
      }
    };

    const emptyCollection = { type: "FeatureCollection", features: [] };

    let loadedAreas = null;
    let loadedCasings = null;
    [
      this.geoJsonData.roads,
      this.geoJsonData.footpaths,
      this.geoJsonData.boundary,
      this.geoJsonData.campusData,
      loadedAreas,
      loadedCasings
    ] = await Promise.all([
      load("roads.geojson", emptyCollection),
      load("footpath.geojson", emptyCollection),
      load("boundry.geojson", emptyCollection),
      load("campus_data.geojson", null),
      load("footpath_areas.geojson", emptyCollection),
      load("footpath_casings.geojson", emptyCollection)
    ]);

    this.geoJsonData.footpathAreas = (loadedAreas && Array.isArray(loadedAreas.features)) ? loadedAreas : emptyCollection;
    this.geoJsonData.footpathCasings = (loadedCasings && Array.isArray(loadedCasings.features)) ? loadedCasings : emptyCollection;
    this.geoJsonData.footpathLines = emptyCollection;

    this.geoJsonData.footpathBricks = this.buildFootpathBrickSeams(this.geoJsonData.footpaths);
    this.geoJsonData.roadDividers = this.buildRoadDividers(this.geoJsonData.roads);

    // Convert GeoJSON roads and footpaths into window.CAMPUS_ROADS_DATA
    const combinedRoads = [];
    const pushFeatures = (col) => {
      if (col && Array.isArray(col.features)) {
        col.features.forEach(f => {
          if (f.geometry && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length >= 2) {
            combinedRoads.push({
              id: f.id !== undefined ? f.id : (f.properties && f.properties.id),
              tags: {
                highway: (f.properties && f.properties.highway) || "road",
                name: (f.properties && f.properties.name) || "",
                oneway: (f.properties && f.properties.oneway) || "",
                junction: (f.properties && f.properties.junction) || ""
              },
              coords: f.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
              areaGeometry: (f.properties && f.properties.area_geometry) || null
            });
          }
        });
      }
    };
    pushFeatures(this.geoJsonData.roads);
    pushFeatures(this.geoJsonData.footpaths);

    if (typeof window !== "undefined") {
      window.CAMPUS_ROADS_DATA = combinedRoads;
      window.LPU_BOUNDARY = this.getBoundaryCoordinates();
    }
    if (typeof window !== "undefined" && window.Directions && window.Directions.roadGraph) {
      window.Directions.roadGraph.buildGraphFromGeoJson(this.geoJsonData.roads, this.geoJsonData.footpaths);
    }
  }

  buildFootpathBrickSeams(footpathCollection) {
    const features = [];
    if (!footpathCollection || !Array.isArray(footpathCollection.features)) {
      return { type: "FeatureCollection", features };
    }

    const metresPerDegree = 111320;
    const courseLength = 1.6; // 1.6m course length along the path
    const halfWidth = 2.15;   // 2.15m half-width (stays cleanly within paver walkway, zero whiskers!)
    const numBricksAcross = 3; // 3 bricks across the walkway in running bond

    // Precalculate junction hubs across the footpath network (fuzzy clustering within 6.5m)
    const endpoints = [];
    footpathCollection.features.forEach((f, idx) => {
      const c = f.geometry && f.geometry.coordinates;
      if (!Array.isArray(c) || c.length < 2) return;
      endpoints.push({ idx, coord: c[0] });
      endpoints.push({ idx, coord: c[c.length - 1] });
    });

    const distM = (c1, c2, cosLat) => {
      const dx = (c1[0] - c2[0]) * metresPerDegree * cosLat;
      const dy = (c1[1] - c2[1]) * metresPerDegree;
      return Math.hypot(dx, dy);
    };

    const junctionHubs = [];
    const visited = new Set();
    for (let i = 0; i < endpoints.length; i++) {
      if (visited.has(i)) continue;
      const group = [endpoints[i]];
      visited.add(i);
      const cosLat0 = Math.cos(endpoints[i].coord[1] * Math.PI / 180);
      for (let j = i + 1; j < endpoints.length; j++) {
        if (distM(endpoints[i].coord, endpoints[j].coord, cosLat0) < 6.5) {
          group.push(endpoints[j]);
          visited.add(j);
        }
      }
      if (group.length > 1) {
        const sum = group.reduce((acc, p) => [acc[0] + p.coord[0], acc[1] + p.coord[1]], [0, 0]);
        junctionHubs.push([sum[0] / group.length, sum[1] / group.length]);
      }
    }

    footpathCollection.features.forEach(feature => {
      const coords = feature.geometry && feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;

      const originLat = coords[0][1];
      const cosLat = Math.cos(originLat * Math.PI / 180);
      if (!Number.isFinite(cosLat) || Math.abs(cosLat) < 1e-5) return;

      // Project path coordinates to local metric space
      const pts = coords.map(([lng, lat]) => ({
        x: (lng - coords[0][0]) * metresPerDegree * cosLat,
        y: (lat - coords[0][1]) * metresPerDegree
      }));

      // Precalculate segment lengths and cumulative distances
      const segLengths = [];
      const cumLengths = [0];
      let totalLen = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x;
        const dy = pts[i + 1].y - pts[i].y;
        const len = Math.hypot(dx, dy);
        segLengths.push(len);
        totalLen += len;
        cumLengths.push(totalLen);
      }

      if (totalLen < 2.0) return;

      // Inset from junction endpoints so seams stop cleanly before intersection zones
      const isStartJunction = junctionHubs.some(jh => distM(coords[0], jh, cosLat) < 6.5);
      const isEndJunction = junctionHubs.some(jh => distM(coords[coords.length - 1], jh, cosLat) < 6.5);

      const startOffset = isStartJunction ? Math.min(3.2, totalLen * 0.4) : 0.8;
      const endOffset = isEndJunction ? totalLen - Math.min(3.2, totalLen * 0.4) : totalLen - 0.8;

      if (endOffset <= startOffset + 0.8) return;

      // Interpolates position and perpendicular normal at distance d along the path
      const getStateAt = (d) => {
        d = Math.max(0, Math.min(totalLen, d));
        let segIdx = segLengths.length - 1;
        for (let i = 0; i < segLengths.length; i++) {
          if (d <= cumLengths[i + 1] || i === segLengths.length - 1) {
            segIdx = i;
            break;
          }
        }
        const segLen = Math.max(1e-6, segLengths[segIdx]);
        const segStartDist = cumLengths[segIdx];
        const t = (d - segStartDist) / segLen;
        const p1 = pts[segIdx];
        const p2 = pts[segIdx + 1];

        const x = p1.x + t * (p2.x - p1.x);
        const y = p1.y + t * (p2.y - p1.y);

        // Unit tangent and normal (perpendicular) vectors
        const tx = (p2.x - p1.x) / segLen;
        const ty = (p2.y - p1.y) / segLen;
        const nx = -ty;
        const ny = tx;

        return { x, y, nx, ny };
      };

      const toLngLat = (x, y) => [
        Number((coords[0][0] + x / (metresPerDegree * cosLat)).toFixed(7)),
        Number((coords[0][1] + y / metresPerDegree).toFixed(7))
      ];

      let courseIndex = 0;
      for (let d = startOffset; d <= endOffset; d += courseLength) {
        const state = getStateAt(d);

        // 1. Transverse joint: clean cross seam fanning perpendicular to curve
        const leftX = state.x + state.nx * halfWidth;
        const leftY = state.y + state.ny * halfWidth;
        const rightX = state.x - state.nx * halfWidth;
        const rightY = state.y - state.ny * halfWidth;

        features.push({
          type: "Feature",
          properties: { type: "course" },
          geometry: {
            type: "LineString",
            coordinates: [toLngLat(leftX, leftY), toLngLat(rightX, rightY)]
          }
        });

        // 2. Longitudinal joints: running-bond stagger between courses
        const nextD = Math.min(endOffset, d + courseLength);
        if (nextD - d > 0.4) {
          const nextState = getStateAt(nextD);
          const offsetFraction = (courseIndex % 2 === 0) ? 0 : 0.5;

          for (let b = 1; b < numBricksAcross; b++) {
            const u = -halfWidth + ((b + offsetFraction) / numBricksAcross) * (2 * halfWidth);
            if (u > -halfWidth + 0.25 && u < halfWidth - 0.25) {
              const startX = state.x + state.nx * u;
              const startY = state.y + state.ny * u;
              const endX = nextState.x + nextState.nx * u;
              const endY = nextState.y + nextState.ny * u;

              features.push({
                type: "Feature",
                properties: { type: "head" },
                geometry: {
                  type: "LineString",
                  coordinates: [toLngLat(startX, startY), toLngLat(endX, endY)]
                }
              });
            }
          }
        }
        courseIndex++;
      }
    });

    return { type: "FeatureCollection", features };
  }

  buildRoadDividers(roadsCollection) {
    const features = [];
    if (!roadsCollection || !Array.isArray(roadsCollection.features)) {
      return { type: "FeatureCollection", features };
    }

    const metresPerDegree = 111320;
    const dashLength = 4.8; // 4.8m painted dash
    const gapLength = 3.6;  // 3.6m space between dashes
    const cycle = dashLength + gapLength;
    const minRoadLength = 7.0;

    roadsCollection.features.forEach(feature => {
      if (!feature.geometry || feature.geometry.type !== "LineString") return;
      const coords = feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;

      const originLat = coords[0][1];
      const cosLat = Math.cos(originLat * Math.PI / 180);
      if (!Number.isFinite(cosLat) || Math.abs(cosLat) < 1e-5) return;

      const segmentDistances = [];
      const cumDistances = [0];
      let totalLength = 0;

      for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i + 1];
        const dx = (p2[0] - p1[0]) * metresPerDegree * cosLat;
        const dy = (p2[1] - p1[1]) * metresPerDegree;
        const dist = Math.hypot(dx, dy);
        segmentDistances.push(dist);
        totalLength += dist;
        cumDistances.push(totalLength);
      }

      if (totalLength < minRoadLength) return;

      const getPointAt = (d) => {
        if (d <= 0) return coords[0];
        if (d >= totalLength) return coords[coords.length - 1];

        for (let i = 0; i < segmentDistances.length; i++) {
          const segDist = segmentDistances[i];
          if (segDist <= 1e-6) continue;
          const startDist = cumDistances[i];
          const endDist = cumDistances[i + 1];

          if (d >= startDist && d <= endDist) {
            const t = (d - startDist) / segDist;
            const p1 = coords[i];
            const p2 = coords[i + 1];
            return [
              Number((p1[0] + t * (p2[0] - p1[0])).toFixed(7)),
              Number((p1[1] + t * (p2[1] - p1[1])).toFixed(7))
            ];
          }
        }
        return coords[coords.length - 1];
      };

      const startOffset = Math.min(gapLength * 0.75, totalLength * 0.1);
      const endOffset = totalLength - startOffset;

      for (let d = startOffset; d + 1.2 < endOffset; d += cycle) {
        const dashStart = d;
        const dashEnd = Math.min(d + dashLength, endOffset);
        if (dashEnd - dashStart < 1.2) break;

        const dashCoords = [];
        dashCoords.push(getPointAt(dashStart));

        for (let i = 1; i < coords.length - 1; i++) {
          const vDist = cumDistances[i];
          if (vDist > dashStart + 0.2 && vDist < dashEnd - 0.2) {
            dashCoords.push(coords[i]);
          }
        }

        dashCoords.push(getPointAt(dashEnd));

        features.push({
          type: "Feature",
          properties: { roadId: feature.id || (feature.properties && feature.properties.id) || "" },
          geometry: { type: "LineString", coordinates: dashCoords }
        });
      }
    });

    return { type: "FeatureCollection", features };
  }

  addBaseMapSources() {
    const sources = {
      street: {
        type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256,
        attribution: "© OpenStreetMap contributors", maxzoom: 19
      },
      satellite: {
        type: "raster", tiles: ["https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"], tileSize: 256,
        attribution: "© Google", maxzoom: 20
      },
      carto: {
        type: "raster", tiles: ["https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"], tileSize: 256,
        attribution: "© OpenStreetMap © CARTO", maxzoom: 19
      }
    };

    Object.entries(sources).forEach(([id, source]) => {
      this.map.addSource(`basemap-${id}`, source);
      this.map.addLayer({
        id: `basemap-${id}`,
        type: "raster",
        source: `basemap-${id}`,
        layout: { visibility: "none" },
        paint: { "raster-fade-duration": 0 }
      });
      this.tileLayers[id] = `basemap-${id}`;
    });
  }

  addCampusMapLayers() {
    this.map.addSource("campus-boundary", { type: "geojson", data: this.geoJsonData.boundary });
    this.map.addSource("campus-roads", { type: "geojson", data: this.geoJsonData.roads, lineMetrics: true });
    this.map.addSource("campus-road-dividers", { type: "geojson", data: this.geoJsonData.roadDividers });
    this.map.addSource("campus-footpath-areas", { type: "geojson", data: this.geoJsonData.footpathAreas });
    this.map.addSource("campus-footpath-casings", { type: "geojson", data: this.geoJsonData.footpathCasings });
    this.map.addSource("campus-footpath-lines", { type: "geojson", data: this.geoJsonData.footpathLines, lineMetrics: true });
    this.map.addSource("campus-footpath-bricks", { type: "geojson", data: this.geoJsonData.footpathBricks });

    this.map.addLayer({ id: "campus-boundary-fill", type: "fill", source: "campus-boundary", paint: { "fill-color": "#020617", "fill-opacity": 0 } });
    this.map.addLayer({
      id: "campus-boundary-line", type: "line", source: "campus-boundary", layout: { "line-join": "round" }, paint: {
        "line-color": CAMPUS_STYLE_CONFIG.boundaryLine || "#3b82f6", "line-width": 3.5, "line-opacity": CAMPUS_STYLE_CONFIG.boundaryOpacity || 0.9
      }
    });

    this.map.addLayer({
      id: "footpath-area-fill", type: "fill", source: "campus-footpath-areas", paint: {
        "fill-color": CAMPUS_STYLE_CONFIG.footpathCore, "fill-opacity": CAMPUS_STYLE_CONFIG.footpathOpacity
      }
    });
    this.map.addLayer({
      id: "footpath-brick-seams", type: "line", source: "campus-footpath-bricks", minzoom: 10.5, layout: { "line-cap": "round", "line-join": "round" }, paint: {
        "line-color": CAMPUS_STYLE_CONFIG.footpathBrickSeam,
        "line-opacity": CAMPUS_STYLE_CONFIG.footpathBrickSeamOpacity,
        "line-width": ["interpolate", ["linear"], ["zoom"], 16.0, 0.1, 18, 0.3, 20, 0.5]
      }
    });
    this.map.addLayer({
      id: "footpath-area-casing", type: "line", source: "campus-footpath-casings", minzoom: 10.5, layout: { "line-cap": "round", "line-join": "round" }, paint: {
        "line-color": CAMPUS_STYLE_CONFIG.footpathCasing, "line-opacity": CAMPUS_STYLE_CONFIG.footpathCasingOpacity,
        "line-width": 0.8
      }
    });
    this.map.addLayer({
      id: "footpath-line-casing", type: "line", source: "campus-footpath-lines", minzoom: 10.5, layout: { "line-cap": "round", "line-join": "round" }, paint: {
        "line-color": CAMPUS_STYLE_CONFIG.footpathCasing, "line-opacity": CAMPUS_STYLE_CONFIG.footpathCasingOpacity,
        "line-width": 1.0
      }
    });
    this.map.addLayer({
      id: "footpath-line-core", type: "line", source: "campus-footpath-lines", layout: { "line-cap": "round", "line-join": "round" }, paint: {
        "line-color": CAMPUS_STYLE_CONFIG.footpathCore, "line-opacity": CAMPUS_STYLE_CONFIG.footpathOpacity,
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1.5, 15, 2.5, 17, 4.0, 19, 5.5]
      }
    });

    // Roads are deliberately added after footpaths so vehicle routes sit on top.
    this.map.addLayer({
      id: "road-casing", type: "line", source: "campus-roads", layout: { "line-cap": "round", "line-join": "round" }, paint: {
        "line-color": CAMPUS_STYLE_CONFIG.roadCasing, "line-opacity": CAMPUS_STYLE_CONFIG.roadCasingOpacity,
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          13, 5.0,
          15, 8.5,
          17, 14.5,
          18.5, 21.0,
          20, 29.0
        ]
      }
    });
    this.map.addLayer({
      id: "road-core", type: "line", source: "campus-roads", layout: { "line-cap": "round", "line-join": "round" }, paint: {
        "line-color": CAMPUS_STYLE_CONFIG.roadCore, "line-opacity": CAMPUS_STYLE_CONFIG.roadOpacity,
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          13, 3.0,
          15, 5.8,
          17, 11.0,
          18.5, 16.5,
          20, 23.5
        ]
      }
    });

    if (CAMPUS_STYLE_CONFIG.showRoadDivider) {
      this.map.addLayer({
        id: "road-divider", type: "line", source: "campus-road-dividers", minzoom: 10.5, layout: { "line-cap": "round", "line-join": "round" }, paint: {
          "line-color": CAMPUS_STYLE_CONFIG.roadDivider, "line-opacity": 0.95,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            15, 1.0,
            17, 1.5,
            18.5, 2.0,
            20, 2.6
          ]
        }
      });
    }

    this.addOneWayArrowImage();
    this.map.addLayer({
      id: "road-oneway-arrows", type: "symbol", source: "campus-roads", minzoom: 17.5, filter: ["any", ["==", ["get", "oneway"], "yes"], ["==", ["get", "oneway"], "1"], ["==", ["get", "junction"], "roundabout"]], layout: {
        "symbol-placement": "line", "symbol-spacing": 260, "icon-image": "lpu-oneway-arrow", "icon-size": 0.45,
        "icon-rotation-alignment": "map", "icon-allow-overlap": false, "icon-ignore-placement": false
      }, paint: { "icon-opacity": 0.85 }
    });

    this.addRouteLayers();
    this.map.on("click", "road-core", event => this.showNetworkPopup(event, "Road"));
    this.map.on("click", "footpath-area-fill", event => this.showNetworkPopup(event, "Footpath / Walkway"));
    this.map.on("click", "footpath-line-core", event => this.showNetworkPopup(event, "Footpath / Walkway"));
    this.map.on("mouseenter", "road-core", () => { this.map.getCanvas().style.cursor = "pointer"; });
    this.map.on("mouseleave", "road-core", () => { this.map.getCanvas().style.cursor = ""; });
    this.map.on("mouseenter", "footpath-area-fill", () => { this.map.getCanvas().style.cursor = "pointer"; });
    this.map.on("mouseleave", "footpath-area-fill", () => { this.map.getCanvas().style.cursor = ""; });
  }

  addOneWayArrowImage() {
    if (!this.map || this.map.hasImage("lpu-oneway-arrow")) return;
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    // Draw a clean, modern directional chevron pointing along the road
    context.strokeStyle = "#ffffff";
    context.lineWidth = 4.5;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(14, 12);
    context.lineTo(32, 24);
    context.lineTo(14, 36);
    context.stroke();
    this.map.addImage("lpu-oneway-arrow", context.getImageData(0, 0, 48, 48), { pixelRatio: 2 });
  }

  addRouteLayers() {
    const empty = { type: "FeatureCollection", features: [] };
    ["route-main", "route-casing", "route-rim", "route-alternate", "route-closed", "route-connectors", "route-moving-dots"].forEach(id => {
      this.map.addSource(id, { type: "geojson", data: empty, lineMetrics: true });
    });
    const line = (id, source, paint, minzoom = 0) => this.map.addLayer({
      id, type: "line", source, minzoom,
      layout: { "line-cap": "round", "line-join": "round" }, paint
    });
    line("route-alternate-line", "route-alternate", {
      "line-color": "#94a3b8",
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 14, 4.5, 16, 6, 18, 8],
      "line-opacity": 0.75,
      "line-dasharray": [0, 2.8]
    });
    line("route-closed-line", "route-closed", {
      "line-color": "#ef4444",
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 14, 4.5, 16, 6, 18, 8],
      "line-opacity": 0.9,
      "line-dasharray": [2, 2.6]
    });
    line("route-connector-outline", "route-connectors", {
      "line-color": "#334155",
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4.5, 14, 6.0, 16, 8.0, 18, 10.5],
      "line-dasharray": [0, 2.8]
    });
    line("route-connector-dots", "route-connectors", {
      "line-color": "#ffffff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 14, 3.8, 16, 5.2, 18, 7.2],
      "line-dasharray": [0, 2.8]
    });
    line("route-nav-casing", "route-casing", { "line-color": "#ffffff", "line-width": 13, "line-opacity": 0.95 });
    line("route-preview-rim", "route-rim", {
      "line-color": "#2373f4",
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        12, 3.5,
        14, 4.8,
        16, 6.8,
        18, 9.0,
        20, 11.5
      ],
      "line-opacity": 0.18
    });
    line("route-main-preview", "route-main", {
      "line-color": "#2373f4",
      "line-width": 1,
      "line-opacity": 0
    });
    this.map.setLayoutProperty("route-main-preview", "visibility", "none");
    this.map.addLayer({
      id: "route-moving-dots",
      type: "circle",
      source: "route-moving-dots",
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          12, 2.4,
          14, 3.4,
          16, 4.8,
          18, 6.4,
          20, 8.0
        ],
        "circle-color": "#2373f4",
        "circle-opacity": 0.95
      }
    });
    line("route-main-active", "route-main", { "line-color": "#0f172a", "line-width": 8.5 });
    this.map.setLayoutProperty("route-main-active", "visibility", "none");
  }

  lineFeature(coords) {
    return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords.map(([lat, lng]) => [lng, lat]) } };
  }

  setGeoJsonSource(id, features) {
    if (!this.map || !this.mapReady) return;
    const source = this.map.getSource(id);
    if (source) source.setData({ type: "FeatureCollection", features });
  }

  addHtmlMarker(coords, html, wrapperClass = "", zIndex = 0) {
    const element = document.createElement("div");
    element.className = wrapperClass;
    element.innerHTML = html;
    element.style.zIndex = String(zIndex);
    return new maplibregl.Marker({ element, anchor: "center" }).setLngLat([coords[1], coords[0]]);
  }

  getBoundsForLatLngs(points) {
    if (!Array.isArray(points) || points.length === 0) return null;
    const lngs = points.map(point => point[1]);
    const lats = points.map(point => point[0]);
    return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
  }

  expandBounds(bounds, fraction = 0.2) {
    if (!bounds) return null;
    const [[west, south], [east, north]] = bounds;
    const dx = (east - west) * fraction;
    const dy = (north - south) * fraction;
    return [[west - dx, south - dy], [east + dx, north + dy]];
  }

  showNetworkPopup(event, title) {
    const feature = event.features && event.features[0];
    if (!feature) return;
    const name = feature.properties && feature.properties.name;
    const content = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = title;
    content.appendChild(heading);
    if (name) {
      content.appendChild(document.createElement("br"));
      content.appendChild(document.createTextNode(String(name)));
    }
    new maplibregl.Popup({ closeButton: true, closeOnClick: true }).setLngLat(event.lngLat).setDOMContent(content).addTo(this.map);
  }

  updateMarkerLabelVisibility() {
    if (!this.map) return;
    const zoom = this.map.getZoom();
    const showLabels = zoom >= 15.0;
    const mapContainer = this.map.getContainer();
    if (mapContainer) {
      mapContainer.classList.toggle("show-poi-labels", showLabels);
      mapContainer.classList.toggle("hide-poi-labels", !showLabels);
    }
  }

  setBaseLayer(layerName) {
    const selected = this.tileLayers[layerName] ? layerName : "satellite";
    this.currentLayerMode = selected;
    if (!this.map || !this.mapReady) return;
    Object.entries(this.tileLayers).forEach(([name, layerId]) => {
      if (this.map.getLayer(layerId)) this.map.setLayoutProperty(layerId, "visibility", name === selected ? "visible" : "none");
    });
  }

  renderCampusBoundary() {
    if (!this.map || !this.mapReady) return;
    ["campus-boundary-line", "campus-boundary-fill"].forEach(id => {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", this.showBoundary ? "visible" : "none");
    });
  }

  renderUserLocation(coords) {
    if (this.userLocationMarker) {
      this.userLocationMarker.setLngLat([coords[1], coords[0]]);
      return;
    }

    const iconHtml = `
      <div class="user-location-marker">
        <div class="user-location-pulse"></div>
        <div class="user-location-dot"></div>
      </div>
    `;

    this.userLocationMarker = this.addHtmlMarker(coords, iconHtml, "user-loc-div-icon", 2000);
    this.userLocationMarker.addTo(this.map);
  }

  startLocationTracking() {
    if (!navigator.geolocation) {
      console.warn("Geolocation is not supported by this browser.");
      return;
    }

    if (this.locationWatchId !== null) {
      navigator.geolocation.clearWatch(this.locationWatchId);
      this.locationWatchId = null;
    }

    this.locationWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        this.currentUserCoords = [lat, lng];

        // Directly render/update the real GPS marker at the user's coordinates
        this.renderUserLocation([lat, lng]);
      },
      (error) => {
        console.warn("Geolocation watchPosition error:", error.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 12000
      }
    );
  }

  stopLocationTracking() {
    if (this.locationWatchId !== null) {
      navigator.geolocation.clearWatch(this.locationWatchId);
      this.locationWatchId = null;
    }
  }

  renderCampusRoadNetwork() {
    if (!this.map || !this.mapReady) return;
    ["road-casing", "road-core", "road-divider", "road-oneway-arrows"].forEach(id => {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", this.showRoads ? "visible" : "none");
    });
    ["footpath-area-casing", "footpath-area-fill", "footpath-brick-seams", "footpath-line-casing", "footpath-line-core"].forEach(id => {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", this.showFootpaths ? "visible" : "none");
    });
  }

  // ============================================================================
  // 🗂️ LAYER VISIBILITY CONTROLS
  // ============================================================================
  setLayerVisibility(type, visible) {
    if (type === 'roads') {
      this.showRoads = visible;
      this.renderCampusRoadNetwork();
    } else if (type === 'footpaths') {
      this.showFootpaths = visible;
      this.renderCampusRoadNetwork();
    } else if (type === 'boundary') {
      this.showBoundary = visible;
      this.renderCampusBoundary();
    }
  }

  setAllLayersVisibility(visible) {
    this.showRoads = visible;
    this.showFootpaths = visible;
    this.showBoundary = visible;
    this.renderCampusRoadNetwork();
    this.renderCampusBoundary();
  }

  getLocationTheme(category, name = "", type = "") {
    const text = `${name} ${type} ${category}`.toLowerCase();
    if (text.includes("library") || text.includes("reading room")) return "library";
    if (text.includes("health") || text.includes("hospital") || text.includes("medical") || text.includes("clinic") || text.includes("doctor") || text.includes("first aid")) return "healthcare";
    if (text.includes("gate") || text.includes("checkpoint") || text.includes("entry") || text.includes("barrier")) return "gates";
    if (text.includes("auditorium") || text.includes("theatre") || text.includes("theater") || text.includes("audi ") || text.includes("audi-") || text.includes("convocation")) return "auditorium";
    if (text.includes("park") || text.includes("garden") || text.includes("lawn") || text.includes("green space")) return "park";
    if (text.includes("parking")) return "parking";
    if (text.includes("bus") || text.includes("transport") || text.includes("transit") || text.includes("auto stand") || text.includes("kart")) return "transport";
    if (text.includes("food") || text.includes("cafe") || text.includes("canteen") || text.includes("mess") || text.includes("dining") || text.includes("kiosk") || text.includes("bakery") || text.includes("rolls") || text.includes("burger")) return "food";
    if (text.includes("gym") || text.includes("sports") || text.includes("stadium") || text.includes("ground") || text.includes("court") || text.includes("fitness") || text.includes("pool")) return "sports";
    if (text.includes("hostel") || text.includes("residential") || text.includes("bh-") || text.includes("bh ") || text.includes("bs-") || text.includes("bs ") || text.includes("gh-") || text.includes("gh ") || text.includes("gs-") || text.includes("gs ") || text.includes("apartment") || text.includes("studio") || text.includes("boys hostel") || text.includes("girls hostel") || text.includes("girls studio") || category === "hostels") return "hostels";
    if (text.includes("atm") || text.includes("bank") || text.includes("finance") || text.includes("post office")) return "finance";
    if (text.includes("mall") || text.includes("unimall") || text.includes("shop") || text.includes("mart") || text.includes("store") || text.includes("salon")) return "shop";
    if (text.includes("cse") || text.includes("computer science") || text.includes("coding") || text.includes("software") || text.includes("tech")) return "tech";
    if (text.includes("admin") || text.includes("office") || text.includes("dean") || text.includes("director") || text.includes("admission") || text.includes("reception") || category === "offices" || category === "office") return "offices";
    if (category === "academics" || category === "academic" || text.includes("block") || text.includes("department") || text.includes("school of")) return "academics";
    return category || "others";
  }

  getCategoryIconSvg(category, name = "", type = "") {
    const theme = this.getLocationTheme(category, name, type);
    if (theme === "library") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>`;
    } else if (theme === "healthcare") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="M4 12h16"/></svg>`;
    } else if (theme === "gates") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-7a3 3 0 0 1 6 0v7"/></svg>`;
    } else if (theme === "food") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>`;
    } else if (theme === "parking") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4.5a3 3 0 0 1 0 6H9"/></svg>`;
    } else if (theme === "auditorium") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M4 20V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11"/><polygon points="12 3 4 8 20 8 12 3"/><path d="M10 20v-5h4v5"/></svg>`;
    } else if (theme === "park") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-7"/><path d="M12 15a6 6 0 1 0-6-6c0 1.5.5 2.8 1.4 3.9A4.5 4.5 0 0 0 12 15z"/><path d="M12 15a6 6 0 1 1 6-6c0 1.5-.5 2.8-1.4 3.9A4.5 4.5 0 0 1 12 15z"/></svg>`;
    } else if (theme === "transport") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="14" rx="3"/><path d="M3 10h18"/><path d="M7 17v3"/><path d="M17 17v3"/><circle cx="7.5" cy="13.5" r="1.5"/><circle cx="16.5" cy="13.5" r="1.5"/></svg>`;
    } else if (theme === "tech") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/><path d="M9 10l-2 2 2 2"/><path d="M15 10l2 2-2 2"/></svg>`;
    } else if (theme === "sports") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4a2 2 0 0 1-2-2V5h4"/><path d="M18 9h2a2 2 0 0 0 2-2V5h-4"/><path d="M4 5h16v5a6 6 0 0 1-12 0V5z"/><path d="M12 15v4"/><path d="M8 21h8"/></svg>`;
    } else if (theme === "hostels") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><circle cx="6" cy="11" r="2"/></svg>`;
    } else if (theme === "finance") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="21" x2="21" y2="21"/><line x1="4" y1="10" x2="20" y2="10"/><polygon points="12 3 2 10 22 10 12 3"/><line x1="6" y1="10" x2="6" y2="21"/><line x1="10" y1="10" x2="10" y2="21"/><line x1="14" y1="10" x2="14" y2="21"/><line x1="18" y1="10" x2="18" y2="21"/></svg>`;
    } else if (theme === "shop") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`;
    } else if (theme === "offices") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`;
    } else if (theme === "academics") {
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>`;
    }
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
  }

  resolveLabelCollisions(items) {
    if (!this.map || !Array.isArray(items) || items.length === 0) return items;

    // Sort descending by priority:
    // 100+: selected / revealed
    // 60: major campus landmarks
    // 45: cluster markers
    // 25: standard buildings
    // 5: fine-grained offices/cabins
    const sorted = [...items].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    const placedBoxes = [];

    for (const item of sorted) {
      if (!item.latLng) {
        item.showLabel = true;
        continue;
      }

      // Convert geographic coords to container pixel coordinates
      const projected = this.map.project([item.latLng[1], item.latLng[0]]);
      const pt = { x: projected.x, y: projected.y };
      item.containerPoint = pt;

      // Group cluster markers always show their full pill
      if (item.isCluster) {
        const titleStr = item.title || "";
        const clusterWidth = Math.max(90, (titleStr.length * 7.5) + 48);
        const box = {
          x1: pt.x - (clusterWidth / 2) - 4,
          y1: pt.y - 15,
          x2: pt.x + (clusterWidth / 2) + 4,
          y2: pt.y + 15
        };
        placedBoxes.push(box);
        item.showLabel = true;
        continue;
      }

      // Selected / revealed location ALWAYS displays its label with highest priority
      if (item.isSelected || item.isRevealed) {
        const nameStr = item.name || "";
        const labelWidth = Math.min(180, Math.max(50, (nameStr.length * 7.2) + 16));
        placedBoxes.push({
          x1: pt.x - 14,
          y1: pt.y - 14,
          x2: pt.x + 14 + labelWidth + 4,
          y2: pt.y + 14
        });
        item.showLabel = true;
        continue;
      }

      // Individual marker: pin circle is 26x26 (radius 13)
      // Label extends to the right by labelWidth
      const nameStr = item.name || "";
      const labelWidth = Math.min(160, Math.max(55, (nameStr.length * 7.0) + 16));
      const testBox = {
        x1: pt.x + 10,
        y1: pt.y - 12,
        x2: pt.x + 10 + labelWidth + 4,
        y2: pt.y + 12
      };

      // Check collision with already placed boxes
      let collides = false;
      for (const pb of placedBoxes) {
        if (testBox.x1 < pb.x2 && testBox.x2 > pb.x1 &&
          testBox.y1 < pb.y2 && testBox.y2 > pb.y1) {
          collides = true;
          break;
        }
      }

      if (!collides) {
        placedBoxes.push(testBox);
        item.showLabel = true;
      } else {
        // Suppress text label; icon pin remains crisp, visible and clickable!
        item.showLabel = false;
        // Reserve small pin area so other labels don't collide directly over the pin icon
        placedBoxes.push({
          x1: pt.x - 14,
          y1: pt.y - 14,
          x2: pt.x + 14,
          y2: pt.y + 14
        });
      }
    }

    return items;
  }

  renderLocationMarkers(filterCategory = "all") {
    if (!this.markersLayer || !this.mapReady) return;
    this.markersLayer.clearLayers();
    this.currentFilterCategory = filterCategory;

    const allLocations = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (window.CAMPUS_LOCATIONS || []);
    if (!Array.isArray(allLocations) || allLocations.length === 0) return;

    // If campus_data.geojson was loaded, sync any coordinates from it
    if (this.geoJsonData && this.geoJsonData.campusData && Array.isArray(this.geoJsonData.campusData.features)) {
      const geoCoordsMap = new Map();
      this.geoJsonData.campusData.features.forEach(f => {
        const id = f.id || (f.properties && f.properties.id);
        const geom = f.geometry;
        if (id && geom && geom.coordinates && geom.coordinates.length >= 2) {
          geoCoordsMap.set(id, [geom.coordinates[1], geom.coordinates[0]]); // [lat, lng]
        }
      });
      allLocations.forEach(loc => {
        if (loc && loc.id && geoCoordsMap.has(loc.id)) {
          const [glat, glng] = geoCoordsMap.get(loc.id);
          loc.lat = glat;
          loc.lng = glng;
        }
      });
    }

    let currentZoom = 15.25;
    let bounds = null;
    try {
      if (this.map) {
        currentZoom = this.map.getZoom();
        bounds = this.map.getBounds();
      }
    } catch (e) { }

    // Filter locations strictly within LPU campus boundary
    const boundaryCoords = this.getBoundaryCoordinates();
    const lpuOnly = allLocations.filter(loc => {
      if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return false;
      const isInCampus = boundaryCoords.length ? isPointInPolygon([loc.lat, loc.lng], boundaryCoords) : true;
      const isRevealed = this.revealedLocationIds.has(loc.id) || this.selectedLocationId === loc.id;
      let isVisibleAtZoom = true;
      if (loc.visibleFromZoom) {
        // High zoom details (e.g. offices/faculty cabins) visible at zoom >= 18.5
        const zoomThreshold = Math.min(loc.visibleFromZoom, 18.5);
        isVisibleAtZoom = isRevealed || (
          currentZoom >= zoomThreshold &&
          (!bounds || (bounds.getWest() <= loc.lng && loc.lng <= bounds.getEast() && bounds.getSouth() <= loc.lat && loc.lat <= bounds.getNorth()))
        );
      }
      return isInCampus && isVisibleAtZoom;
    });

    const filtered = filterCategory === "all"
      ? lpuOnly
      : lpuOnly.filter(loc => loc.category === filterCategory);

    // ========================================================================
    // 3-LEVEL ZOOM-DEPENDENT MARKER & CLUSTERING LOGIC
    // Level 1: Far zoom (< 15.6) — Campus Overview (Clusters + Key Landmarks)
    // Level 2: Medium zoom (15.6 - 16.99) — Block & Department Level (Group Labels with Counts)
    // Level 3: Close zoom (>= 17.0) — Individual Building Markers (Expanded with Collision Prevention)
    // ========================================================================
    const isCloseZoom = currentZoom >= 17.0;
    const isMediumZoom = currentZoom >= 15.6 && currentZoom < 17.0;

    // Academic & Central Zone cluster members:
    // CSE Blocks + immediate adjacent high-density buildings: Central Library & Shanti Devi Mittal Auditorium
    const isCentralZoneMember = (loc) => {
      return (loc.groupId === "cse-dept" && !loc.visibleFromZoom) ||
        loc.id === "central-library" ||
        loc.id === "shanti-devi-mittal-auditorium";
    };

    // Residential Zone cluster members (BH Hostels, BS Studios, Apartments, GH Hostels, GS Studios)
    const isResidentialMember = (loc) => {
      return loc.groupId === "residential-area" || loc.groupId === "girls-residential-area" || loc.category === "hostels";
    };

    const cseGroupLocs = filtered.filter(l => isCentralZoneMember(l));
    const resGroupLocs = filtered.filter(l => isResidentialMember(l));
    const otherLocs = filtered.filter(l => !isCentralZoneMember(l) && !isResidentialMember(l));

    const itemsToRender = [];

    if (!isCloseZoom && cseGroupLocs.length > 0) {
      // User is at Far or Medium zoom: merge CSE blocks, Central Library & Shanti Devi Auditorium into unified cluster
      const unrevealedCse = cseGroupLocs.filter(l => !this.revealedLocationIds.has(l.id) && l.id !== this.selectedLocationId);
      const revealedCse = cseGroupLocs.filter(l => this.revealedLocationIds.has(l.id) || l.id === this.selectedLocationId);

      // Any revealed/searched building (even Central Library, Shanti Devi, or Block 34) is ALWAYS shown individually and highlighted
      revealedCse.forEach(loc => {
        itemsToRender.push({
          isCluster: false,
          loc,
          latLng: [loc.lat, loc.lng],
          name: loc.name,
          category: loc.category,
          priority: 100,
          isSelected: this.selectedLocationId === loc.id,
          isRevealed: this.revealedLocationIds.has(loc.id)
        });
      });

      if (unrevealedCse.length > 0) {
        if (isMediumZoom && currentZoom >= 16.3) {
          // Medium-close zoom: split into 2 natural block rows
          const northBlocks = unrevealedCse.filter(l => ["block-25", "block-26", "block-27", "block-28"].includes(l.id));
          const southBlocks = unrevealedCse.filter(l => !["block-25", "block-26", "block-27", "block-28"].includes(l.id));

          if (northBlocks.length > 0) {
            const nBounds = this.getBoundsForLatLngs(northBlocks.map(l => [l.lat, l.lng]));
            itemsToRender.push({
              isCluster: true,
              groupId: "cse-dept-north",
              title: "Blocks 25–28 (CSE)",
              fullTitle: "School of CSE (Blocks 25 to 28)",
              count: northBlocks.length,
              category: "academics",
              latLng: [31.25263, 75.70310],
              bounds: nBounds,
              memberLocs: northBlocks,
              priority: 45
            });
          }

          if (southBlocks.length > 0) {
            const sBounds = this.getBoundsForLatLngs(southBlocks.map(l => [l.lat, l.lng]));
            itemsToRender.push({
              isCluster: true,
              groupId: "cse-dept-south",
              title: "Blocks 31–38 (CSE & Library)",
              fullTitle: "School of CSE, Central Library & Auditorium (Blocks 31 to 38)",
              count: southBlocks.length,
              category: "academics",
              latLng: [31.25193, 75.70435],
              bounds: sBounds,
              memberLocs: southBlocks,
              priority: 45
            });
          }
        } else {
          // Far or broad medium zoom: single clean CSE Blocks cluster badge encompassing CSE, Library & Auditorium
          const cseBounds = this.getBoundsForLatLngs(unrevealedCse.map(l => [l.lat, l.lng]));
          itemsToRender.push({
            isCluster: true,
            groupId: "cse-dept",
            title: "CSE Blocks",
            fullTitle: "School of Computer Science & Engineering, Central Library & Auditorium",
            count: unrevealedCse.length,
            category: "academics",
            latLng: [31.25227, 75.70390],
            bounds: cseBounds,
            memberLocs: unrevealedCse,
            priority: 45
          });
        }
      }
    } else {
      // Close zoom (zoom >= 17.0): expand ALL CSE buildings, Central Library & Shanti Devi Auditorium into individual markers!
      cseGroupLocs.forEach(loc => {
        const isSel = this.selectedLocationId === loc.id;
        const isRev = this.revealedLocationIds.has(loc.id);
        itemsToRender.push({
          isCluster: false,
          loc,
          latLng: [loc.lat, loc.lng],
          name: loc.name,
          category: loc.category,
          priority: isSel || isRev ? 100 : (loc.id === "central-library" || loc.id === "shanti-devi-mittal-auditorium" ? 60 : 25),
          isSelected: isSel,
          isRevealed: isRev
        });
      });
    }

    // Residential Area clustering logic (Hostels, Studios & Apartments)
    if (!isCloseZoom && filterCategory === "all" && resGroupLocs.length > 0) {
      const unrevealedRes = resGroupLocs.filter(l => !this.revealedLocationIds.has(l.id) && l.id !== this.selectedLocationId);
      const revealedRes = resGroupLocs.filter(l => this.revealedLocationIds.has(l.id) || l.id === this.selectedLocationId);

      revealedRes.forEach(loc => {
        itemsToRender.push({
          isCluster: false,
          loc,
          latLng: [loc.lat, loc.lng],
          name: loc.name,
          category: loc.category,
          priority: 100,
          isSelected: this.selectedLocationId === loc.id,
          isRevealed: this.revealedLocationIds.has(loc.id)
        });
      });

      if (unrevealedRes.length > 0) {
        const girlsRes = unrevealedRes.filter(l => l.groupId === "girls-residential-area" || l.id.startsWith("gh-") || l.id.startsWith("gs-"));
        const boysRes = unrevealedRes.filter(l => !girlsRes.includes(l));

        if (boysRes.length > 0) {
          const resBounds = this.getBoundsForLatLngs(boysRes.map(l => [l.lat, l.lng]));
          itemsToRender.push({
            isCluster: true,
            groupId: "residential-area",
            title: "Boys Hostels & Studios",
            fullTitle: "Campus Residential Area (Boys Hostels, Studios & Apartments)",
            count: boysRes.length,
            category: "hostels",
            latLng: [31.249742, 75.703481],
            bounds: resBounds,
            memberLocs: boysRes,
            priority: 45
          });
        }

        if (girlsRes.length > 0) {
          const gBounds = this.getBoundsForLatLngs(girlsRes.map(l => [l.lat, l.lng]));
          itemsToRender.push({
            isCluster: true,
            groupId: "girls-residential-area",
            title: "Girls Hostels & Studios",
            fullTitle: "Girls Residential Area (GH Hostels & GS Studios)",
            count: girlsRes.length,
            category: "hostels",
            latLng: [31.2568, 75.7049],
            bounds: gBounds,
            memberLocs: girlsRes,
            priority: 45
          });
        }
      }
    } else {
      // Close zoom (zoom >= 17.0) or filterCategory === "hostels": show individual hostel markers!
      resGroupLocs.forEach(loc => {
        const isSel = this.selectedLocationId === loc.id;
        const isRev = this.revealedLocationIds.has(loc.id);
        itemsToRender.push({
          isCluster: false,
          loc,
          latLng: [loc.lat, loc.lng],
          name: loc.name,
          category: loc.category,
          priority: isSel || isRev ? 100 : 25,
          isSelected: isSel,
          isRevealed: isRev
        });
      });
    }

    // Render other landmarks and non-CSE locations
    otherLocs.forEach(loc => {
      const isSel = this.selectedLocationId === loc.id;
      const isRev = this.revealedLocationIds.has(loc.id);

      // Major landmarks have higher priority
      let priority = 20;
      if (
        loc.id === "uni-health-center" ||
        loc.id === "sh-baldevraj-mittal-auditorium" ||
        loc.id === "unipolis" ||
        loc.id === "unimall" ||
        loc.id === "sports-complex" ||
        loc.id === "block-29"
      ) {
        priority = 60;
      } else if (loc.id.startsWith("main-gate")) {
        priority = 50;
      } else if (loc.visibleFromZoom) {
        priority = 5;
      }
      if (isSel || isRev) priority = 100;

      itemsToRender.push({
        isCluster: false,
        loc,
        latLng: [loc.lat, loc.lng],
        name: loc.name,
        category: loc.category,
        priority,
        isSelected: isSel,
        isRevealed: isRev
      });
    });

    // Run Screen-Space Collision Resolution
    const resolvedItems = this.resolveLabelCollisions(itemsToRender);

    // Keep the existing location marker styles and zoom/cluster behavior as DOM markers.
    resolvedItems.forEach(item => {
      if (item.isCluster) {
        // Render Group Cluster Marker
        const iconSvg = this.getCategoryIconSvg(item.category, item.title, item.fullTitle);
        const clusterTheme = this.getLocationTheme(item.category, item.title, item.fullTitle);
        const clusterHtml = `
          <div class="custom-campus-cluster cluster-${clusterTheme} cluster-${item.category || 'academics'}" data-group-id="${item.groupId}" title="${item.fullTitle} (${item.count} Buildings)">
            <div class="cluster-pill">
              <div class="cluster-icon">${iconSvg}</div>
              <span class="cluster-title">${item.title}</span>
              <span class="cluster-count">${item.count}</span>
            </div>
          </div>
        `;

        const clusterMarker = this.addHtmlMarker(item.latLng, clusterHtml, "campus-pin-wrapper", 1000);
        clusterMarker.getElement().addEventListener("click", (e) => {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }
          this._justClickedMarker = true;
          this._lastMarkerClickTime = Date.now();
          setTimeout(() => { this._justClickedMarker = false; }, 400);

          if (item.bounds) {
            this.map.fitBounds(this.expandBounds(item.bounds, 0.22), { maxZoom: 17.5, duration: 850, padding: 60 });
          } else if (item.latLng) {
            this.map.flyTo({ center: [item.latLng[1], item.latLng[0]], zoom: 17.5, duration: 850 });
          }
        });

        this.markersLayer.addLayer(clusterMarker);

      } else {
        // Render Individual Location Marker
        const loc = item.loc;
        const iconSvg = this.getCategoryIconSvg(loc.category, loc.name, loc.type);
        const theme = this.getLocationTheme(loc.category, loc.name, loc.type);
        const isSelected = item.isSelected;
        const isRevealed = item.isRevealed;
        const hasLabel = Boolean(item.showLabel || isSelected || isRevealed);

        const pinClass = `pin-${theme} pin-${loc.category || 'others'} ${hasLabel ? '' : 'pin-icon-only'} ${isSelected ? 'selected' : ''} ${isRevealed ? 'revealed' : ''}`;

        const customHtml = `
          <div class="custom-campus-pin ${pinClass}" data-id="${loc.id}" title="${loc.name}">
            <div class="pin-circle">
              <div class="pin-icon">${iconSvg}</div>
            </div>
            <span class="pin-label">${loc.name}</span>
          </div>
        `;

        const marker = this.addHtmlMarker([loc.lat, loc.lng], customHtml, "campus-pin-wrapper", isSelected || isRevealed ? 1000 : 0);
        marker.getElement().addEventListener("click", (e) => {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }
          this._justClickedMarker = true;
          this._lastMarkerClickTime = Date.now();
          setTimeout(() => { this._justClickedMarker = false; }, 400);

          this.selectedLocationId = loc.id;
          this.renderLocationMarkers(this.currentFilterCategory || "all");
          if (window.UIController) {
            window.UIController.showLocationDetails(loc);
          }
        });

        this.markersLayer.addLayer(marker);
      }
    });

    this.updateMarkerLabelVisibility();
  }

  revealLocation(locationId) {
    this.revealedLocationIds.add(locationId);
    this.selectedLocationId = locationId;
    this.renderLocationMarkers(this.currentFilterCategory || "all");
  }

  clearRevealedLocations() {
    this.revealedLocationIds.clear();
    this.selectedLocationId = null;
    this.renderLocationMarkers(this.currentFilterCategory || "all");
  }

  drawRoute(pathCoords, isDetour = false, closedPathCoords = null, options = {}) {
    if (!this.mapReady) {
      this.pendingRoute = { path: pathCoords, isDetour, closedPathCoords, options };
      return;
    }
    this.routesLayer.clearLayers();
    if (!Array.isArray(pathCoords) || pathCoords.length < 2) return;
    const validPath = pathCoords.filter(pt => Array.isArray(pt) && pt.length >= 2 && typeof pt[0] === "number" && typeof pt[1] === "number");
    if (validPath.length < 2) return;

    this.currentRouteData = { pathCoords: validPath, isDetour, closedPathCoords, options };
    const mode = options.mode || (window.Directions ? window.Directions.currentMode : "walking");
    const originName = options.originName || (window.Directions ? window.Directions.currentOrigin : "Start Location");
    const destName = options.destName || (window.Directions ? window.Directions.currentDestination : "Destination");
    const isNavigating = options.isNavigating === true;
    const roadCoords = options.roadPath && options.roadPath.length >= 2 ? options.roadPath : validPath;
    const mainLineColor = "#0f172a";
    const color = isNavigating ? mainLineColor : (mode === "walking" ? "#2373f4" : "#f97316");
    // Leaflet compatibility note: dashArray: mainLineDashArray

    this.setGeoJsonSource("route-main", [this.lineFeature(roadCoords)]);
    this.setGeoJsonSource("route-casing", isNavigating ? [this.lineFeature(roadCoords)] : []);
    this.setGeoJsonSource("route-rim", isNavigating ? [] : [this.lineFeature(roadCoords)]);
    this.map.setPaintProperty("route-main-preview", "line-color", color);
    this.map.setLayoutProperty("route-main-preview", "visibility", isNavigating ? "none" : "visible");
    this.map.setLayoutProperty("route-main-active", "visibility", isNavigating ? "visible" : "none");
    this.map.setPaintProperty("route-preview-rim", "line-color", color);

    if (!isNavigating) {
      this.startRouteDashAnimation(roadCoords, color);
    } else {
      this.stopRouteDashAnimation();
    }

    const closed = Array.isArray(closedPathCoords) ? closedPathCoords.filter(pt => Array.isArray(pt) && pt.length >= 2) : [];
    this.setGeoJsonSource("route-closed", closed.length >= 2 ? [this.lineFeature(closed)] : []);
    const alt = !isNavigating && options.alternateRoute && Array.isArray(options.alternateRoute.path)
      ? options.alternateRoute.path.filter(pt => Array.isArray(pt) && pt.length >= 2)
      : [];
    this.setGeoJsonSource("route-alternate", alt.length >= 2 ? [this.lineFeature(alt)] : []);
    const connectors = Array.isArray(options.connectors) ? options.connectors.filter(line => Array.isArray(line) && line.length >= 2).map(line => this.lineFeature(line)) : [];
    this.setGeoJsonSource("route-connectors", connectors);

    // map-route-floating-badge removed completely per user request

    (options.junctions || []).forEach(junction => {
      if (Array.isArray(junction) && junction.length >= 2) {
        this.routesLayer.addLayer(this.addHtmlMarker(junction, '<div class="route-junction-dot"></div>', "route-junction-icon", 2600));
      }
    });

    const startHtml = `<div class="map-route-marker start-route-marker"><div class="origin-ring-dot"></div><div class="route-marker-pill origin-pill">${originName}</div></div>`;
    this.routesLayer.addLayer(this.addHtmlMarker(validPath[0], startHtml, "map-route-marker-icon", 2500));

    if (Array.isArray(options.waypoints) && options.waypoints.length) {
      options.waypoints.forEach(wp => {
        if (!wp || typeof wp.lat !== "number" || typeof wp.lon !== "number") return;
        const html = `<div class="map-route-marker stop-route-marker"><div class="stop-dot-marker">${wp.stopIndex || ""}</div><div class="route-marker-pill stop-pill">${wp.display || wp.originalName || `Stop ${wp.stopIndex}`}</div></div>`;
        this.routesLayer.addLayer(this.addHtmlMarker([wp.lat, wp.lon], html, "map-route-marker-icon", 2800));
      });
    } else if (options.viaName && Array.isArray(options.viaCoords) && options.viaCoords.length >= 2) {
      const html = `<div class="map-route-marker stop-route-marker"><div class="stop-dot-marker"></div><div class="route-marker-pill stop-pill">${options.viaName}</div></div>`;
      this.routesLayer.addLayer(this.addHtmlMarker(options.viaCoords, html, "map-route-marker-icon", 2800));
    }

    const destHtml = `<div class="map-route-marker dest-route-marker"><div class="dest-pin-svg-wrap"><svg width="24" height="30" viewBox="0 0 24 30" fill="none"><path d="M12 0C5.37 0 0 5.37 0 12C0 21 12 30 12 30C12 30 24 21 24 12C24 5.37 18.63 0 12 0Z" fill="#DC2626"/><circle cx="12" cy="11" r="4.5" fill="#FFFFFF"/></svg></div><div class="route-marker-pill dest-pill">${destName}</div></div>`;
    this.routesLayer.addLayer(this.addHtmlMarker(validPath[validPath.length - 1], destHtml, "map-route-marker-icon", 3000));

    if (!options.skipFitBounds) {
      const bounds = this.getBoundsForLatLngs(roadCoords);
      if (bounds) this.map.fitBounds(bounds, { padding: 80, maxZoom: 17.5, duration: 700 });
    }
  }

  startRouteDashAnimation(coords, color = "#2373f4") {
    this.stopRouteDashAnimation();
    if (!this.map || !this.mapReady) return;

    const path = Array.isArray(coords) && coords.length >= 2 ? coords : (this.currentRouteCoords || []);
    if (!path || path.length < 2) return;
    this.currentRouteCoords = path;

    if (this.map.getLayer("route-moving-dots")) {
      this.map.setPaintProperty("route-moving-dots", "circle-color", color);
      this.map.setLayoutProperty("route-moving-dots", "visibility", "visible");
    }

    // Cumulative distances along path in meters
    const cum = [0];
    let totalDist = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];
      const dLat = (p2[0] - p1[0]) * 111320;
      const dLng = (p2[1] - p1[1]) * 111320 * Math.cos(p1[0] * Math.PI / 180);
      totalDist += Math.hypot(dLat, dLng);
      cum.push(totalDist);
    }

    if (totalDist < 4) return;

    const getPointAt = (d) => {
      if (d <= 0) return path[0];
      if (d >= totalDist) return path[path.length - 1];
      for (let i = 0; i < cum.length - 1; i++) {
        if (d >= cum[i] && d <= cum[i + 1]) {
          const seg = cum[i + 1] - cum[i];
          const t = seg > 0 ? (d - cum[i]) / seg : 0;
          return [
            path[i][0] + t * (path[i + 1][0] - path[i][0]),
            path[i][1] + t * (path[i + 1][1] - path[i][1])
          ];
        }
      }
      return path[path.length - 1];
    };

    let startTime = null;
    let lastRenderTime = 0;
    const fpsInterval = 32; // ~30 fps smooth hardware-accelerated flow

    const animate = (timestamp) => {
      if (!this.hasActiveRoutePreview) {
        this.routeAnimFrame = null;
        return;
      }

      if (timestamp - lastRenderTime >= fpsInterval) {
        lastRenderTime = timestamp;
        if (!startTime) startTime = timestamp;
        const elapsedSec = (timestamp - startTime) / 1000;

        const currentZoom = this.map ? this.map.getZoom() : 16.5;
        // Adaptive dot spacing: ensures dots never cluster when zooming out
        const dotSpacing = Math.max(12, 16 * Math.pow(2, Math.max(0, 16.5 - currentZoom)));
        const speedMps = dotSpacing * 0.95; // Moves ~1 dot spacing per second
        const offset = (elapsedSec * speedMps) % dotSpacing;

        const features = [];
        for (let d = offset; d < totalDist; d += dotSpacing) {
          const pt = getPointAt(d);
          features.push({
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [pt[1], pt[0]] }
          });
        }

        const source = this.map.getSource("route-moving-dots");
        if (source) {
          source.setData({ type: "FeatureCollection", features });
        }
      }

      this.routeAnimFrame = requestAnimationFrame(animate);
    };

    this.hasActiveRoutePreview = true;
    this.routeAnimFrame = requestAnimationFrame(animate);
  }

  stopRouteDashAnimation() {
    this.hasActiveRoutePreview = false;
    if (this.routeAnimFrame) {
      cancelAnimationFrame(this.routeAnimFrame);
      this.routeAnimFrame = null;
    }
    if (this.map && this.map.getSource("route-moving-dots")) {
      this.setGeoJsonSource("route-moving-dots", []);
    }
  }

  clearRoutes() {
    this.currentRouteData = null;
    this.currentRouteCoords = null;
    this.stopRouteDashAnimation();
    this.routesLayer.clearLayers();
    ["route-main", "route-casing", "route-rim", "route-alternate", "route-closed", "route-connectors", "route-moving-dots"].forEach(id => this.setGeoJsonSource(id, []));
  }

  clearRoute() {
    this.clearRoutes();
  }

  resetView() {
    if (typeof CAMPUS_CENTER !== "undefined" && typeof CAMPUS_DEFAULT_ZOOM !== "undefined") {
      this.map.flyTo({ center: [CAMPUS_CENTER[1], CAMPUS_CENTER[0]], zoom: CAMPUS_DEFAULT_ZOOM, duration: 1000 });
    }
  }

  flyToLocation(lat, lng, zoom = 17) {
    // Temporarily allow testing locations outside the LPU boundary.
    // if (!isPointInPolygon([lat, lng], LPU_BOUNDARY)) return;
    this.map.flyTo({ center: [lng, lat], zoom, duration: 1200 });
  }

  locateUser() {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
    }

    if (this.currentUserCoords && this.map) {
      this.map.flyTo({ center: [this.currentUserCoords[1], this.currentUserCoords[0]], zoom: 17, duration: 1200 });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        this.currentUserCoords = [lat, lng];

        this.renderUserLocation([lat, lng]);

        if (this.map) {
          this.map.flyTo({ center: [lng, lat], zoom: 17, duration: 1200 });
        }
      },
      (error) => {
        console.warn("Geolocation error:", error);
        alert("Unable to retrieve your current location. Please ensure browser location permissions are allowed.");
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  }

  recenterCampus() {
    const isMobile = window.innerWidth <= 768;
    if (this.getBoundaryCoordinates().length > 0) {
      this.map.fitBounds(this.expandBounds(this.getBoundaryBounds(), isMobile ? 0.04 : 0.12), {
        padding: { top: isMobile ? 95 : 70, right: isMobile ? 10 : 70, bottom: isMobile ? 85 : 70, left: isMobile ? 95 : 70 },
        duration: 1000
      });
    } else {
      this.map.flyTo({ center: [CAMPUS_CENTER[1], CAMPUS_CENTER[0]], zoom: isMobile ? 15.8 : 15.5, duration: 1000 });
    }
  }

  resetToInitialView() {
    if (!this.map) return;
    if (typeof this.resetOrientation === "function") {
      this.resetOrientation();
    }
    const center = this.initialCenter || (typeof CAMPUS_CENTER !== "undefined" ? [CAMPUS_CENTER[1], CAMPUS_CENTER[0]] : [75.7037, 31.2536]);
    const zoom = (this.initialZoom !== null && this.initialZoom !== undefined) ? this.initialZoom : 15.25;
    this.map.flyTo({ center, zoom, duration: 800 });
  }

  zoomIn() {
    this.map.zoomIn();
  }

  zoomOut() {
    this.map.zoomOut();
  }

  setupIntuitiveRotationHandlers() {
    if (!this.map) return;
    const canvas = this.map.getCanvas();
    if (!canvas || canvas.dataset.cameraGesturesReady === "true") return;
    canvas.dataset.cameraGesturesReady = "true";

    let isDraggingCamera = false;
    let startX = 0;
    let startY = 0;
    let startBearing = 0;
    let startPitch = 0;
    let restoreDragPan = false;
    let restoreDragRotate = false;

    canvas.addEventListener("mousedown", event => {
      const wantsCameraDrag = event.button === 1 || (event.button === 0 && (event.shiftKey || event.altKey));
      if (!wantsCameraDrag) return;

      isDraggingCamera = true;
      startX = event.clientX;
      startY = event.clientY;
      startBearing = this.map.getBearing();
      startPitch = this.map.getPitch();
      restoreDragPan = this.map.dragPan.isEnabled();
      restoreDragRotate = this.map.dragRotate.isEnabled();
      this.map.dragPan.disable();
      this.map.dragRotate.disable();
      canvas.style.cursor = "grabbing";
      event.preventDefault();
    });

    window.addEventListener("mousemove", event => {
      if (!isDraggingCamera || !this.map) return;
      this.map.jumpTo({
        bearing: startBearing + (event.clientX - startX) * 0.45,
        pitch: Math.max(0, Math.min(85, startPitch - (event.clientY - startY) * 0.4))
      });
    });

    window.addEventListener("mouseup", () => {
      if (!isDraggingCamera) return;
      isDraggingCamera = false;
      canvas.style.cursor = "";
      if (restoreDragPan) this.map.dragPan.enable();
      if (restoreDragRotate) this.map.dragRotate.enable();
    });
  }

  resetOrientation() {
    if (this.map && typeof this.map.setBearing === "function") {
      if (this._bearingAnimationFrame) {
        cancelAnimationFrame(this._bearingAnimationFrame);
      }

      const startBearing = this.map.getBearing ? this.map.getBearing() : 0;
      const shortestBearing = ((startBearing + 180) % 360) - 180;
      const duration = 500;
      const startedAt = performance.now();

      const animateBearing = (now) => {
        const progress = Math.min((now - startedAt) / duration, 1);
        const easedProgress = 1 - Math.pow(1 - progress, 3);
        this.map.setBearing(shortestBearing * (1 - easedProgress));

        if (progress < 1) {
          this._bearingAnimationFrame = requestAnimationFrame(animateBearing);
        } else {
          this._bearingAnimationFrame = null;
        }
      };

      this._bearingAnimationFrame = requestAnimationFrame(animateBearing);
    }
    const dial = document.querySelector("#ctrl-compass .compass-dial");
    if (dial) {
      dial.style.transition = "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)";
      dial.style.transform = "rotate(0deg)";
    }
  }
}

// Instantiate global Map Controller
window.CampusMap = new CampusMapController();
