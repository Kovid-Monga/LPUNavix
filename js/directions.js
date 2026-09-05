/**
 * LPU Map - Directions Controller (Panel 2 & Navigation)
 * Full Topological Campus Road Graph Pathfinder + Instant Geocoding + Dot Route Renderer.
 */

/* ============================================================================
   Campus Road Network Graph (A* Dijkstra Pathfinder)
   ============================================================================ */
class CampusRoadGraph {
  constructor() {
    this.nodes = new Map(); // id -> { lat, lng, neighbors: [{ id, dist, highway, isFoot, isVeh, isOneway, forward, isTransition }], hasFootEdge, hasVehEdge }
    this.initialized = false;
  }

  buildGraph() {
    if (this.initialized) return;
    const roadData = (typeof CAMPUS_ROADS_DATA !== "undefined" && Array.isArray(CAMPUS_ROADS_DATA) && CAMPUS_ROADS_DATA.length > 0)
      ? CAMPUS_ROADS_DATA
      : (typeof LPU_ROAD_NETWORK !== "undefined" && Array.isArray(LPU_ROAD_NETWORK))
        ? LPU_ROAD_NETWORK.map(way => ({
            id: way.id,
            tags: { highway: way.highway, name: way.name || "", oneway: way.oneway || "", junction: way.junction || "" },
            coords: way.geometry
          }))
        : [];
    if (roadData.length === 0) return;

    // Helper: Generate unique node id from lat/lng
    const getNodeId = (lat, lng) => `${lat.toFixed(6)},${lng.toFixed(6)}`;

    // 1. Add all road & footpath segments with multimodal tags
    roadData.forEach(way => {
      const coords = way.coords || [];
      const tags = way.tags || {};
      const highway = tags.highway || 'road';

      const isFoot = ['footway', 'path', 'steps', 'pedestrian', 'track', 'cycleway'].includes(highway);
      const isVeh = ['service', 'residential', 'unclassified', 'tertiary', 'trunk', 'living_street', 'road'].includes(highway);
      const isOneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout';

      for (let i = 0; i < coords.length - 1; i++) {
        const [lat1, lng1] = coords[i];
        const [lat2, lng2] = coords[i + 1];

        const id1 = getNodeId(lat1, lng1);
        const id2 = getNodeId(lat2, lng2);

        if (!this.nodes.has(id1)) this.nodes.set(id1, { lat: lat1, lng: lng1, neighbors: [], hasFootEdge: false, hasVehEdge: false });
        if (!this.nodes.has(id2)) this.nodes.set(id2, { lat: lat2, lng: lng2, neighbors: [], hasFootEdge: false, hasVehEdge: false });

        const dist = this.haversineDistance(lat1, lng1, lat2, lng2);

        const node1 = this.nodes.get(id1);
        const node2 = this.nodes.get(id2);

        if (isFoot) {
          node1.hasFootEdge = true;
          node2.hasFootEdge = true;
        }
        if (isVeh) {
          node1.hasVehEdge = true;
          node2.hasVehEdge = true;
        }

        // Forward edge
        node1.neighbors.push({
          id: id2,
          dist,
          highway,
          isFoot,
          isVeh,
          isOneway,
          forward: true
        });

        // Reverse edge: Only mark isVeh if the way itself is a vehicle road and not oneway
        node2.neighbors.push({
          id: id1,
          dist,
          highway,
          isFoot,
          isVeh: isVeh && !isOneway,
          isOneway,
          forward: false
        });
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
          const vehJunction = n1.hasVehEdge && n2.hasVehEdge;

          this.nodes.get(id1).neighbors.push({
            id: id2,
            dist: d,
            highway: 'junction',
            isFoot: true,
            isVeh: vehJunction,
            isOneway: false,
            isTransition: true,
            forward: true
          });
          this.nodes.get(id2).neighbors.push({
            id: id1,
            dist: d,
            highway: 'junction',
            isFoot: true,
            isVeh: vehJunction,
            isOneway: false,
            isTransition: true,
            forward: true
          });
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

  findNearestNode(lat, lng, mode = 'walking') {
    let bestId = null;
    let minDist = Infinity;

    for (const [id, node] of this.nodes.entries()) {
      let isEligible = true;
      if (mode === 'kart' || mode === 'drive' || mode === 'moto') {
        isEligible = node.hasVehEdge;
      } else if (mode === 'walking') {
        isEligible = node.hasFootEdge;
      }

      if (isEligible) {
        const d = this.haversineDistance(lat, lng, node.lat, node.lng);
        if (d < minDist) {
          minDist = d;
          bestId = id;
        }
      }
    }

    // Fallback: If no dedicated mode node is nearby, search all nodes
    if (!bestId || minDist > 250) {
      for (const [id, node] of this.nodes.entries()) {
        const d = this.haversineDistance(lat, lng, node.lat, node.lng);
        if (d < minDist) {
          minDist = d;
          bestId = id;
        }
      }
    }

    return bestId;
  }

  getEdgeCost(edge, mode = 'walking') {
    if (mode === 'kart' || mode === 'drive' || mode === 'moto') {
      // Vehicles/Karts/Cars: strictly forbidden on pedestrian steps, walkways, and footpaths
      if (edge.highway === 'steps' || edge.highway === 'footway' || edge.highway === 'pedestrian' || edge.highway === 'path') {
        return Infinity;
      }
      if (!edge.isVeh) return Infinity;
      return edge.dist * 1.0;
    }

    // Walking Mode: Strictly prioritize footpaths & pedestrian walkways
    if (edge.isFoot) {
      return edge.dist * 1.0;
    }
    if (edge.highway === 'living_street') {
      return edge.dist * 1.5;
    }
    if (edge.isVeh) {
      // High penalty on vehicle roads ensures walking uses footpaths wherever available
      return edge.dist * 7.0;
    }

    return edge.dist * 2.0;
  }

  // Multi-modal A* Shortest Path Search
  findPath(startLat, startLng, endLat, endLng, mode = 'walking') {
    this.buildGraph();
    if (this.nodes.size === 0) return null;

    const startNodeId = this.findNearestNode(startLat, startLng, mode);
    const endNodeId = this.findNearestNode(endLat, endLng, mode);

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
        const edgeCost = this.getEdgeCost(neighbor, mode);
        if (!isFinite(edgeCost)) continue;

        const tentativeG = currG + edgeCost;
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
    this.currentMode = "drive";
    this.currentOrigin = "Your location";
    this.currentDestination = "";
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
      return { lat: CAMPUS_CENTER[0], lon: CAMPUS_CENTER[1], display: "Your location" };
    }

    const cleanName = name.trim().toLowerCase();

    // 1. Current GPS Location
    if (cleanName.includes("my location") || cleanName.includes("current location") || cleanName.includes("you are here") || cleanName.includes("your location")) {
      if (window.CampusMap && window.CampusMap.currentUserCoords) {
        return {
          lat: window.CampusMap.currentUserCoords[0],
          lon: window.CampusMap.currentUserCoords[1],
          display: "Your location"
        };
      }
      return { lat: CAMPUS_CENTER[0], lon: CAMPUS_CENTER[1], display: "Your location" };
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
    // 1. Calculate mode-aware route (footpaths for walking, vehicle roads for kart/cars)
    const roadPath = this.roadGraph.findPath(start.lat, start.lon, end.lat, end.lon, mode);
    
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
    let speedMpm = 75; // walking default
    if (mode === "drive") speedMpm = 250;
    else if (mode === "moto") speedMpm = 230;
    else if (mode === "kart" || mode === "bicycle") speedMpm = 200;

    const durationMin = Math.max(1, Math.round(distMeters / speedMpm));

    // Generate smart turn steps along the path
    const steps = this.generateTurnSteps(start, end, roadPath, distMeters, mode);

    return {
      path: roadPath || [[start.lat, start.lon], [end.lat, end.lon]],
      steps,
      distance: `${distMeters} m`,
      duration: `${durationMin} min`
    };
  }

  generateTurnSteps(start, end, path, totalDist, mode = "walking") {
    const steps = [];
    steps.push({
      instruction: `Start from ${start.display}`,
      distance: `${Math.round(totalDist * 0.2)} m`,
      icon: "map-pin"
    });

    if (totalDist > 200) {
      const pathwayDesc = mode === "walking" 
        ? "Follow campus walkway & pedestrian footpath" 
        : "Follow campus vehicle road";
      steps.push({
        instruction: pathwayDesc,
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
    const topOriginInput = document.getElementById("gmaps-topbar-origin-input");
    const topDestInput = document.getElementById("gmaps-topbar-dest-input");

    if (originInput) this.attachAutocomplete(originInput, "origin");
    if (destInput) this.attachAutocomplete(destInput, "dest");
    if (topOriginInput) this.attachAutocomplete(topOriginInput, "origin");
    if (topDestInput) this.attachAutocomplete(topDestInput, "dest");

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".directions-inputs-card") && !e.target.closest(".gmaps-topbar-card")) {
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

      // Bug 2: Only show suggestions when at least one character is typed
      if (q.length === 0) {
        dropdown.classList.remove("open");
        return;
      }

      const allLocs = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (CAMPUS_LOCATIONS || []);
      const suggestions = [];

      // Always offer "Your location" for origin
      if (type === "origin" && ("your location".includes(q) || "my location".includes(q) || "current location".includes(q))) {
        suggestions.push({
          name: "Your location",
          sub: "Live GPS on campus",
          type: "gps"
        });
      }

      // Filter matching campus locations
      allLocs.forEach(loc => {
        const matchesName = loc.name.toLowerCase().includes(q);
        const matchesType = (loc.type || "").toLowerCase().includes(q);
        const matchesTag = loc.tags && loc.tags.some(t => t.toLowerCase().includes(q));
        if (matchesName || matchesType || matchesTag) {
          suggestions.push({
            name: loc.name,
            sub: loc.type || loc.groupName || "Campus Location",
            type: "place"
          });
        }
      });

      if (typeof CAMPUS_GROUPS !== "undefined" && Array.isArray(CAMPUS_GROUPS)) {
        CAMPUS_GROUPS.forEach(grp => {
          if (grp.name.toLowerCase().includes(q)) {
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
          if (type === "origin") {
            this.currentOrigin = item.name;
            const topO = document.getElementById("gmaps-topbar-origin-input");
            const panO = document.getElementById("direction-origin-input");
            if (topO) topO.value = item.name;
            if (panO) panO.value = item.name;
          }
          if (type === "dest") {
            this.currentDestination = item.name;
            const topD = document.getElementById("gmaps-topbar-dest-input");
            const panD = document.getElementById("direction-dest-input");
            if (topD) topD.value = item.name;
            if (panD) panD.value = item.name;
            // Bug 4: selecting destination reveals Get Direction button, does not auto-calculate route
            this.updateDestinationState(item.name);
          }
          dropdown.classList.remove("open");
        };

        let touchStartY = 0;
        let touchStartX = 0;
        let isTouchScroll = false;
        let touchHandled = false;

        itemEl.addEventListener("touchstart", (e) => {
          if (e.touches && e.touches[0]) {
            touchStartY = e.touches[0].clientY;
            touchStartX = e.touches[0].clientX;
            isTouchScroll = false;
            touchHandled = false;
          }
        }, { passive: true });

        itemEl.addEventListener("touchmove", (e) => {
          if (e.touches && e.touches[0]) {
            const dy = Math.abs(e.touches[0].clientY - touchStartY);
            const dx = Math.abs(e.touches[0].clientX - touchStartX);
            if (dy > 6 || dx > 6) {
              isTouchScroll = true;
            }
          }
        }, { passive: true });

        itemEl.addEventListener("touchend", (e) => {
          if (isTouchScroll) return;
          touchHandled = true;
          selectItem(e);
        });

        itemEl.addEventListener("click", (e) => {
          if (isTouchScroll) {
            isTouchScroll = false;
            return;
          }
          if (touchHandled) {
            touchHandled = false;
            return;
          }
          selectItem(e);
        });

        itemEl.addEventListener("mousedown", (e) => {
          e.preventDefault();
        });

        dropdown.appendChild(itemEl);
      });

      dropdown.classList.add("open");
    };

    inputEl.addEventListener("focus", () => {
      const val = (inputEl.value || "").trim();
      // Bug 2: Do not show suggestions when focusing an empty input
      if (val.length > 0) {
        renderSuggestions(inputEl.value);
      } else {
        dropdown.innerHTML = "";
        dropdown.classList.remove("open");
      }
    });

    inputEl.addEventListener("input", () => {
      const val = (inputEl.value || "").trim();
      if (type === "dest") {
        this.currentDestination = inputEl.value;
        this.updateDestinationState(inputEl.value);
      }
      // Bug 2: Only show suggestions when input contains at least one character, hide if empty
      if (val.length > 0) {
        renderSuggestions(inputEl.value);
      } else {
        dropdown.innerHTML = "";
        dropdown.classList.remove("open");
      }
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(this.debounceTimer);
        dropdown.classList.remove("open");
        if (type === "origin") this.currentOrigin = inputEl.value;
        if (type === "dest") {
          this.currentDestination = inputEl.value;
          this.updateDestinationState(inputEl.value);
        }
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
    // Mode tab buttons (panel)
    const modeTabs = document.querySelectorAll(".mode-tab-btn");
    modeTabs.forEach(tab => {
      tab.addEventListener("click", (e) => {
        if (e) e.preventDefault();
        modeTabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        this.currentMode = tab.dataset.mode || "walking";

        const originVal = this.currentOrigin || "Your location";
        const destVal = this.currentDestination;
        if (destVal) this.showDirections(originVal, destVal);
      });
    });

    // Google Maps Preview Mode Tabs (Only Car & Walk)
    const gmapsTabs = document.querySelectorAll(".gmaps-mode-tab");
    gmapsTabs.forEach(tab => {
      tab.addEventListener("click", (e) => {
        if (e) e.preventDefault();
        const selectedMode = tab.dataset.mode || "drive";
        console.log(`[LPUNavix] Mode tab clicked: ${selectedMode}`);
        if (this.currentMode === selectedMode) return;
        this.currentMode = selectedMode;

        gmapsTabs.forEach(t => t.classList.toggle("active", t === tab));

        const originVal = this.currentOrigin || "Your location";
        const destVal = this.currentDestination;
        if (destVal && destVal.trim() !== "") {
          this.showDirections(originVal, destVal);
        }
      });
    });

    // Swap locations buttons (both panel and floating topbar)
    const handleSwap = (e) => {
      if (e) e.preventDefault();
      clearTimeout(this.debounceTimer);
      const temp = this.currentOrigin || "Your location";
      this.currentOrigin = this.currentDestination || "Your location";
      this.currentDestination = temp === "Your location" ? "" : temp;

      const originInput = document.getElementById("direction-origin-input");
      const destInput = document.getElementById("direction-dest-input");
      const topOriginInput = document.getElementById("gmaps-topbar-origin-input");
      const topDestInput = document.getElementById("gmaps-topbar-dest-input");

      if (originInput) originInput.value = this.currentOrigin;
      if (destInput) destInput.value = this.currentDestination;
      if (topOriginInput) topOriginInput.value = this.currentOrigin;
      if (topDestInput) topDestInput.value = this.currentDestination;

      if (this.currentDestination && this.currentDestination.trim() !== "") {
        this.showDirections(this.currentOrigin, this.currentDestination);
      }
    };

    const swapBtn = document.getElementById("swap-directions-btn");
    if (swapBtn) swapBtn.addEventListener("click", handleSwap);

    const topSwapBtn = document.getElementById("gmaps-topbar-swap-btn");
    if (topSwapBtn) topSwapBtn.addEventListener("click", handleSwap);

    // Close / Cross ("✕") button on Google Maps Preview Sheet
    const closePreviewBtn = document.getElementById("gmaps-preview-close-btn");
    if (closePreviewBtn) {
      closePreviewBtn.addEventListener("click", (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        console.log("[LPUNavix] Close preview button clicked -> resetting route and map view");
        this.exitDirections();
      });
    }

    // Find Route button in drawer
    const findRouteBtn = document.getElementById("find-route-btn");
    if (findRouteBtn) {
      const handleFindRoute = (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        clearTimeout(this.debounceTimer);
        const originVal = document.getElementById("direction-origin-input")?.value || "Your location";
        const destVal = document.getElementById("direction-dest-input")?.value || this.currentDestination || "";
        if (destVal && destVal.trim() !== "") {
          this.showDirections(originVal, destVal);
        }
      };
      findRouteBtn.addEventListener("click", handleFindRoute);
    }

    // Start navigation buttons (both in drawer and Google Maps preview sheet)
    const handleStartNav = (e) => {
      if (e) e.preventDefault();
      console.log(`[LPUNavix] Start Navigation clicked for mode: ${this.currentMode}, destination: ${this.currentDestination}`);
      const dest = this.currentDestination || "Destination";
      const dur = (this.currentRouteData && this.currentRouteData.activeRoute) ? this.currentRouteData.activeRoute.duration : "1 min";
      const dist = (this.currentRouteData && this.currentRouteData.activeRoute) ? this.currentRouteData.activeRoute.distance : "230 m";
      const path = (this.currentRouteData && this.currentRouteData.activeRoute) ? this.currentRouteData.activeRoute.path : null;

      if (window.UIController) {
        window.UIController.startActiveNavigation(dest, dur, dist, this.currentMode, path);
      }
    };

    const startNavBtn = document.getElementById("start-nav-btn");
    if (startNavBtn) startNavBtn.addEventListener("click", handleStartNav);

    const gmapsStartBtn = document.getElementById("gmaps-start-action-btn");
    if (gmapsStartBtn) gmapsStartBtn.addEventListener("click", handleStartNav);

    // Share & Add stops buttons
    const handleShare = (e) => {
      if (e) e.preventDefault();
      console.log(`[LPUNavix] Share route clicked for: ${this.currentDestination}`);
      if (navigator.share) {
        navigator.share({
          title: `Directions to ${this.currentDestination || 'LPU Location'}`,
          text: `Check out route to ${this.currentDestination} on LPUNavix!`,
          url: window.location.href
        }).catch(() => {});
      } else {
        navigator.clipboard?.writeText(window.location.href);
        alert("Route link copied to clipboard!");
      }
    };

    const shareTopBtn = document.getElementById("gmaps-preview-share-top-btn");
    const shareActBtn = document.getElementById("gmaps-share-action-btn");
    if (shareTopBtn) shareTopBtn.addEventListener("click", handleShare);
    if (shareActBtn) shareActBtn.addEventListener("click", handleShare);

    const addStopsBtn = document.getElementById("gmaps-add-stops-action-btn");
    if (addStopsBtn) {
      addStopsBtn.addEventListener("click", (e) => {
        if (e) e.preventDefault();
        console.log(`[LPUNavix] Add stops clicked for destination: ${this.currentDestination}`);
        alert("Add stops feature will be available in next release.");
      });
    }

    const tuneBtn = document.getElementById("gmaps-preview-tune-btn");
    if (tuneBtn) {
      tuneBtn.addEventListener("click", (e) => {
        if (e) e.preventDefault();
        console.log("[LPUNavix] Route options / filter clicked");
      });
    }
  }

  /* ==========================================================================
     🚀 Main Function: showDirections(origin, destination)
     Calculates multi-modal routes, draws solid highlighted route on map with
     on-route ETA badge, and displays Google Maps-style route overview.
     ========================================================================== */
  async showDirections(origin = "Your location", dest = "", skipHistory = false) {
    clearTimeout(this.debounceTimer);
    const reqId = ++this.activeRequestId;

    if (!dest || dest.trim() === "") {
      this.currentDestination = "";
      if (window.CampusMap) window.CampusMap.clearRoute();
      this.hideRoutePreview();
      return;
    }

    this.currentOrigin = origin;
    this.currentDestination = dest;

    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    const topOriginInput = document.getElementById("gmaps-topbar-origin-input");
    const topDestInput = document.getElementById("gmaps-topbar-dest-input");
    if (originInput && originInput.value !== origin) originInput.value = origin;
    if (destInput && destInput.value !== dest) destInput.value = dest;
    if (topOriginInput && topOriginInput.value !== origin) topOriginInput.value = origin;
    if (topDestInput && topDestInput.value !== dest) topDestInput.value = dest;

    this.closeAllAutocompleteDropdowns();

    // Ensure history state is recorded so phone/browser back button returns to previous slide or map
    if (!skipHistory && window.UIController) {
      window.UIController.setNavState("route", {
        origin: this.currentOrigin,
        dest: this.currentDestination,
        mode: this.currentMode
      });
    }

    // Close the old panel drawer so user has full view of map and Google Maps sheet
    if (window.UIController) {
      window.UIController.closeLeftPanels();
    }

    try {
      const start = await this.geocodePlace(origin || "Your location");
      const end = await this.geocodePlace(dest);

      if (reqId !== this.activeRequestId) return;

      // 1. Calculate ONLY Car (drive) and Walk (walking) routes
      const driveRoute = await this.fetchRoute(start, end, "drive");
      const walkRoute = await this.fetchRoute(start, end, "walking");

      if (reqId !== this.activeRequestId) return;

      const activeRoute = (this.currentMode === "walking") ? walkRoute : driveRoute;

      this.currentRouteData = {
        activeRoute,
        driveRoute,
        walkRoute,
        start,
        end,
        mode: this.currentMode
      };

      // 2. DRAW SOLID HIGHLIGHTED ROUTE ON LEAFLET MAP (With on-route ETA badge)
      if (window.CampusMap) {
        window.CampusMap.drawRoute(activeRoute.path, false, null, {
          mode: this.currentMode,
          originName: start.display,
          destName: end.display,
          duration: activeRoute.duration
        });
      }

      // 3. Reveal & Render Google Maps Style Route Preview Page
      this.renderGoogleMapsPreview(start, end, driveRoute, walkRoute, activeRoute);

    } catch (error) {
      console.error("Error calculating directions:", error);
    }
  }

  /* ==========================================================================
     📱 Google Maps Style Route Preview Render & Reset
     ========================================================================== */
  updateDestinationState(destName) {
    const hasDest = !!(destName && destName.trim().length > 0);
    const actionsRow = document.querySelector(".directions-actions-row");
    const quickChips = document.querySelector(".directions-quick-chips");

    if (actionsRow) actionsRow.style.display = hasDest ? "block" : "none";
    if (quickChips) quickChips.style.display = hasDest ? "none" : "flex";
  }

  selectDestination(destName) {
    if (!destName) return;
    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    const topDestInput = document.getElementById("gmaps-topbar-dest-input");
    if (!originInput || !originInput.value || !originInput.value.trim()) {
      if (originInput) originInput.value = "Your location";
      this.currentOrigin = "Your location";
    }
    if (destInput) destInput.value = destName;
    if (topDestInput) topDestInput.value = destName;
    this.currentDestination = destName;
    this.updateDestinationState(destName);
  }

  selectDestinationAndShow(destName) {
    this.selectDestination(destName);
  }

  renderGoogleMapsPreview(start, end, driveRoute, walkRoute, activeRoute) {
    document.body.classList.add("gmaps-route-active");
    const topBar = document.getElementById("gmaps-route-topbar");
    const previewSheet = document.getElementById("gmaps-route-preview-sheet");

    if (topBar) {
      const topOrigin = document.getElementById("gmaps-topbar-origin-input");
      const topDest = document.getElementById("gmaps-topbar-dest-input");
      if (topOrigin) topOrigin.value = (start && start.display) || this.currentOrigin || "Your location";
      if (topDest) topDest.value = (end && end.display) || this.currentDestination;
      topBar.style.display = "block";
    }

    if (previewSheet) {
      // Title
      const modeTitle = document.getElementById("gmaps-preview-mode-title");
      if (modeTitle) {
        modeTitle.textContent = (this.currentMode === "walking") ? "Walk" : "Drive";
      }

      // Mode Tab Times: ONLY Car and Walk
      const driveTime = document.getElementById("gmaps-tab-drive-time");
      const walkTime = document.getElementById("gmaps-tab-walk-time");
      if (driveTime && driveRoute) driveTime.textContent = driveRoute.duration;
      if (walkTime && walkRoute) walkTime.textContent = walkRoute.duration;

      // Active Tab Highlight
      const modeTabs = previewSheet.querySelectorAll(".gmaps-mode-tab");
      modeTabs.forEach(t => {
        t.classList.toggle("active", t.dataset.mode === this.currentMode);
      });

      // Stats Summary Block
      const durationEl = document.getElementById("gmaps-preview-duration");
      const distEl = document.getElementById("gmaps-preview-dist");
      if (durationEl && activeRoute) durationEl.textContent = activeRoute.duration;
      if (distEl && activeRoute) distEl.textContent = `(${activeRoute.distance})`;

      previewSheet.style.display = "block";
    }
  }

  closeRouteAndReset() {
    clearTimeout(this.debounceTimer);
    this.currentRouteData = null;

    // 1. Remove highlighted route polyline, waypoints, and ETA badge from map
    if (window.CampusMap) {
      if (typeof window.CampusMap.clearRoute === "function") window.CampusMap.clearRoute();
    }

    // 2. Hide Google Maps route preview sheet and floating topbar
    this.hideRoutePreview();

    // 3. Preserve the user's destination input (do not wipe inputs on back)
    this.updateDestinationState(this.currentDestination);

    // 4. Return to default view (Map)
    if (window.UIController) {
      window.UIController.closeLeftPanels();
      window.UIController.switchView("map");
    }
  }

  exitDirections() {
    if (history.state && history.state.depth > 0) {
      try {
        history.back();
        return;
      } catch (err) {}
    }
    this.closeRouteAndReset();
  }

  hideRoutePreview() {
    document.body.classList.remove("gmaps-route-active");
    const topBar = document.getElementById("gmaps-route-topbar");
    const previewSheet = document.getElementById("gmaps-route-preview-sheet");
    if (topBar) topBar.style.display = "none";
    if (previewSheet) previewSheet.style.display = "none";
  }

  updateModePillEstimates(distanceStr) {
    const distNum = parseInt(distanceStr) || 600;
    const walkMin = Math.max(1, Math.round(distNum / 75));
    const kartMin = Math.max(1, Math.round(distNum / 220));

    const walkBtn = document.querySelector(".mode-tab-btn[data-mode='walking'] span");
    const kartBtn = document.querySelector(".mode-tab-btn[data-mode='kart'] span");

    if (walkBtn) walkBtn.textContent = `🚶 ${walkMin} min`;
    if (kartBtn) kartBtn.textContent = `🛺 ${kartMin} min`;
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
    const detourPath = this.roadGraph.findPath(31.260585, 75.707280, 31.252543, 75.704916, this.currentMode);

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
