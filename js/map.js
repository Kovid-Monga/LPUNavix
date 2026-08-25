/**
 * LPU Map - Map Controller (Leaflet.js Engine)
 * Manages tiles, layers, boundary polygon, custom markers, and route paths.
 * Uses exact original LPU_BOUNDARY and pre-cached static CAMPUS_ROADS_DATA.
 * Dynamically scales road/footpath strokes with zoom levels to prevent congestion.
 */

// ============================================================================
// 🎨 CAMPUS THEME & COLOR CONFIGURATION (Change colors here easily)
// ============================================================================
const CAMPUS_STYLE_CONFIG = {
  // Vehicle Roads
  roadCore: '#b4b0b0ff',          // Main road surface (Dark asphalt / grey)
  roadOpacity: 0.35,            // ◀️ Road Translucency (0.0 to 1.0)
  roadCasing: '#ffffff',        // Road outer border edges (White)
  roadCasingOpacity: 0.85,      // ◀️ Road border translucency
  roadDivider: '#ffffff',       // Center dashed lane divider
  roadArrow: '#4c4c4cff',         // Directional arrowheads

  // Footpaths & Walkways
  footpathCore: '#7c82ffff',      // Footpath surface (Terracotta / Orange)
  footpathOpacity: 0.65,        // ◀️ Footpath Translucency (0.0 to 1.0)
  footpathCasing: '#ffffff',    // Footpath outer border edges (White)
  footpathCasingOpacity: 0.85,  // ◀️ Footpath border translucency

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

class CampusMapController {
  constructor() {
    this.map = null;
    this.tileLayers = {};
    this.currentTileLayer = null;
    this.markersLayer = null;
    this.routesLayer = null;
    this.kartsLayer = null;
    this.roadsLayer = null;
    this.footpathsLayer = null;
    this.boundaryLayer = null;
    this.outsideMaskLayer = null;
    this.userLocationMarker = null;
    this.locationWatchId = null;
    this.currentUserCoords = null;
    this.currentTheme = "light";
    this.currentLayerMode = "satellite";
    this.showRoads = true;
    this.showFootpaths = true;
    this.showBoundary = true;
  }

  init() {
    // Exact original LPU Boundary bounds
    const lpuBounds = (typeof LPU_BOUNDARY !== "undefined" && Array.isArray(LPU_BOUNDARY) && LPU_BOUNDARY.length > 0)
      ? L.latLngBounds(LPU_BOUNDARY)
      : L.latLngBounds([[31.2450, 75.6970], [31.2620, 75.7100]]);

    // Initialize Leaflet Map: Free campus movement when zooming, locked from seeing other cities
    this.map = L.map("map", {
      center: CAMPUS_CENTER,
      zoom: 15.25,
      // minZoom: 14.8,                 // Temporarily disabled for testing outside LPU
      maxZoom: 19.5,                   // Deep building & block zoom
      // maxBounds: lpuBounds.pad(2.0), // Temporarily disabled for testing outside LPU
      // maxBoundsViscosity: 0.3,       // Temporarily disabled with maxBounds
      zoomSnap: 0.25,                  // Smooth fractional zooming
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 100,
      inertia: true,
      inertiaDeceleration: 3000,
      zoomControl: false,
      attributionControl: false
    });

    // Initial comfortable framing
    this.map.fitBounds(lpuBounds.pad(0.12), { 
      paddingTopLeft: [70, 70],
      paddingBottomRight: [390, 70]
    });

    // 1. Google Maps Satellite
    this.tileLayers.satellite = L.tileLayer(
      "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      { maxZoom: 22, attribution: "© Google" }
    );

    // 2. Clean Street Vector Style (CartoDB Positron)
    this.tileLayers.street = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      { maxZoom: 19, subdomains: "abcd" }
    );

    // Set default base layer to Satellite Imagery
    this.setBaseLayer("satellite");

    // Initialize Layer Groups
    this.roadsLayer = L.layerGroup().addTo(this.map);
    this.footpathsLayer = L.layerGroup().addTo(this.map);
    this.markersLayer = L.layerGroup().addTo(this.map);
    this.routesLayer = L.layerGroup().addTo(this.map);
    this.kartsLayer = L.layerGroup().addTo(this.map);

    // Render Original LPU Campus Boundary (Solid Blue) & Outside Dimming Mask
    this.renderCampusBoundary();

    // Directly start live GPS location tracking on opening (no random/hardcoded point)
    this.startLocationTracking();

    // Render Campus Road & Footpath Network from local cached dataset
    this.renderCampusRoadNetwork();

    // Dynamic Zoom Level Adjustment to prevent road congestion when zooming out
    this.map.on('zoomend', () => {
      this.renderCampusRoadNetwork();
    });

    // Render Campus Locations
    this.renderLocationMarkers();

    return this;
  }

  setBaseLayer(layerName) {
    if (this.currentTileLayer) {
      this.map.removeLayer(this.currentTileLayer);
    }
    if (this.tileLayers[layerName]) {
      this.currentLayerMode = layerName;
      this.currentTileLayer = this.tileLayers[layerName];
      this.currentTileLayer.addTo(this.map);
      // Re-apply mode-specific outside mask contrast
      this.renderCampusBoundary();
    }
  }

  renderCampusBoundary() {
    if (typeof LPU_BOUNDARY !== "undefined" && Array.isArray(LPU_BOUNDARY) && LPU_BOUNDARY.length > 0) {
      if (this.boundaryLayer) this.map.removeLayer(this.boundaryLayer);
      if (this.outsideMaskLayer) this.map.removeLayer(this.outsideMaskLayer);

      const maskColor = CAMPUS_STYLE_CONFIG.outsideDimMask || "#020617";
      const maskOpacity = (typeof CAMPUS_STYLE_CONFIG.outsideDimOpacity !== "undefined")
        ? CAMPUS_STYLE_CONFIG.outsideDimOpacity
        : (this.currentLayerMode === "satellite" ? 0.35 : 0.20);

      // 1. Inverted Polygon Mask: Always remains active to dim/blur the outside region
      const worldBounds = [
        [90, -180],
        [90, 180],
        [-90, 180],
        [-90, -180]
      ];

      this.outsideMaskLayer = L.polygon([worldBounds, LPU_BOUNDARY], {
        className: "lpu-outside-mask-layer",
        color: "transparent",
        fillColor: maskColor,
        fillOpacity: maskOpacity,
        interactive: false
      }).addTo(this.map);

      // 2. Solid Perimeter Boundary Line: Only added when checkbox is ON
      if (this.showBoundary) {
        this.boundaryLayer = L.polygon(LPU_BOUNDARY, {
          className: "lpu-boundary-perimeter",
          color: CAMPUS_STYLE_CONFIG.boundaryLine,
          weight: 3.5,
          opacity: CAMPUS_STYLE_CONFIG.boundaryOpacity,
          fillColor: "#3b82f6",
          fillOpacity: 0.02
        }).addTo(this.map);
      }
    }
  }

  renderUserLocation(coords) {
    if (this.userLocationMarker) {
      this.userLocationMarker.setLatLng(coords);
      return;
    }

    const iconHtml = `
      <div class="user-location-marker">
        <div class="user-location-pulse"></div>
        <div class="user-location-dot"></div>
      </div>
    `;

    const userIcon = L.divIcon({
      className: "user-loc-div-icon",
      html: iconHtml,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    this.userLocationMarker = L.marker(coords, { icon: userIcon, zIndexOffset: 2000 }).addTo(this.map);
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
    if (!this.roadsLayer || !this.footpathsLayer) return;
    this.roadsLayer.clearLayers();
    this.footpathsLayer.clearLayers();

    if (typeof CAMPUS_ROADS_DATA === "undefined" || !Array.isArray(CAMPUS_ROADS_DATA) || CAMPUS_ROADS_DATA.length === 0) {
      return;
    }

    const zoom = this.map ? this.map.getZoom() : 16;
    const isFootpath = (hw) => hw === 'footway' || hw === 'path' || hw === 'steps' || hw === 'pedestrian' || hw === 'track';

    // DYNAMIC ZOOM-DEPENDENT STROKE WEIGHTS (prevents congestion when zooming out)
    let roadCasingWeight, roadCoreWeight, dividerWeight, footpathCasingWeight, footpathCoreWeight;
    let showDividers = false;
    let showArrows = false;

    if (zoom >= 18) {
      roadCasingWeight = 16;
      roadCoreWeight = 12;
      dividerWeight = 2;
      footpathCasingWeight = 6;
      footpathCoreWeight = 4;
      showDividers = true;
      showArrows = true;
    } else if (zoom >= 17) {
      roadCasingWeight = 12;
      roadCoreWeight = 8.5;
      dividerWeight = 1.5;
      footpathCasingWeight = 5;
      footpathCoreWeight = 3;
      showDividers = true;
      showArrows = true;
    } else if (zoom >= 16) {
      roadCasingWeight = 7;
      roadCoreWeight = 4.5;
      dividerWeight = 1;
      footpathCasingWeight = 3.5;
      footpathCoreWeight = 2;
      showDividers = false;
      showArrows = false;
    } else {
      // Zoom <= 15 (Overview mode: ultra clean, uncluttered lines)
      roadCasingWeight = 3.5;
      roadCoreWeight = 2.2;
      footpathCasingWeight = 2;
      footpathCoreWeight = 1.4;
      showDividers = false;
      showArrows = false;
    }

    CAMPUS_ROADS_DATA.forEach(way => {
      const highway = (way.tags && way.tags.highway) || 'road';
      const coords = way.coords;

      if (!coords || coords.length < 2) return;

      if (isFootpath(highway)) {
        // ====================================================================
        // FOOTPATH: Orange Terracotta with White Edge Borders (Like Reference)
        // ====================================================================
        if (!this.showFootpaths) return;

        if (zoom >= 16) {
          // White outer casing/border
          L.polyline(coords, {
            color: CAMPUS_STYLE_CONFIG.footpathCasing,
            weight: footpathCasingWeight,
            opacity: CAMPUS_STYLE_CONFIG.footpathCasingOpacity,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: 1.2
          }).addTo(this.footpathsLayer);
        }

        // Terracotta orange path core
        L.polyline(coords, {
          color: CAMPUS_STYLE_CONFIG.footpathCore,
          weight: footpathCoreWeight,
          opacity: CAMPUS_STYLE_CONFIG.footpathOpacity,
          lineCap: 'round',
          lineJoin: 'round',
          smoothFactor: 1.2
        }).bindPopup(`<b>Footpath / Walkway</b>`).addTo(this.footpathsLayer);

      } else {
        // ====================================================================
        // VEHICLE ROAD: Asphalt Dark Core + White Edges + Center Line + Arrows
        // ====================================================================
        if (!this.showRoads) return;

        if (zoom >= 16) {
          // 1. Solid White Outer Edge Casing
          L.polyline(coords, {
            color: CAMPUS_STYLE_CONFIG.roadCasing,
            weight: roadCasingWeight,
            opacity: CAMPUS_STYLE_CONFIG.roadCasingOpacity,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: 1.2
          }).addTo(this.roadsLayer);

          // 2. Dark Asphalt Road Surface Core
          const roadLine = L.polyline(coords, {
            color: CAMPUS_STYLE_CONFIG.roadCore,
            weight: roadCoreWeight,
            opacity: CAMPUS_STYLE_CONFIG.roadOpacity,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: 1.2
          }).bindPopup(`<b>Road:</b> ${way.tags?.name || highway}`).addTo(this.roadsLayer);

          // 3. Dashed White Center Lane Divider
          if (showDividers) {
            L.polyline(coords, {
              color: CAMPUS_STYLE_CONFIG.roadDivider,
              weight: dividerWeight,
              dashArray: '5, 8',
              opacity: 0.9,
              lineCap: 'butt',
              smoothFactor: 1.2
            }).addTo(this.roadsLayer);
          }

          // 4. White Direction Arrows on Oneway Roads
          const isOneWay = way.tags && (way.tags.oneway === 'yes' || way.tags.oneway === '1' || way.tags.junction === 'roundabout');
          if (showArrows && isOneWay && typeof L.polylineDecorator !== 'undefined') {
            try {
              L.polylineDecorator(roadLine, {
                patterns: [
                  {
                    offset: 35,
                    repeat: 120,
                    symbol: L.Symbol.arrowHead({
                      pixelSize: 7,
                      polygon: false,
                      pathOptions: {
                        stroke: true,
                        color: CAMPUS_STYLE_CONFIG.roadArrow,
                        weight: 1.6,
                        opacity: 0.95
                      }
                    })
                  }
                ]
              }).addTo(this.roadsLayer);
            } catch (e) {
              // fallback gracefully
            }
          }
        } else {
          // Zoom <= 15 (Overview mode: clean slim line)
          L.polyline(coords, {
            color: CAMPUS_STYLE_CONFIG.roadCasing,
            weight: roadCasingWeight,
            opacity: CAMPUS_STYLE_CONFIG.roadCasingOpacity,
            smoothFactor: 1.2
          }).addTo(this.roadsLayer);

          L.polyline(coords, {
            color: CAMPUS_STYLE_CONFIG.roadCore,
            weight: roadCoreWeight,
            opacity: CAMPUS_STYLE_CONFIG.roadOpacity,
            smoothFactor: 1.2
          }).bindPopup(`<b>Road:</b> ${way.tags?.name || highway}`).addTo(this.roadsLayer);
        }
      }
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

  renderLocationMarkers(filterCategory = "all") {
    this.markersLayer.clearLayers();

    if (!Array.isArray(CAMPUS_LOCATIONS) || CAMPUS_LOCATIONS.length === 0) return;

    // Filter only locations strictly within LPU campus boundary
    const lpuOnly = CAMPUS_LOCATIONS.filter(loc => isPointInPolygon([loc.lat, loc.lng], LPU_BOUNDARY));

    const filtered = filterCategory === "all"
      ? lpuOnly
      : lpuOnly.filter(loc => loc.category === filterCategory);

    filtered.forEach(loc => {
      let iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
      let pinClass = `pin-${loc.category}`;

      if (loc.category === "food") {
        iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>`;
      } else if (loc.category === "academics") {
        iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
      } else if (loc.category === "hostels") {
        iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
      }

      const customHtml = `
        <div class="custom-campus-pin ${pinClass}" data-id="${loc.id}">
          <div class="pin-icon">${iconSvg}</div>
          <span class="pin-label">${loc.name}</span>
        </div>
      `;

      const pinIcon = L.divIcon({
        className: "campus-pin-wrapper",
        html: customHtml,
        iconSize: [120, 36],
        iconAnchor: [60, 36]
      });

      const marker = L.marker([loc.lat, loc.lng], { icon: pinIcon });
      marker.on("click", () => {
        if (window.UIController) {
          window.UIController.showLocationDetails(loc);
        }
      });

      this.markersLayer.addLayer(marker);
    });
  }

  drawRoute(pathCoords, isDetour = false, closedPathCoords = null) {
    this.routesLayer.clearLayers();

    // STRICT CHECK: Filter only coordinates that are inside LPU boundary
    const validPath = pathCoords.filter(pt => isPointInPolygon(pt, LPU_BOUNDARY));
    if (validPath.length < 2) return;

    // If there is a closed / maintenance path (Panel 6)
    if (closedPathCoords && closedPathCoords.length > 0) {
      const validClosed = closedPathCoords.filter(pt => isPointInPolygon(pt, LPU_BOUNDARY));
      if (validClosed.length >= 2) {
        L.polyline(validClosed, {
          color: "#ef4444",
          weight: 5,
          opacity: 0.8,
          dashArray: "8, 8",
          lineCap: "round"
        }).addTo(this.routesLayer);
      }
    }

    // Recommended Main Route
    const routeLine = L.polyline(validPath, {
      color: "#2563eb",
      weight: 6,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round"
    }).addTo(this.routesLayer);

    // Destination Pin
    const destCoords = validPath[validPath.length - 1];
    const destIconHtml = `
      <div class="destination-marker-pin">
        <div class="dest-pin-badge">Destination</div>
        <div class="dest-pin-circle">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
        </div>
      </div>
    `;

    const destIcon = L.divIcon({
      className: "dest-icon-div",
      html: destIconHtml,
      iconSize: [80, 50],
      iconAnchor: [40, 50]
    });

    L.marker(destCoords, { icon: destIcon }).addTo(this.routesLayer);

    // Fit map bounds strictly within LPU bounds
    this.map.fitBounds(routeLine.getBounds(), { padding: [100, 100], maxZoom: 17 });
  }

  clearRoutes() {
    this.routesLayer.clearLayers();
  }

  flyToLocation(lat, lng, zoom = 17) {
    // Temporarily allow testing locations outside the LPU boundary.
    // if (!isPointInPolygon([lat, lng], LPU_BOUNDARY)) return;
    this.map.flyTo([lat, lng], zoom, {
      animate: true,
      duration: 1.2
    });
  }

  locateUser() {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
    }

    if (this.currentUserCoords && this.map) {
      this.map.flyTo(this.currentUserCoords, 17, {
        animate: true,
        duration: 1.2
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        this.currentUserCoords = [lat, lng];

        this.renderUserLocation([lat, lng]);

        if (this.map) {
          this.map.flyTo([lat, lng], 17, {
            animate: true,
            duration: 1.2
          });
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
    const isAssistantOpen = !document.body.classList.contains("assistant-collapsed") && window.innerWidth > 768;
    if (typeof LPU_BOUNDARY !== "undefined" && Array.isArray(LPU_BOUNDARY) && LPU_BOUNDARY.length > 0) {
      const bounds = L.latLngBounds(LPU_BOUNDARY);
      this.map.fitBounds(bounds.pad(0.12), {
        paddingTopLeft: [70, 70],
        paddingBottomRight: [isAssistantOpen ? 390 : 70, 70],
        animate: true,
        duration: 1
      });
    } else {
      this.map.flyTo(CAMPUS_CENTER, 15.5, { animate: true, duration: 1 });
    }
  }

  zoomIn() {
    this.map.zoomIn();
  }

  zoomOut() {
    this.map.zoomOut();
  }
}

// Instantiate global Map Controller
window.CampusMap = new CampusMapController();
