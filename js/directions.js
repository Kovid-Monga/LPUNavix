/**
 * LPU Map - Directions Controller (Panel 2 & Panel 6)
 * Handles turn-by-turn routing, multi-modal travel switches, and smart detour rerouting.
 */

class DirectionsController {
  constructor() {
    this.currentMode = "walking";
    this.currentOrigin = "Main Gate";
    this.currentDestination = "Block 18";
  }

  init() {
    this.bindEvents();
  }

  async geocodePlace(name) {
    // 1. First check local campus data inside LPU
    const local = getAllCampusLocations().find(l => 
      l.name.toLowerCase().includes(name.toLowerCase()) || 
      l.id.toLowerCase().includes(name.toLowerCase())
    );
    if (local && isPointInPolygon([local.lat, local.lng], LPU_BOUNDARY)) {
      return { lat: local.lat, lon: local.lng, display: local.name };
    }

    // 2. Append LPU campus qualification to prevent searching outside LPU
    const text = encodeURIComponent(`${name}, Lovely Professional University, Phagwara, Punjab`);
    const url = `https://nominatim.openstreetmap.org/search?q=${text}&format=json&limit=1`;
    const response = await fetch(url, {
      headers: { 'Accept-Language': 'en', 'User-Agent': 'LPUMap/1.0' },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error('Geocoding failed');
    const data = await response.json();
    if (!data || data.length === 0) throw new Error('Location not found');

    const lat = parseFloat(data[0].lat);
    const lon = parseFloat(data[0].lon);

    // Verify coordinates are strictly inside LPU boundary
    if (!isPointInPolygon([lat, lon], LPU_BOUNDARY)) {
      // Fallback to closest campus center
      return { lat: CAMPUS_CENTER[0], lon: CAMPUS_CENTER[1], display: name };
    }

    return { lat, lon, display: data[0].display_name };
  }

  async fetchRouteFromOSRM(start, end, mode = 'foot') {
    const isVehicleMode = mode === 'kart' || mode === 'bicycle';
    const profile = isVehicleMode ? 'driving' : 'foot';
    const url = `https://router.project-osrm.org/route/v1/${profile}/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson&steps=true&annotations=distance,duration`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });

    if (!response.ok) throw new Error('Route request failed');
    const data = await response.json();
    const route = data.routes && data.routes[0];
    if (!route) throw new Error('No route available');

    const coords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const steps = (route.legs && route.legs[0] && route.legs[0].steps) || [];

    return {
      path: coords,
      steps: steps.map((step, index) => ({
        instruction: step.maneuver && step.maneuver.modifier
          ? `Turn ${step.maneuver.modifier} toward ${step.name || 'route'}`
          : (step.name ? `Continue along ${step.name}` : (index === 0 ? 'Start route' : 'Continue')),
        distance: `${Math.round(step.distance)} m`,
        icon: step.maneuver && (step.maneuver.type === 'depart' || step.maneuver.type === 'arrive') ? 'map-pin' : 'corner-up-right'
      })),
      distance: `${Math.round(route.distance)} m`,
      duration: `${Math.round(route.duration / 60)} min`,
      roadTypes: ['living_street', 'residential', 'service', 'single_lane', 'oneway', 'footway']
    };
  }

  bindEvents() {
    // Mode tab buttons
    const modeTabs = document.querySelectorAll(".mode-tab-btn");
    modeTabs.forEach(tab => {
      tab.addEventListener("click", (e) => {
        modeTabs.forEach(t => t.classList.remove("active"));
        const btn = e.currentTarget;
        btn.classList.add("active");
        this.currentMode = btn.dataset.mode || "walking";
        this.updateRouteDisplay();
      });
    });

    // Swap locations button
    const swapBtn = document.getElementById("swap-directions-btn");
    if (swapBtn) {
      swapBtn.addEventListener("click", () => {
        const originInput = document.getElementById("direction-origin-input");
        const destInput = document.getElementById("direction-dest-input");
        if (originInput && destInput) {
          const temp = originInput.value;
          originInput.value = destInput.value;
          destInput.value = temp;
          this.currentOrigin = originInput.value;
          this.currentDestination = destInput.value;
        }
      });
    }

    // Start navigation button
    const startNavBtn = document.getElementById("start-nav-btn");
    if (startNavBtn) {
      startNavBtn.addEventListener("click", () => {
        if (window.UIController) {
          window.UIController.startActiveNavigation(this.currentDestination || "Block 18", "6 min", "450 m");
        }
      });
    }
  }

  async showDirections(origin = "Main Gate", dest = "Block 18") {
    this.currentOrigin = origin;
    this.currentDestination = dest;

    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    if (originInput) originInput.value = origin;
    if (destInput) destInput.value = dest;

    try {
      const start = await this.geocodePlace(origin || 'Main Gate');
      const end = await this.geocodePlace(dest || 'Block 18');
      const route = await this.fetchRouteFromOSRM(start, end, this.currentMode);

      this.renderSteps(route.steps.length ? route.steps : SAMPLE_DIRECTIONS.steps);
      if (window.CampusMap) {
        window.CampusMap.drawRoute(route.path);
      }
      const summaryCard = document.querySelector('.route-summary-card');
      if (summaryCard) {
        const title = summaryCard.querySelector('.route-summary-title');
        const stats = summaryCard.querySelector('.route-summary-stats');
        if (title) title.textContent = this.currentMode === 'kart' ? 'Kart / Shuttle Route' : (this.currentMode === 'bicycle' ? 'Bicycle / Cycleway Route' : 'Best Route (Walking)');
        if (stats) stats.textContent = `${route.distance} • ${route.duration}`;
      }
    } catch (error) {
      console.warn('OSRM route unavailable, using sample route fallback:', error);
      this.renderSteps(SAMPLE_DIRECTIONS.steps);
      if (window.CampusMap) {
        window.CampusMap.drawRoute(SAMPLE_DIRECTIONS.path);
      }
    }
  }

  showDetourRerouting() {
    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    if (originInput) originInput.value = DETOUR_DIRECTIONS.origin;
    if (destInput) destInput.value = DETOUR_DIRECTIONS.destination;

    // Draw rerouted path with closed path dashed line
    if (window.CampusMap) {
      window.CampusMap.drawRoute(
        DETOUR_DIRECTIONS.recommendedPath, 
        true, 
        DETOUR_DIRECTIONS.closedPath
      );
    }
  }

  renderSteps(steps) {
    const stepsListEl = document.getElementById("turn-steps-list");
    if (!stepsListEl) return;

    stepsListEl.innerHTML = "";

    steps.forEach((step, idx) => {
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

  updateRouteDisplay() {
    const summaryCard = document.querySelector(".route-summary-card");
    if (!summaryCard) return;

    if (this.currentMode === "walking") {
      summaryCard.querySelector(".route-summary-title").textContent = "Best Route (Walking)";
      summaryCard.querySelector(".route-summary-stats").textContent = "650 m • 8 min";
    } else if (this.currentMode === "bicycle") {
      summaryCard.querySelector(".route-summary-title").textContent = "Bicycle / Cycleway Route";
      summaryCard.querySelector(".route-summary-stats").textContent = "700 m • 5 min";
    } else if (this.currentMode === "kart") {
      summaryCard.querySelector(".route-summary-title").textContent = "Kart / Shuttle Route";
      summaryCard.querySelector(".route-summary-stats").textContent = "800 m • 3 min (Near Stop)";
    }
  }
}

// Global Directions instance
window.Directions = new DirectionsController();
