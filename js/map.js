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
    this.overlayRenderFrame = null;
    this.mapResizeObserver = null;
    this.revealedLocationIds = new Set();
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
      attributionControl: false,
      rotate: true,
      touchRotate: true,
      rotateControl: false
    });

    // Initial comfortable framing
    const isMobile = window.innerWidth <= 768;
    this.map.fitBounds(lpuBounds.pad(isMobile ? 0.04 : 0.12), { 
      paddingTopLeft: isMobile ? [95, 10] : [70, 70],
      paddingBottomRight: isMobile ? [10, 85] : [390, 70]
    });

    // 1. Clean OpenStreetMap Standard Tile Layer (Guaranteed universal availability)
    this.tileLayers.street = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, subdomains: "abc", attribution: "© OpenStreetMap contributors" }
    );

    // 2. Google Maps Satellite
    this.tileLayers.satellite = L.tileLayer(
      "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      { maxZoom: 20, attribution: "© Google" }
    );

    // 3. CartoDB Positron
    this.tileLayers.carto = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      { maxZoom: 19, subdomains: "abcd" }
    );

    // Set default base layer (street fallback or satellite)
    this.setBaseLayer("satellite");

    // Create Dedicated Panes to strictly guarantee Z-Index ordering on zoom
    this.map.createPane('roadsPane');
    this.map.getPane('roadsPane').style.zIndex = 410;

    this.map.createPane('footpathsPane');
    this.map.getPane('footpathsPane').style.zIndex = 420;

    this.map.createPane('routesHaloPane');
    this.map.getPane('routesHaloPane').style.zIndex = 510;

    this.map.createPane('routesPane');
    this.map.getPane('routesPane').style.zIndex = 520;

    // Initialize Layer Groups
    this.roadsLayer = L.layerGroup().addTo(this.map);
    this.footpathsLayer = L.layerGroup().addTo(this.map);
    this.markersLayer = L.layerGroup().addTo(this.map);
    this.routesLayer = L.layerGroup().addTo(this.map);
    this.kartsLayer = L.layerGroup().addTo(this.map);

    // Render Campus Perimeter Boundary
    this.renderCampusBoundary();

    // Start Location Tracking
    this.startLocationTracking();

    // Render Campus Road & Footpath Network from local cached dataset
    this.renderCampusRoadNetwork();

    const scheduleRoadRender = () => {
      if (this.overlayRenderFrame !== null) return;
      this.overlayRenderFrame = requestAnimationFrame(() => {
        this.overlayRenderFrame = null;
        this.renderCampusRoadNetwork();
        if (this.boundaryLayer && this.boundaryLayer.redraw) this.boundaryLayer.redraw();
      });
    };
    this.map.on('zoom', () => {
      scheduleRoadRender();
      this.updateMarkerLabelVisibility();
    });
    this.map.on('zoomend', () => {
      scheduleRoadRender();
      this.updateMarkerLabelVisibility();
      this.renderLocationMarkers();
    });

    const refreshMapSize = () => {
      if (this.map) {
        requestAnimationFrame(() => this.map.invalidateSize({ pan: false }));
      }
    };
    this.mapResizeObserver = new ResizeObserver(refreshMapSize);
    const mapEl = document.getElementById('map');
    if (mapEl) this.mapResizeObserver.observe(mapEl);
    window.addEventListener('orientationchange', refreshMapSize);
    window.addEventListener('resize', refreshMapSize);

    // Immediate and delayed resize invalidation to ensure map is visible instantly
    setTimeout(() => {
      if (this.map) this.map.invalidateSize({ pan: false });
    }, 100);
    setTimeout(() => {
      if (this.map) this.map.invalidateSize({ pan: false });
    }, 500);

    // Render Campus Locations
    this.renderLocationMarkers();

    return this;
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
    if (this.currentTileLayer && this.map.hasLayer(this.currentTileLayer)) {
      this.map.removeLayer(this.currentTileLayer);
    }
    const targetLayer = this.tileLayers[layerName] || this.tileLayers.street;
    if (targetLayer) {
      this.currentLayerMode = layerName;
      this.currentTileLayer = targetLayer;
      this.currentTileLayer.addTo(this.map);
    }
  }

  renderCampusBoundary() {
    if (typeof LPU_BOUNDARY !== "undefined" && Array.isArray(LPU_BOUNDARY) && LPU_BOUNDARY.length > 0) {
      if (this.boundaryLayer && this.map.hasLayer(this.boundaryLayer)) {
        this.map.removeLayer(this.boundaryLayer);
      }
      if (this.outsideMaskLayer && this.map.hasLayer(this.outsideMaskLayer)) {
        this.map.removeLayer(this.outsideMaskLayer);
      }

      // Solid Perimeter Boundary Line
      if (this.showBoundary) {
        this.boundaryLayer = L.polygon(LPU_BOUNDARY, {
          className: "lpu-boundary-perimeter",
          color: CAMPUS_STYLE_CONFIG.boundaryLine || "#3b82f6",
          weight: 3.5,
          opacity: 0.9,
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
            pane: 'footpathsPane',
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
          pane: 'footpathsPane',
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
            pane: 'roadsPane',
            color: CAMPUS_STYLE_CONFIG.roadCasing,
            weight: roadCasingWeight,
            opacity: CAMPUS_STYLE_CONFIG.roadCasingOpacity,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: 1.2
          }).addTo(this.roadsLayer);

          // 2. Dark Asphalt Road Surface Core
          const roadLine = L.polyline(coords, {
            pane: 'roadsPane',
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
              pane: 'roadsPane',
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
                        pane: 'roadsPane',
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
            pane: 'roadsPane',
            color: CAMPUS_STYLE_CONFIG.roadCasing,
            weight: roadCasingWeight,
            opacity: CAMPUS_STYLE_CONFIG.roadCasingOpacity,
            smoothFactor: 1.2
          }).addTo(this.roadsLayer);

          L.polyline(coords, {
            pane: 'roadsPane',
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
    if (!this.markersLayer) return;
    this.markersLayer.clearLayers();

    const allLocations = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (window.CAMPUS_LOCATIONS || []);
    if (!Array.isArray(allLocations) || allLocations.length === 0) return;

    let currentZoom = 16;
    let bounds = null;
    try {
      if (this.map) {
        currentZoom = this.map.getZoom();
        bounds = this.map.getBounds();
      }
    } catch (e) {}

    // Filter locations strictly within LPU campus boundary
    const lpuOnly = allLocations.filter(loc => {
      if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return false;
      const isInCampus = isPointInPolygon([loc.lat, loc.lng], LPU_BOUNDARY);
      const isRevealed = this.revealedLocationIds.has(loc.id);
      let isVisibleAtZoom = true;
      if (loc.visibleFromZoom) {
        isVisibleAtZoom = isRevealed || (
          currentZoom >= loc.visibleFromZoom &&
          (!bounds || (bounds.getWest() <= loc.lng && loc.lng <= bounds.getEast() && bounds.getSouth() <= loc.lat && loc.lat <= bounds.getNorth()))
        );
      }
      return isInCampus && isVisibleAtZoom;
    });

    const filtered = filterCategory === "all"
      ? lpuOnly
      : lpuOnly.filter(loc => loc.category === filterCategory);

    filtered.forEach(loc => {
      let iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
      let pinClass = `pin-${loc.category || 'others'}`;

      if (loc.category === "food") {
        iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>`;
      } else if (loc.category === "academics") {
        iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
      } else if (loc.category === "hostels") {
        iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
      } else if (loc.category === "parking") {
        iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/></svg>`;
      } else if (loc.category === "offices") {
        iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>`;
      } else if (loc.category === "healthcare") {
        iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M2 12h20"/></svg>`;
      }

      const customHtml = `
        <div class="custom-campus-pin ${pinClass}" data-id="${loc.id}" title="${loc.name}">
          <div class="pin-circle">
            <div class="pin-icon">${iconSvg}</div>
          </div>
          <span class="pin-label">${loc.name}</span>
        </div>
      `;

      const pinIcon = L.divIcon({
        className: "campus-pin-wrapper",
        html: customHtml,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      });

      const marker = L.marker([loc.lat, loc.lng], { icon: pinIcon });
      marker.on("click", () => {
        if (window.UIController) {
          window.UIController.showLocationDetails(loc);
        }
      });

      this.markersLayer.addLayer(marker);
    });

    this.updateMarkerLabelVisibility();
  }

  revealLocation(locationId) {
    this.revealedLocationIds.add(locationId);
    this.renderLocationMarkers();
  }

  clearRevealedLocations() {
    if (this.revealedLocationIds.size === 0) return;
    this.revealedLocationIds.clear();
    this.renderLocationMarkers();
  }

  drawRoute(pathCoords, isDetour = false, closedPathCoords = null, options = {}) {
    this.routesLayer.clearLayers();

    if (!Array.isArray(pathCoords) || pathCoords.length < 2) return;

    // Filter valid coordinates
    const validPath = pathCoords.filter(pt => Array.isArray(pt) && pt.length >= 2 && typeof pt[0] === 'number' && typeof pt[1] === 'number');
    if (validPath.length < 2) return;

    this.currentRouteData = { pathCoords: validPath, isDetour, closedPathCoords, options };

    const mode = options.mode || (window.Directions ? window.Directions.currentMode : 'walking');
    const originName = options.originName || (window.Directions ? window.Directions.currentOrigin : 'Start Location');
    const destName = options.destName || (window.Directions ? window.Directions.currentDestination : 'Destination');
    const skipFitBounds = options.skipFitBounds === true;

    // Dynamic mode styling colors
    let dotColor = "#2563eb"; // Walking: electric blue
    let glowColor = "#3b82f6";
    if (mode === "bicycle") {
      dotColor = "#059669"; // Bicycle: emerald
      glowColor = "#10b981";
    } else if (mode === "kart") {
      dotColor = "#d97706"; // Kart: amber / gold
      glowColor = "#f59e0b";
    }

    // 1. Closed / Construction / Detour Path (if detour mode)
    if (closedPathCoords && closedPathCoords.length > 0) {
      const validClosed = closedPathCoords.filter(pt => Array.isArray(pt) && pt.length >= 2);
      if (validClosed.length >= 2) {
        L.polyline(validClosed, {
          pane: 'routesPane',
          className: "route-closed-line",
          color: "#ef4444",
          weight: 5,
          opacity: 0.85,
          dashArray: "6, 8",
          lineCap: "round"
        }).addTo(this.routesLayer);
      }
    }

    // 2. Glowing Route Underlay Halo (placed in routesHaloPane with z-index 510)
    L.polyline(validPath, {
      pane: 'routesHaloPane',
      className: "route-halo-underlay",
      color: glowColor,
      weight: 16,
      opacity: 0.35,
      lineCap: "round",
      lineJoin: "round"
    }).addTo(this.routesLayer);

    // 3. Main DOT FORMAT Route Path (placed in routesPane with z-index 520, ALWAYS on top)
    const routeDotLine = L.polyline(validPath, {
      pane: 'routesPane',
      className: "route-dot-path",
      color: dotColor,
      weight: 9,
      opacity: 1.0,
      dashArray: "0, 18",
      lineCap: "round",
      lineJoin: "round"
    }).addTo(this.routesLayer);

    // 4. Intermediate Waypoint Dots at turn points
    if (validPath.length > 3) {
      const stepInterval = Math.max(1, Math.floor(validPath.length / 6));
      for (let i = stepInterval; i < validPath.length - 1; i += stepInterval) {
        const wp = validPath[i];
        const wpIcon = L.divIcon({
          className: "waypoint-dot-wrapper",
          html: `<div class="waypoint-route-dot" style="background:${dotColor};"></div>`,
          iconSize: [8, 8],
          iconAnchor: [4, 4]
        });
        L.marker(wp, { icon: wpIcon, interactive: false, zIndexOffset: 1200 }).addTo(this.routesLayer);
      }
    }

    // 5. Origin / Start Location Marker (Pulsing Green Dot Pin - Zero-Drift Anchor)
    const startCoords = validPath[0];
    const startIconHtml = `
      <div class="start-marker-pin">
        <div class="start-pin-tag">${originName}</div>
        <div class="start-pin-pulse" style="border-color:${dotColor};"></div>
        <div class="start-pin-dot">
          <div class="start-pin-inner"></div>
        </div>
      </div>
    `;
    const startIcon = L.divIcon({
      className: "start-icon-div",
      html: startIconHtml,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
    L.marker(startCoords, { icon: startIcon, zIndexOffset: 2500 }).addTo(this.routesLayer);

    // 6. Destination Target Pin (Red Drop Pin with Destination Tag - Zero-Drift Bottom Tip Anchor)
    const destCoords = validPath[validPath.length - 1];
    const destIconHtml = `
      <div class="destination-marker-pin">
        <div class="dest-pin-badge">${destName}</div>
        <div class="dest-pin-svg-wrap">
          <svg class="dest-pin-svg" width="30" height="40" viewBox="0 0 30 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 0C6.71573 0 0 6.71573 0 15C0 26.25 15 40 15 40C15 40 30 26.25 30 15C30 6.71573 23.2843 0 15 0Z" fill="#EF4444"/>
            <path d="M15 0C6.71573 0 0 6.71573 0 15C0 26.25 15 40 15 40C15 40 30 26.25 30 15C30 6.71573 23.2843 0 15 0Z" stroke="#B91C1C" stroke-width="1.5"/>
            <circle cx="15" cy="15" r="5" fill="#FFFFFF"/>
          </svg>
        </div>
      </div>
    `;
    const destIcon = L.divIcon({
      className: "dest-icon-div",
      html: destIconHtml,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
    L.marker(destCoords, { icon: destIcon, zIndexOffset: 3000 }).addTo(this.routesLayer);

    // 7. Auto-fit map bounds smoothly (only on first calculation)
    if (!skipFitBounds) {
      try {
        this.map.fitBounds(routeDotLine.getBounds(), {
          padding: [80, 80],
          maxZoom: 17.5,
          animate: true
        });
      } catch (e) {
        console.warn("Could not fit route bounds:", e);
      }
    }
  }

  clearRoutes() {
    this.currentRouteData = null;
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
    const isMobile = window.innerWidth <= 768;
    const isAssistantOpen = !document.body.classList.contains("assistant-collapsed") && !isMobile;
    if (typeof LPU_BOUNDARY !== "undefined" && Array.isArray(LPU_BOUNDARY) && LPU_BOUNDARY.length > 0) {
      const bounds = L.latLngBounds(LPU_BOUNDARY);
      this.map.fitBounds(bounds.pad(isMobile ? 0.04 : 0.12), {
        paddingTopLeft: isMobile ? [95, 10] : [70, 70],
        paddingBottomRight: isMobile ? [10, 85] : [isAssistantOpen ? 390 : 70, 70],
        animate: true,
        duration: 1
      });
    } else {
      this.map.flyTo(CAMPUS_CENTER, isMobile ? 15.8 : 15.5, { animate: true, duration: 1 });
    }
  }

  zoomIn() {
    this.map.zoomIn();
  }

  zoomOut() {
    this.map.zoomOut();
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
