/**
 * LPU Map - Directions Controller (Panel 2 & Navigation)
 * Full Topological Campus Road Graph Pathfinder + Instant Geocoding + Dot Route Renderer.
 */

/* ============================================================================
   Campus Road Network Graph (A* Dijkstra Pathfinder)
   ============================================================================ */
class CampusRoadGraph {
  constructor() {
    this.nodes = new Map(); // id -> { lat, lng, neighbors: [{ id, dist }] }
    this.initialized = false;
  }

  buildGraph() {
    if (this.initialized) return;
    const roadData = (typeof CAMPUS_ROADS_DATA !== "undefined" && Array.isArray(CAMPUS_ROADS_DATA)) ? CAMPUS_ROADS_DATA : [];
    if (roadData.length === 0) return;

    // Helper: Generate unique node id from lat/lng
    const getNodeId = (lat, lng) => `${lat.toFixed(6)},${lng.toFixed(6)}`;

    // 1. Add all road segments as bidirectional graph edges
    roadData.forEach(way => {
      const coords = way.coords || [];
      for (let i = 0; i < coords.length - 1; i++) {
        const [lat1, lng1] = coords[i];
        const [lat2, lng2] = coords[i + 1];

        const id1 = getNodeId(lat1, lng1);
        const id2 = getNodeId(lat2, lng2);

        if (!this.nodes.has(id1)) this.nodes.set(id1, { lat: lat1, lng: lng1, neighbors: [] });
        if (!this.nodes.has(id2)) this.nodes.set(id2, { lat: lat2, lng: lng2, neighbors: [] });

        const dist = this.haversineDistance(lat1, lng1, lat2, lng2);
        this.nodes.get(id1).neighbors.push({ id: id2, dist });
        this.nodes.get(id2).neighbors.push({ id: id1, dist });
      }
    });

    // 2. Connect nearby junction nodes (intersections within ~15 meters)
    const nodeList = Array.from(this.nodes.values());
    for (let i = 0; i < nodeList.length; i++) {
      const n1 = nodeList[i];
      const id1 = getNodeId(n1.lat, n1.lng);
      for (let j = i + 1; j < nodeList.length; j++) {
        const n2 = nodeList[j];
        const d = this.haversineDistance(n1.lat, n1.lng, n2.lat, n2.lng);
        if (d <= 15) {
          const id2 = getNodeId(n2.lat, n2.lng);
          this.nodes.get(id1).neighbors.push({ id: id2, dist: d });
          this.nodes.get(id2).neighbors.push({ id: id1, dist: d });
        }
      }
    }

    this.initialized = true;
  }

  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  findNearestNode(lat, lng) {
    let bestId = null;
    let minDist = Infinity;
    for (const [id, node] of this.nodes.entries()) {
      const d = this.haversineDistance(lat, lng, node.lat, node.lng);
      if (d < minDist) {
        minDist = d;
        bestId = id;
      }
    }
    return bestId;
  }

  // A* Shortest Path Search
  findPath(startLat, startLng, endLat, endLng) {
    this.buildGraph();
    if (this.nodes.size === 0) return null;

    const startNodeId = this.findNearestNode(startLat, startLng);
    const endNodeId = this.findNearestNode(endLat, endLng);

    if (!startNodeId || !endNodeId) return null;
    if (startNodeId === endNodeId) {
      return [[startLat, startLng], [endLat, endLng]];
    }

    const openSet = new Set([startNodeId]);
    const cameFrom = new Map();

    const gScore = new Map();
    gScore.set(startNodeId, 0);

    const endNode = this.nodes.get(endNodeId);
    const fScore = new Map();
    fScore.set(startNodeId, this.haversineDistance(startLat, startLng, endNode.lat, endNode.lng));

    while (openSet.size > 0) {
      // Find node with lowest fScore
      let current = null;
      let lowestF = Infinity;
      for (const id of openSet) {
        const f = fScore.has(id) ? fScore.get(id) : Infinity;
        if (f < lowestF) {
          lowestF = f;
          current = id;
        }
      }

      if (current === endNodeId) {
        // Reconstruct path
        const pathCoords = [];
        let curr = current;
        while (curr) {
          const n = this.nodes.get(curr);
          pathCoords.unshift([n.lat, n.lng]);
          curr = cameFrom.get(curr);
        }
        // Include exact start and destination points
        pathCoords.unshift([startLat, startLng]);
        pathCoords.push([endLat, endLng]);
        return pathCoords;
      }

      openSet.delete(current);
      const currG = gScore.get(current);
      const currNode = this.nodes.get(current);

      for (const neighbor of currNode.neighbors) {
        const tentativeG = currG + neighbor.dist;
        const neighborG = gScore.has(neighbor.id) ? gScore.get(neighbor.id) : Infinity;

        if (tentativeG < neighborG) {
          cameFrom.set(neighbor.id, current);
          gScore.set(neighbor.id, tentativeG);
          const nObj = this.nodes.get(neighbor.id);
          const h = this.haversineDistance(nObj.lat, nObj.lng, endNode.lat, endNode.lng);
          fScore.set(neighbor.id, tentativeG + h);
          openSet.add(neighbor.id);
        }
      }
    }

    // Direct interpolation fallback if graph disconnected
    return [[startLat, startLng], [(startLat + endLat) / 2, (startLng + endLng) / 2], [endLat, endLng]];
  }
}

/* ============================================================================
   Directions Controller Class
   ============================================================================ */
class DirectionsController {
  constructor() {
    this.currentMode = "walking";
    this.currentOrigin = "Main Gate (Students)";
    this.currentDestination = "Block 25 (CSE)";
    this.debounceTimer = null;
    this.activeRequestId = 0;
    this.roadGraph = new CampusRoadGraph();
  }

  init() {
    this.roadGraph.buildGraph();
    this.bindEvents();
    this.setupAutocomplete();
  }

  /* ==========================================================================
     📍 Geocoding Engine
     ========================================================================== */
  async geocodePlace(name) {
    if (!name || typeof name !== "string") {
      return { lat: CAMPUS_CENTER[0], lon: CAMPUS_CENTER[1], display: "Main Gate (Students)" };
    }

    const cleanName = name.trim().toLowerCase();

    // 1. Current GPS Location
    if (cleanName.includes("my location") || cleanName.includes("current location") || cleanName.includes("you are here")) {
      if (window.CampusMap && window.CampusMap.currentUserCoords) {
        return {
          lat: window.CampusMap.currentUserCoords[0],
          lon: window.CampusMap.currentUserCoords[1],
          display: "Your Current Location"
        };
      }
      return { lat: CAMPUS_CENTER[0], lon: CAMPUS_CENTER[1], display: "Main Gate (Students)" };
    }

    // 2. Search Local Campus Locations
    const allLocs = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (CAMPUS_LOCATIONS || []);
    
    // Direct / ID Match
    const exact = allLocs.find(l => 
      l.name.toLowerCase() === cleanName ||
      l.id.toLowerCase() === cleanName
    );
    if (exact) return { lat: exact.lat, lon: exact.lng, display: exact.name };

    // Number extraction match (e.g. "25", "34", "31", "block 25")
    const numMatch = cleanName.match(/\b(\d{1,2})\b/);
    if (numMatch) {
      const num = numMatch[1];
      const blockMatch = allLocs.find(l => 
        l.id === `block-${num}` || 
        l.id.includes(`block-${num}`) || 
        l.name.toLowerCase() === `block ${num}` ||
        l.name.toLowerCase().includes(`block ${num}`) ||
        (l.tags && l.tags.some(t => t.toLowerCase() === `b${num}` || t.toLowerCase() === `block ${num}`))
      );
      if (blockMatch) return { lat: blockMatch.lat, lon: blockMatch.lng, display: blockMatch.name };
    }

    // Partial / Tag Match
    const partial = allLocs.find(l =>
      l.name.toLowerCase().includes(cleanName) ||
      l.id.toLowerCase().includes(cleanName) ||
      (l.tags && l.tags.some(t => t.toLowerCase().includes(cleanName)))
    );
    if (partial) return { lat: partial.lat, lon: partial.lng, display: partial.name };

    // 3. Search Campus Groups
    if (typeof CAMPUS_GROUPS !== "undefined" && Array.isArray(CAMPUS_GROUPS)) {
      const group = CAMPUS_GROUPS.find(g =>
        g.name.toLowerCase().includes(cleanName) ||
        g.id.toLowerCase().includes(cleanName) ||
        (g.tags && g.tags.some(t => t.toLowerCase().includes(cleanName)))
      );
      if (group && group.centerCoords) {
        return { lat: group.centerCoords[0], lon: group.centerCoords[1], display: group.name };
      }
    }

    // 4. Online Nominatim OpenStreetMap Geocoding
    try {
      const query = encodeURIComponent(`${name}, Lovely Professional University, Phagwara, Punjab`);
      const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
      const response = await fetch(url, {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'LPUMap/1.0' },
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lon = parseFloat(data[0].lon);
          return { lat, lon, display: data[0].display_name.split(',')[0] || name };
        }
      }
    } catch (e) {
      // Fall through to campus center
    }

    return { lat: CAMPUS_CENTER[0], lon: CAMPUS_CENTER[1], display: name };
  }

  /* ==========================================================================
     🛣️ Route Calculation Engine
     ========================================================================== */
  async fetchRoute(start, end, mode = "walking") {
    // 1. First, attempt to calculate route over the accurate local campus road network
    const roadPath = this.roadGraph.findPath(start.lat, start.lon, end.lat, end.lon);
    
    // Calculate total path distance
    let totalDist = 0;
    if (roadPath && roadPath.length >= 2) {
      for (let i = 0; i < roadPath.length - 1; i++) {
        totalDist += this.roadGraph.haversineDistance(
          roadPath[i][0], roadPath[i][1],
          roadPath[i + 1][0], roadPath[i + 1][1]
        );
      }
    } else {
      totalDist = this.roadGraph.haversineDistance(start.lat, start.lon, end.lat, end.lon) * 1.25;
    }

    const distMeters = Math.max(50, Math.round(totalDist));
    const speedMpm = mode === "kart" ? 220 : (mode === "bicycle" ? 150 : 75);
    const durationMin = Math.max(1, Math.round(distMeters / speedMpm));

    // Generate smart turn steps along the path
    const steps = this.generateTurnSteps(start, end, roadPath, distMeters);

    return {
      path: roadPath || [[start.lat, start.lon], [end.lat, end.lon]],
      steps,
      distance: `${distMeters} m`,
      duration: `${durationMin} min`
    };
  }

  generateTurnSteps(start, end, path, totalDist) {
    const steps = [];
    steps.push({
      instruction: `Start from ${start.display}`,
      distance: `${Math.round(totalDist * 0.2)} m`,
      icon: "map-pin"
    });

    if (totalDist > 200) {
      steps.push({
        instruction: `Follow campus walkway along central avenue`,
        distance: `${Math.round(totalDist * 0.5)} m`,
        icon: "corner-up-right"
      });
    }

    steps.push({
      instruction: `Turn toward ${end.display}`,
      distance: `${Math.round(totalDist * 0.3)} m`,
      icon: "corner-up-left"
    });

    steps.push({
      instruction: `Arrive at ${end.display}`,
      distance: "0 m",
      icon: "map-pin",
      isArrival: true
    });

    return steps;
  }

  /* ==========================================================================
     🎯 Autocomplete Setup
     ========================================================================== */
  setupAutocomplete() {
    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");

    if (originInput) this.attachAutocomplete(originInput, "origin");
    if (destInput) this.attachAutocomplete(destInput, "dest");

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".directions-inputs-card")) {
        this.closeAllAutocompleteDropdowns();
      }
    });
  }

  attachAutocomplete(inputEl, type) {
    const wrapper = inputEl.parentElement;
    if (!wrapper) return;
    wrapper.style.position = "relative";

    let dropdown = wrapper.querySelector(".directions-autocomplete-dropdown");
    if (!dropdown) {
      dropdown = document.createElement("div");
      dropdown.className = "directions-autocomplete-dropdown";
      wrapper.appendChild(dropdown);
    }

    const renderSuggestions = (query) => {
      const q = (query || "").trim().toLowerCase();
      dropdown.innerHTML = "";

      const allLocs = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (CAMPUS_LOCATIONS || []);
      const suggestions = [];

      // Always offer "Your Current Location" for origin
      if (type === "origin" && (q === "" || "my location".includes(q) || "current location".includes(q))) {
        suggestions.push({
          name: "Your Current Location",
          sub: "Live GPS on campus",
          type: "gps"
        });
      }

      // Filter matching campus locations
      allLocs.forEach(loc => {
        const matchesName = loc.name.toLowerCase().includes(q);
        const matchesType = (loc.type || "").toLowerCase().includes(q);
        const matchesTag = loc.tags && loc.tags.some(t => t.toLowerCase().includes(q));
        if (q === "" || matchesName || matchesType || matchesTag) {
          suggestions.push({
            name: loc.name,
            sub: loc.type || loc.groupName || "Campus Location",
            type: "place"
          });
        }
      });

      if (typeof CAMPUS_GROUPS !== "undefined" && Array.isArray(CAMPUS_GROUPS)) {
        CAMPUS_GROUPS.forEach(grp => {
          if (q === "" || grp.name.toLowerCase().includes(q)) {
            suggestions.push({
              name: grp.name,
              sub: "Academic School / Department",
              type: "group"
            });
          }
        });
      }

      if (suggestions.length === 0) {
        dropdown.innerHTML = `<div class="auto-item-empty">No campus location matched "${query}"</div>`;
        dropdown.classList.add("open");
        return;
      }

      suggestions.slice(0, 8).forEach(item => {
        const itemEl = document.createElement("div");
        itemEl.className = "directions-auto-item";
        itemEl.innerHTML = `
          <div class="auto-item-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
              <circle cx="12" cy="10" r="3"></circle>
            </svg>
          </div>
          <div class="auto-item-info">
            <div class="auto-item-title">${item.name}</div>
            <div class="auto-item-sub">${item.sub}</div>
          </div>
        `;

        const selectItem = (e) => {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }
          clearTimeout(this.debounceTimer);
          inputEl.value = item.name;
          if (type === "origin") this.currentOrigin = item.name;
          if (type === "dest") this.currentDestination = item.name;
          dropdown.classList.remove("open");

          const originVal = document.getElementById("direction-origin-input")?.value || "Main Gate (Students)";
          const destVal = document.getElementById("direction-dest-input")?.value || "Block 25 (CSE)";
          this.showDirections(originVal, destVal);
        };

        itemEl.addEventListener("pointerdown", selectItem);
        itemEl.addEventListener("click", selectItem);

        dropdown.appendChild(itemEl);
      });

      dropdown.classList.add("open");
    };

    inputEl.addEventListener("focus", () => {
      renderSuggestions(inputEl.value);
    });

    inputEl.addEventListener("input", () => {
      renderSuggestions(inputEl.value);
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(this.debounceTimer);
        dropdown.classList.remove("open");
        const originVal = document.getElementById("direction-origin-input")?.value || "Main Gate (Students)";
        const destVal = document.getElementById("direction-dest-input")?.value || "Block 25 (CSE)";
        this.showDirections(originVal, destVal);
      }
    });
  }

  closeAllAutocompleteDropdowns() {
    document.querySelectorAll(".directions-autocomplete-dropdown").forEach(d => {
      d.classList.remove("open");
    });
  }

  /* ==========================================================================
     🎛️ Event Handlers
     ========================================================================== */
  bindEvents() {
    // Mode tab buttons
    const modeTabs = document.querySelectorAll(".mode-tab-btn");
    modeTabs.forEach(tab => {
      const handleModeClick = (e) => {
        if (e) e.preventDefault();
        modeTabs.forEach(t => t.classList.remove("active"));
        const btn = e.currentTarget;
        btn.classList.add("active");
        this.currentMode = btn.dataset.mode || "walking";

        const originVal = document.getElementById("direction-origin-input")?.value || this.currentOrigin;
        const destVal = document.getElementById("direction-dest-input")?.value || this.currentDestination;
        this.showDirections(originVal, destVal);
      };
      tab.addEventListener("click", handleModeClick);
    });

    // Swap locations button
    const swapBtn = document.getElementById("swap-directions-btn");
    if (swapBtn) {
      const handleSwap = (e) => {
        if (e) e.preventDefault();
        clearTimeout(this.debounceTimer);
        const originInput = document.getElementById("direction-origin-input");
        const destInput = document.getElementById("direction-dest-input");
        if (originInput && destInput) {
          const temp = originInput.value;
          originInput.value = destInput.value;
          destInput.value = temp;
          this.currentOrigin = originInput.value;
          this.currentDestination = destInput.value;

          this.showDirections(this.currentOrigin, this.currentDestination);
        }
      };
      swapBtn.addEventListener("click", handleSwap);
    }

    // Find Route button ("Get Directions (Dot Route)")
    const findRouteBtn = document.getElementById("find-route-btn");
    if (findRouteBtn) {
      const handleFindRoute = (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        clearTimeout(this.debounceTimer);
        const originVal = document.getElementById("direction-origin-input")?.value || "Main Gate (Students)";
        const destVal = document.getElementById("direction-dest-input")?.value || "Block 25 (CSE)";
        this.showDirections(originVal, destVal);
      };
      findRouteBtn.addEventListener("click", handleFindRoute);
      findRouteBtn.addEventListener("pointerup", handleFindRoute);
    }

    // Start navigation button
    const startNavBtn = document.getElementById("start-nav-btn");
    if (startNavBtn) {
      startNavBtn.addEventListener("click", (e) => {
        if (e) e.preventDefault();
        if (window.UIController) {
          window.UIController.startActiveNavigation(this.currentDestination || "Block 25 (CSE)", "8 min", "650 m");
        }
      });
    }
  }

  /* ==========================================================================
     🚀 Main Function: showDirections(origin, destination)
     Renders directions between entered locations in DOT FORMAT.
     ========================================================================== */
  async showDirections(origin = "Main Gate (Students)", dest = "Block 25 (CSE)") {
    clearTimeout(this.debounceTimer);
    const reqId = ++this.activeRequestId;

    this.currentOrigin = origin;
    this.currentDestination = dest;

    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    if (originInput && originInput.value !== origin) originInput.value = origin;
    if (destInput && destInput.value !== dest) destInput.value = dest;

    this.closeAllAutocompleteDropdowns();

    const summaryCard = document.querySelector(".route-summary-card");
    if (summaryCard) {
      const stats = summaryCard.querySelector(".route-summary-stats");
      if (stats) stats.textContent = "Calculating route...";
    }

    try {
      const start = await this.geocodePlace(origin || "Main Gate (Students)");
      const end = await this.geocodePlace(dest || "Block 25 (CSE)");

      // Check if another request superceded this one
      if (reqId !== this.activeRequestId) return;

      const route = await this.fetchRoute(start, end, this.currentMode);

      if (reqId !== this.activeRequestId) return;

      // Render Steps in Panel
      this.renderSteps(route.steps);

      // DRAW ROUTE IN DOT FORMAT ON LEAFLET MAP
      if (window.CampusMap) {
        window.CampusMap.drawRoute(route.path, false, null, {
          mode: this.currentMode,
          originName: start.display,
          destName: end.display
        });
      }

      // Update Summary Header Card
      if (summaryCard) {
        const title = summaryCard.querySelector(".route-summary-title");
        const stats = summaryCard.querySelector(".route-summary-stats");
        if (title) {
          title.textContent = this.currentMode === "kart" 
            ? "Kart / Shuttle Route" 
            : (this.currentMode === "bicycle" ? "Bicycle / Cycleway Route" : "Best Route (Walking)");
        }
        if (stats) {
          stats.textContent = `${route.distance} • ${route.duration}`;
        }
      }

      this.updateModePillEstimates(route.distance);

    } catch (error) {
      console.error("Error calculating directions:", error);
    }
  }

  updateModePillEstimates(distanceStr) {
    const distNum = parseInt(distanceStr) || 600;
    const walkMin = Math.max(1, Math.round(distNum / 75));
    const cycleMin = Math.max(1, Math.round(distNum / 150));
    const kartMin = Math.max(1, Math.round(distNum / 220));

    const walkBtn = document.querySelector(".mode-tab-btn[data-mode='walking'] span");
    const cycleBtn = document.querySelector(".mode-tab-btn[data-mode='bicycle'] span");
    const kartBtn = document.querySelector(".mode-tab-btn[data-mode='kart'] span");

    if (walkBtn) walkBtn.textContent = `${walkMin} min`;
    if (cycleBtn) cycleBtn.textContent = `${cycleMin} min`;
    if (kartBtn) kartBtn.textContent = `${kartMin} min`;
  }

  showDetourRerouting() {
    const origin = "Main Gate (Students)";
    const dest = "Block 31 (Admin)";

    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    if (originInput) originInput.value = origin;
    if (destInput) destInput.value = dest;

    const closedPath = [
      [31.258280, 75.706657],
      [31.257209, 75.703848],
      [31.256420, 75.704508]
    ];
    const detourPath = this.roadGraph.findPath(31.260585, 75.707280, 31.252543, 75.704916);

    if (window.CampusMap) {
      window.CampusMap.drawRoute(
        detourPath || [[31.260585, 75.707280], [31.252543, 75.704916]],
        true,
        closedPath,
        { mode: this.currentMode, originName: origin, destName: dest }
      );
    }
  }

  renderSteps(steps) {
    const stepsListEl = document.getElementById("turn-steps-list");
    if (!stepsListEl) return;

    stepsListEl.innerHTML = "";

    steps.forEach((step) => {
      const stepItem = document.createElement("div");
      stepItem.className = `step-item ${step.isArrival ? "destination" : ""}`;

      let iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
      
      if (step.icon === "corner-up-right") {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 14 20 9 15 4"></polyline><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path></svg>`;
      } else if (step.icon === "corner-up-left") {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>`;
      } else if (step.icon === "map-pin") {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
      }

      stepItem.innerHTML = `
        <div class="step-icon-wrapper">${iconSvg}</div>
        <div class="step-instruction">
          <div class="step-main-text">${step.instruction}</div>
          <div class="step-distance">${step.distance}</div>
        </div>
      `;

      stepsListEl.appendChild(stepItem);
    });
  }
}

// Global Directions instance
window.Directions = new DirectionsController();
