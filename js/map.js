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
  roadCore: '#414b69ff',          // Slightly lighter asphalt surface
  roadOpacity: 0.98,
  roadDivider: '#ffffff',       // Center dashed lane divider
  roadArrow: '#4c4c4cff',         // Directional arrowheads

  // Footpaths & Walkways
  footpathCore: '#c7cccf',      // Light gray brick paving surface
  footpathOpacity: 1,
  footpathCasing: '#626a70',    // Defined outer edge around the brick paving
  footpathCasingOpacity: 0.96,

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

// ============================================================================
// 🛠️ LEAFLET 1.9.4 & LEAFLET-ROTATE HARDWARE ACCELERATION COMPATIBILITY PATCH
// Ensures SVG and Canvas renderers receive dynamic CSS rotation & zoom transforms simultaneously
// ============================================================================
if (typeof L !== 'undefined' && L.Renderer) {
  L.Renderer.addInitHook(function () {
    this.on('add', function () {
      if (this._container) {
        this._container.classList.add('leaflet-zoom-animated');
        this._container.style.transformOrigin = '0 0';
      }
    });
  });
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
    this.selectedLocationId = null;
    this.currentFilterCategory = "all";
    this.initialCenter = null;
    this.initialZoom = null;
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
      maxZoom: 19.5,
      zoomSnap: 0.25,                  // Crisp fractional zooming matching web view
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 100,
      inertia: true,
      inertiaDeceleration: 3000,
      zoomControl: false,
      attributionControl: false,
      rotate: true,
      touchRotate: false,              // Disables accidental gesture rotation skewing mobile pinch-zoom
      rotateControl: false
    });

    // Initial comfortable framing
    const isMobile = window.innerWidth <= 768;
    this.map.fitBounds(lpuBounds.pad(isMobile ? 0.04 : 0.12), { 
      paddingTopLeft: isMobile ? [95, 10] : [70, 70],
      paddingBottomRight: isMobile ? [10, 85] : [70, 70]
    });

    // Store exact initial center coordinates and zoom level captured on fresh page load
    const initialPos = this.map.getCenter();
    this.initialCenter = [initialPos.lat, initialPos.lng];
    this.initialZoom = this.map.getZoom();

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

    // Set default base layer (Google Maps Satellite)
    this.setBaseLayer("satellite");

    // Dedicated Navigation Route Pane with z-index 580 (strictly above roads/footpaths in overlayPane 400)
    if (!this.map.getPane('routePane')) {
      const rp = this.map.createPane('routePane');
      rp.style.zIndex = '580';
      rp.style.pointerEvents = 'none';
    }

    // Keep both network layers above other campus overlays; roads must paint above walkways.
    if (!this.map.getPane('footpathPane')) {
      const fp = this.map.createPane('footpathPane');
      fp.style.zIndex = '410';
    }
    this.footpathRenderer = L.svg({ pane: 'footpathPane' }).addTo(this.map);
    if (!this.map.getPane('roadPane')) {
      const rp = this.map.createPane('roadPane');
      rp.style.zIndex = '420';
    }
    this.roadRenderer = L.svg({ pane: 'roadPane' }).addTo(this.map);

    // POI icons and their text labels must stay above both network panes.
    if (!this.map.getPane('locationMarkerPane')) {
      const lp = this.map.createPane('locationMarkerPane');
      lp.style.zIndex = '640';
    }

    // Explicit panes also keep both networks above boundary/area overlays in overlayPane.
    this.footpathsLayer = L.layerGroup().addTo(this.map);
    this.roadsLayer = L.layerGroup().addTo(this.map);
    this.routesLayer = L.layerGroup([], { pane: 'routePane' }).addTo(this.map);
    this.markersLayer = L.layerGroup().addTo(this.map);
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

    this.map.on('zoomstart', () => {
      if (this.overlayRenderFrame !== null) {
        cancelAnimationFrame(this.overlayRenderFrame);
        this.overlayRenderFrame = null;
      }
    });

    this.map.on('zoom', () => {
      this.updateMarkerLabelVisibility();
    });
    this.map.on('zoomend', () => {
      scheduleRoadRender();
      this.updateMarkerLabelVisibility();
      this.renderLocationMarkers(this.currentFilterCategory || "all");
    });
    this.map.on('moveend', () => {
      this.updateMarkerLabelVisibility();
      this.renderLocationMarkers(this.currentFilterCategory || "all");
    });
    this.map.on('rotateend', () => {
      if (this.boundaryLayer && this.boundaryLayer.redraw) this.boundaryLayer.redraw();
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
    const targetLayer = this.tileLayers[layerName] || this.tileLayers.satellite;
    if (targetLayer) {
      this.currentLayerMode = layerName;
      this.currentTileLayer = targetLayer;
      this.currentTileLayer.addTo(this.map);
    }
  }

  getFootpathTextureAngle(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return 0;

    let axisX = 0;
    let axisY = 0;
    for (let index = 1; index < coords.length; index += 1) {
      const start = coords[index - 1];
      const end = coords[index];
      const meanLat = ((start[0] + end[0]) / 2) * Math.PI / 180;
      const dx = (end[1] - start[1]) * Math.cos(meanLat);
      const dy = -(end[0] - start[0]);
      const length = Math.hypot(dx, dy);
      if (length < 1e-12) continue;

      const angle = Math.atan2(dy, dx);
      axisX += length * Math.cos(2 * angle);
      axisY += length * Math.sin(2 * angle);
    }

    return Math.atan2(axisY, axisX) * 90 / Math.PI;
  }

  ensureFootpathBrickPattern(renderer, patternId, angle, anchor) {
    const svg = renderer && renderer._container;
    if (!svg || typeof svg.querySelector !== 'function') return false;

    const transform = `translate(${anchor.x} ${anchor.y}) rotate(${angle})`;
    const existingPattern = svg.querySelector(`#${patternId}`);
    if (existingPattern) {
      existingPattern.setAttribute('patternTransform', transform);
      return true;
    }

    const svgNs = 'http://www.w3.org/2000/svg';
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(svgNs, 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }

    const pattern = document.createElementNS(svgNs, 'pattern');
    pattern.setAttribute('id', patternId);
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('width', '72');
    pattern.setAttribute('height', '72');
    pattern.setAttribute('patternTransform', transform);

    const textureImage = document.createElementNS(svgNs, 'image');
    textureImage.setAttribute('href', 'assets/footpath-gray-brick-light.png');
    textureImage.setAttribute('x', '0');
    textureImage.setAttribute('y', '0');
    textureImage.setAttribute('width', '72');
    textureImage.setAttribute('height', '72');
    textureImage.setAttribute('preserveAspectRatio', 'none');
    pattern.appendChild(textureImage);
    defs.appendChild(pattern);
    return true;
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

    const roadList = (typeof CAMPUS_ROADS_DATA !== "undefined" && Array.isArray(CAMPUS_ROADS_DATA) && CAMPUS_ROADS_DATA.length > 0)
      ? CAMPUS_ROADS_DATA
      : (typeof LPU_ROAD_NETWORK !== "undefined" && Array.isArray(LPU_ROAD_NETWORK))
        ? LPU_ROAD_NETWORK.map(way => ({
            id: way.id,
            tags: { highway: way.highway, name: way.name || "", oneway: way.oneway || "", junction: way.junction || "" },
            coords: way.geometry,
            areaGeometry: way.area_geometry || null
          }))
        : [];

    if (roadList.length === 0) {
      return;
    }

    const zoom = this.map ? this.map.getZoom() : 16;
    const isFootpath = (hw) => hw === 'footway' || hw === 'path' || hw === 'steps' || hw === 'pedestrian' || hw === 'track' || hw === 'cycleway';

    // DYNAMIC ZOOM-DEPENDENT STROKE WEIGHTS (prevents congestion when zooming out)
    let roadCoreWeight, dividerWeight, footpathCasingWeight, footpathCoreWeight;
    let showDividers = false;
    let showArrows = false;

    if (zoom >= 18) {
      roadCoreWeight = 15;
      dividerWeight = 2.2;
      footpathCasingWeight = 8;
      footpathCoreWeight = 5.5;
      showDividers = true;
      showArrows = true;
    } else if (zoom >= 17) {
      roadCoreWeight = 11;
      dividerWeight = 1.8;
      footpathCasingWeight = 6.5;
      footpathCoreWeight = 4.5;
      showDividers = true;
      showArrows = true;
    } else if (zoom >= 16) {
      roadCoreWeight = 6;
      dividerWeight = 1;
      footpathCasingWeight = 4.8;
      footpathCoreWeight = 3.2;
      showDividers = true;
      showArrows = false;
    } else {
      // Zoom <= 15: keep the network legible in the campus overview.
      roadCoreWeight = 4.2;
      dividerWeight = 1;
      footpathCasingWeight = 4.8;
      footpathCoreWeight = 3.2;
      showDividers = zoom >= 14;
      showArrows = false;
    }

    const footpathAreas = [];
    roadList.forEach(way => {
      const highway = (way.tags && way.tags.highway) || 'road';
      const coords = way.coords;

      if (!coords || coords.length < 2) return;

      if (isFootpath(highway)) {
        // ====================================================================
        // FOOTPATH: render its estimated mapped surface area; preserve line fallback for older data.
        // ====================================================================
        if (!this.showFootpaths) return;

        const areaGeometry = way.areaGeometry || way.area_geometry;
        if (Array.isArray(areaGeometry) && areaGeometry.length >= 4) {
          footpathAreas.push({ way, areaGeometry, coords });
          return;
        }

        // Both layers use identical, unsimplified geometry so their edges stay aligned.
        L.polyline(coords, {
          color: CAMPUS_STYLE_CONFIG.footpathCasing,
          weight: footpathCasingWeight,
          opacity: CAMPUS_STYLE_CONFIG.footpathCasingOpacity,
          lineCap: 'round',
          lineJoin: 'round',
          smoothFactor: 0,
          pane: 'footpathPane',
          renderer: this.footpathRenderer
        }).addTo(this.footpathsLayer);

        // Terracotta orange path core
        L.polyline(coords, {
          color: CAMPUS_STYLE_CONFIG.footpathCore,
          weight: footpathCoreWeight,
          opacity: CAMPUS_STYLE_CONFIG.footpathOpacity,
          lineCap: 'round',
          lineJoin: 'round',
          smoothFactor: 0,
          pane: 'footpathPane',
          renderer: this.footpathRenderer
        }).bindPopup(`<b>Footpath / Walkway</b>`).addTo(this.footpathsLayer);

      } else {
        // ====================================================================
        // VEHICLE ROAD: wide asphalt surface + center line + arrows
        // ====================================================================
        if (!this.showRoads) return;

        if (zoom >= 16) {
          // Draw the asphalt directly; no contrasting outer casing.
          const roadLine = L.polyline(coords, {
            color: CAMPUS_STYLE_CONFIG.roadCore,
            weight: roadCoreWeight,
            opacity: CAMPUS_STYLE_CONFIG.roadOpacity,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: 0,
            pane: 'roadPane',
            renderer: this.roadRenderer
          }).bindPopup(`<b>Road:</b> ${way.tags?.name || highway}`).addTo(this.roadsLayer);

          // 3. Dashed White Center Lane Divider
          if (showDividers) {
            L.polyline(coords, {
              color: CAMPUS_STYLE_CONFIG.roadDivider,
              weight: dividerWeight,
              dashArray: '5, 8',
              opacity: 0.9,
              lineCap: 'butt',
              smoothFactor: 0,
              pane: 'roadPane',
              renderer: this.roadRenderer
            }).addTo(this.roadsLayer);
          }

          // 4. White Direction Arrows on Oneway Roads
          const isOneWay = way.tags && (way.tags.oneway === 'yes' || way.tags.oneway === '1' || way.tags.junction === 'roundabout');
          if (showArrows && isOneWay && typeof L.polylineDecorator !== 'undefined') {
            try {
              L.polylineDecorator(roadLine, {
                pane: 'roadPane',
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
        // Zoomed-out overview: keep roads and lane dashes visible together.
        L.polyline(coords, {
          color: CAMPUS_STYLE_CONFIG.roadCore,
          weight: roadCoreWeight,
          opacity: CAMPUS_STYLE_CONFIG.roadOpacity,
          smoothFactor: 0,
          pane: 'roadPane',
          renderer: this.roadRenderer
        }).bindPopup(`<b>Road:</b> ${way.tags?.name || highway}`).addTo(this.roadsLayer);

        if (showDividers) {
          L.polyline(coords, {
            color: CAMPUS_STYLE_CONFIG.roadDivider,
            weight: dividerWeight,
            dashArray: '4, 7',
            opacity: 0.9,
            lineCap: 'butt',
            smoothFactor: 0,
            pane: 'roadPane',
            renderer: this.roadRenderer
          }).addTo(this.roadsLayer);
        }
      }
    }
    });

    this.renderFootpathAreas(footpathAreas);
  }

  renderFootpathAreas(footpathAreas) {
    if (!Array.isArray(footpathAreas) || footpathAreas.length === 0) return;

    // Put every outline down first. The textured fills drawn afterward cover
    // internal borders wherever paths overlap, leaving a cleaner junction.
    footpathAreas.forEach(({ areaGeometry }) => {
      L.polygon(areaGeometry, {
        color: CAMPUS_STYLE_CONFIG.footpathCasing,
        weight: 2.5,
        opacity: CAMPUS_STYLE_CONFIG.footpathCasingOpacity,
        fill: false,
        interactive: false,
        lineJoin: 'round',
        smoothFactor: 0,
        pane: 'footpathPane',
        renderer: this.footpathRenderer
      }).addTo(this.footpathsLayer);
    });

    footpathAreas.forEach(({ way, areaGeometry, coords }) => {
      const walkwayArea = L.polygon(areaGeometry, {
        stroke: false,
        fillColor: CAMPUS_STYLE_CONFIG.footpathCore,
        fillOpacity: CAMPUS_STYLE_CONFIG.footpathOpacity,
        smoothFactor: 0,
        pane: 'footpathPane',
        renderer: this.footpathRenderer
      }).bindPopup(`<b>Footpath / Walkway</b>`).addTo(this.footpathsLayer);
      const patternId = `lpu-footpath-gray-brick-${way.id}`;
      const textureAngle = this.getFootpathTextureAngle(coords);
      const textureAnchor = this.map.latLngToLayerPoint(coords[0]);
      if (this.ensureFootpathBrickPattern(walkwayArea._renderer, patternId, textureAngle, textureAnchor)) {
        walkwayArea.setStyle({ fillColor: `url(#${patternId})` });
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

  getCategoryIconSvg(category) {
    if (category === "food") {
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>`;
    } else if (category === "academics" || category === "academic") {
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 10v6M2 10l10-5 10 5-10 5z"></path><path d="M6 12v5c3 3 9 3 12 0v-5"></path></svg>`;
    } else if (category === "hostels" || category === "hostel") {
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
    } else if (category === "parking") {
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/></svg>`;
    } else if (category === "offices" || category === "office") {
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>`;
    } else if (category === "healthcare") {
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M2 12h20"/></svg>`;
    }
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
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
      const pt = this.map.latLngToContainerPoint(item.latLng);
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
    if (!this.markersLayer) return;
    this.markersLayer.clearLayers();
    this.currentFilterCategory = filterCategory;

    const allLocations = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (window.CAMPUS_LOCATIONS || []);
    if (!Array.isArray(allLocations) || allLocations.length === 0) return;

    let currentZoom = 15.25;
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

    const cseGroupLocs = filtered.filter(l => isCentralZoneMember(l));
    const otherLocs = filtered.filter(l => !isCentralZoneMember(l));

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
            const nBounds = L.latLngBounds(northBlocks.map(l => [l.lat, l.lng]));
            itemsToRender.push({
              isCluster: true,
              groupId: "cse-dept-north",
              title: "Blocks 25–28 (CSE)",
              fullTitle: "School of CSE (Blocks 25 to 28)",
              count: northBlocks.length,
              category: "academics",
              latLng: [31.25286, 75.70310],
              bounds: nBounds,
              memberLocs: northBlocks,
              priority: 45
            });
          }

          if (southBlocks.length > 0) {
            const sBounds = L.latLngBounds(southBlocks.map(l => [l.lat, l.lng]));
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
          const cseBounds = L.latLngBounds(unrevealedCse.map(l => [l.lat, l.lng]));
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

    // Render other landmarks and non-CSE locations
    otherLocs.forEach(loc => {
      const isSel = this.selectedLocationId === loc.id;
      const isRev = this.revealedLocationIds.has(loc.id);

      // Major landmarks have higher priority
      let priority = 20;
      if (loc.id === "uni-health-center" || loc.id === "sh-baldevraj-mittal-auditorium") {
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

    // Create Leaflet Markers
    resolvedItems.forEach(item => {
      if (item.isCluster) {
        // Render Group Cluster Marker
        const iconSvg = this.getCategoryIconSvg(item.category);
        const clusterHtml = `
          <div class="custom-campus-cluster cluster-${item.category || 'academics'}" data-group-id="${item.groupId}" title="${item.fullTitle} (${item.count} Buildings)">
            <div class="cluster-pill">
              <div class="cluster-icon">${iconSvg}</div>
              <span class="cluster-title">${item.title}</span>
              <span class="cluster-count">${item.count}</span>
            </div>
          </div>
        `;

        const clusterIcon = L.divIcon({
          className: "campus-pin-wrapper",
          html: clusterHtml,
          iconSize: [120, 30],
          iconAnchor: [60, 15]
        });

        const clusterMarker = L.marker(item.latLng, {
          icon: clusterIcon,
          pane: 'locationMarkerPane'
        });

        clusterMarker.on("click", (e) => {
          if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
          if (item.bounds) {
            this.map.flyToBounds(item.bounds.pad(0.22), {
              maxZoom: 17.5,
              duration: 0.85
            });
          } else if (item.latLng) {
            this.map.flyTo(item.latLng, 17.5, {
              duration: 0.85
            });
          }
        });

        this.markersLayer.addLayer(clusterMarker);

      } else {
        // Render Individual Location Marker
        const loc = item.loc;
        const iconSvg = this.getCategoryIconSvg(loc.category);
        const isSelected = item.isSelected;
        const isRevealed = item.isRevealed;
        const hasLabel = Boolean(item.showLabel || isSelected || isRevealed);

        const pinClass = `pin-${loc.category || 'others'} ${hasLabel ? '' : 'pin-icon-only'} ${isSelected ? 'selected' : ''} ${isRevealed ? 'revealed' : ''}`;

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

        const marker = L.marker([loc.lat, loc.lng], {
          icon: pinIcon,
          pane: 'locationMarkerPane',
          zIndexOffset: isSelected || isRevealed ? 1000 : 0
        });

        marker.on("click", (e) => {
          if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
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
    let dotColor = "#1717ecff"; // Walking: electric blue
    let glowColor = "#432399ff";
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
          className: "route-closed-line",
          color: "#ef4444",
          weight: 5,
          opacity: 0.85,
          dashArray: "6, 8",
          lineCap: "round"
        }).addTo(this.routesLayer);
      }
    }

    // Determine effective road polyline coordinates
    const roadCoords = (options.roadPath && Array.isArray(options.roadPath) && options.roadPath.length >= 2)
      ? options.roadPath.filter(pt => Array.isArray(pt) && pt.length >= 2)
      : validPath;

    const isNavigating = options.isNavigating === true;
    const ROUTE_ACCENT_COLOR = '#f97316'; // Brand accent orange preserved for compatibility & kart mode

    // In active navigation: solid bold dark line highlighted like normal Google Maps
    // In preview mode: dotted format with circular beads
    let mainLineColor;
    let mainLineWeight;
    let mainLineDashArray;

    if (isNavigating) {
      // Normal Google Maps style dark active navigation line
      mainLineColor = "#0f172a"; // Deep high-contrast dark slate
      mainLineWeight = 8.5;
      mainLineDashArray = null; // Solid
    } else {
      // Dotted format for route preview
      mainLineColor = (mode === "walking") ? "#1683ff" : "#ff8a00";
      mainLineWeight = 7.5;
      mainLineDashArray = "0.1, 13"; // Round dotted beads
    }

    // Optional alternate route in preview if kart & walk differ
    if (!isNavigating && options.alternateRoute && Array.isArray(options.alternateRoute.path) && options.alternateRoute.path.length >= 2) {
      const altCoords = options.alternateRoute.path.filter(pt => Array.isArray(pt) && pt.length >= 2);
      if (altCoords.length >= 2) {
        L.polyline(altCoords, {
          pane: 'routePane',
          className: "route-alternate-dotted-path",
          color: "#94a3b8",
          weight: 5,
          opacity: 0.75,
          dashArray: "0.1, 13",
          lineCap: "round",
          lineJoin: "round"
        }).addTo(this.routesLayer);
      }
    }

    // Keep a casing for solid active navigation only. A continuous white casing
    // beneath dotted previews makes the route look like dots on a white strip.
    if (isNavigating) {
      L.polyline(roadCoords, {
        pane: 'routePane',
        className: "route-casing-path",
        color: "#ffffff",
        weight: 13,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round"
      }).addTo(this.routesLayer);
    } else {
      // A faint dotted rim adds definition without creating a solid strip.
      L.polyline(roadCoords, {
        pane: 'routePane',
        className: "route-preview-dot-rim",
        color: mode === "walking" ? "#123c70" : "#713b08",
        weight: 9,
        opacity: 0.34,
        dashArray: "0.1, 13",
        lineCap: "round",
        lineJoin: "round"
      }).addTo(this.routesLayer);
    }

    // 3. Main Route Path: Dark Highlight when navigating, Dotted when previewing
    const routeMainLine = L.polyline(roadCoords, {
      pane: 'routePane',
      className: isNavigating
        ? "route-highlight-path route-dark-nav-path"
        : `route-highlight-path route-dotted-preview-path ${mode === "walking" ? "route-preview-walking" : "route-preview-vehicle"}`,
      color: mainLineColor,
      weight: mainLineWeight,
      opacity: 1.0,
      dashArray: mainLineDashArray,
      lineCap: "round",
      lineJoin: "round"
    }).addTo(this.routesLayer);

    // 3a. On-Route Floating ETA Badge (Preview Mode showing both Walk & Kart with distances)
    if (!isNavigating && roadCoords.length >= 2) {
      const midIdx = Math.floor(roadCoords.length * 0.45);
      const midCoord = roadCoords[midIdx];
      const walkDur = options.walkDuration || options.duration || "16 min";
      const walkDist = options.walkDistance || options.distance || "1.1 km";
      const kartDur = options.kartDuration || "5 min";
      const kartDist = options.kartDistance || options.distance || "1.2 km";

      const etaPillHtml = `
        <div class="map-route-floating-badge">
          <div class="floating-badge-item ${mode === 'walking' ? 'active-item' : ''}">
            <span class="badge-icon">🚶</span>
            <span class="badge-time">${walkDur}</span>
            <span class="badge-dist">(${walkDist})</span>
          </div>
          <span class="badge-divider">|</span>
          <div class="floating-badge-item ${mode === 'drive' || mode === 'kart' ? 'active-item' : ''}">
            <span class="badge-icon">🛺</span>
            <span class="badge-time">${kartDur}</span>
            <span class="badge-dist">(${kartDist})</span>
          </div>
        </div>
      `;
      const etaPillIcon = L.divIcon({
        className: "route-eta-pill-badge-wrap",
        html: etaPillHtml,
        iconSize: [0, 0],
        iconAnchor: [80, 18]
      });
      L.marker(midCoord, { icon: etaPillIcon, zIndexOffset: 2950 }).addTo(this.routesLayer);
    }

    // 3b. Off-road Floating Circular Dots Connectors (Origin, Stops, Destination)
    if (options.connectors && Array.isArray(options.connectors)) {
      options.connectors.forEach(conn => {
        if (Array.isArray(conn) && conn.length >= 2) {
          // Layer 1: Dark subtle outline bead dots
          L.polyline(conn, {
            pane: 'routePane',
            className: 'route-connector-outline',
            color: '#334155',
            weight: 7,
            dashArray: '0.1, 13',
            lineCap: 'round',
            lineJoin: 'round'
          }).addTo(this.routesLayer);

          // Layer 2: White circular bead dots
          L.polyline(conn, {
            pane: 'routePane',
            className: 'route-connector-dots',
            color: '#ffffff',
            weight: 4.5,
            dashArray: '0.1, 13',
            lineCap: 'round',
            lineJoin: 'round'
          }).addTo(this.routesLayer);
        }
      });
    }

    // 3c. Road Transition Junction Markers (White disc with dark border)
    if (options.junctions && Array.isArray(options.junctions)) {
      options.junctions.forEach(junc => {
        if (Array.isArray(junc) && junc.length >= 2) {
          const juncIcon = L.divIcon({
            className: 'route-junction-icon',
            html: '<div class="route-junction-dot"></div>',
            iconSize: [0, 0],
            iconAnchor: [7, 7]
          });
          L.marker(junc, { icon: juncIcon, zIndexOffset: 2600 }).addTo(this.routesLayer);
        }
      });
    }

    // 4. Origin Marker (Hollow Orange/White Disc with Labeled Pill Badge to the right)
    const startCoords = validPath[0];
    const startIconHtml = `
      <div class="map-route-marker start-route-marker">
        <div class="origin-ring-dot"></div>
        <div class="route-marker-pill origin-pill">${originName}</div>
      </div>
    `;
    const startIcon = L.divIcon({
      className: "map-route-marker-icon",
      html: startIconHtml,
      iconSize: [0, 0],
      iconAnchor: [9, 9]
    });
    L.marker(startCoords, { icon: startIcon, zIndexOffset: 2500 }).addTo(this.routesLayer);

    // 4b. Multiple Intermediate Waypoint / Stop Markers (Amber Discs with Labeled Pill Badges)
    if (options.waypoints && Array.isArray(options.waypoints) && options.waypoints.length > 0) {
      options.waypoints.forEach(wp => {
        if (wp && typeof wp.lat === 'number' && typeof wp.lon === 'number') {
          const wpName = wp.display || wp.originalName || `Stop ${wp.stopIndex}`;
          const stopIconHtml = `
            <div class="map-route-marker stop-route-marker">
              <div class="stop-dot-marker">${wp.stopIndex || ''}</div>
              <div class="route-marker-pill stop-pill">${wpName}</div>
            </div>
          `;
          const stopIcon = L.divIcon({
            className: "map-route-marker-icon",
            html: stopIconHtml,
            iconSize: [0, 0],
            iconAnchor: [8, 8]
          });
          L.marker([wp.lat, wp.lon], { icon: stopIcon, zIndexOffset: 2800 }).addTo(this.routesLayer);
        }
      });
    } else if (options.viaName && options.viaCoords && Array.isArray(options.viaCoords) && options.viaCoords.length >= 2) {
      const stopIconHtml = `
        <div class="map-route-marker stop-route-marker">
          <div class="stop-dot-marker"></div>
          <div class="route-marker-pill stop-pill">${options.viaName}</div>
        </div>
      `;
      const stopIcon = L.divIcon({
        className: "map-route-marker-icon",
        html: stopIconHtml,
        iconSize: [0, 0],
        iconAnchor: [8, 8]
      });
      L.marker(options.viaCoords, { icon: stopIcon, zIndexOffset: 2800 }).addTo(this.routesLayer);
    }

    // 5. Destination Target Pin (Red Pin with Labeled Pill Badge to the right)
    const destCoords = validPath[validPath.length - 1];
    const destIconHtml = `
      <div class="map-route-marker dest-route-marker">
        <div class="dest-pin-svg-wrap">
          <svg width="24" height="30" viewBox="0 0 24 30" fill="none">
            <path d="M12 0C5.37 0 0 5.37 0 12C0 21 12 30 12 30C12 30 24 21 24 12C24 5.37 18.63 0 12 0Z" fill="#DC2626"/>
            <circle cx="12" cy="11" r="4.5" fill="#FFFFFF"/>
          </svg>
        </div>
        <div class="route-marker-pill dest-pill">${destName}</div>
      </div>
    `;
    const destIcon = L.divIcon({
      className: "map-route-marker-icon",
      html: destIconHtml,
      iconSize: [0, 0],
      iconAnchor: [12, 30]
    });
    L.marker(destCoords, { icon: destIcon, zIndexOffset: 3000 }).addTo(this.routesLayer);

    // 7. Auto-fit map bounds smoothly (only on first calculation)
    if (!skipFitBounds) {
      try {
        this.map.fitBounds(routeMainLine.getBounds(), {
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

  clearRoute() {
    this.clearRoutes();
  }

  resetView() {
    if (typeof CAMPUS_CENTER !== "undefined" && typeof CAMPUS_DEFAULT_ZOOM !== "undefined") {
      this.map.flyTo(CAMPUS_CENTER, CAMPUS_DEFAULT_ZOOM, {
        animate: true,
        duration: 1.0
      });
    }
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
    if (typeof LPU_BOUNDARY !== "undefined" && Array.isArray(LPU_BOUNDARY) && LPU_BOUNDARY.length > 0) {
      const bounds = L.latLngBounds(LPU_BOUNDARY);
      this.map.fitBounds(bounds.pad(isMobile ? 0.04 : 0.12), {
        paddingTopLeft: isMobile ? [95, 10] : [70, 70],
        paddingBottomRight: isMobile ? [10, 85] : [70, 70],
        animate: true,
        duration: 1
      });
    } else {
      this.map.flyTo(CAMPUS_CENTER, isMobile ? 15.8 : 15.5, { animate: true, duration: 1 });
    }
  }

  resetToInitialView() {
    if (!this.map) return;
    if (typeof this.resetOrientation === "function") {
      this.resetOrientation();
    }
    const center = this.initialCenter || (typeof CAMPUS_CENTER !== "undefined" ? CAMPUS_CENTER : [31.2536, 75.7037]);
    const zoom = (this.initialZoom !== null && this.initialZoom !== undefined) ? this.initialZoom : 15.25;
    this.map.flyTo(center, zoom, {
      animate: true,
      duration: 0.8
    });
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
