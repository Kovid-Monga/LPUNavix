/**
 * LPU Map - Application Bootstrap & Orchestrator
 */

document.addEventListener("DOMContentLoaded", () => {
  console.log("🚀 Initializing LPU Map Application...");

  // 1. Initialize MapLibre Campus Map
  if (window.CampusMap) {
    window.CampusMap.init();
  }

  // 2. Initialize UI Panels & Search
  if (window.UIController) {
    window.UIController.init();
  }

  // 3. Initialize Turn-by-Turn Directions Controller
  if (window.Directions) {
    window.Directions.init();
  }

  // 4. Initialize AI Assistant Controller
  if (window.AssistantController) {
    const assistant = new AssistantController({ uiController: window.UIController });
    assistant.init();
    window.assistant = assistant;
    if (assistant.panel) {
      assistant.panel.classList.add("assistant-panel--hidden");
    }
  }

  // 5. Initialize Live Kart Tracking Controller
  if (window.KartTracker) {
    window.KartTracker.init();
  }

  // 6. Handle Shared Location Deep Links (?loc=... or #loc=...)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    let targetLocId = urlParams.get("loc") || urlParams.get("location") || urlParams.get("place");
    if (!targetLocId && window.location.hash) {
      const hashMatch = window.location.hash.match(/[#&]loc=([^&]+)/);
      if (hashMatch) targetLocId = decodeURIComponent(hashMatch[1]);
    }

    if (targetLocId) {
      const cleanTarget = String(targetLocId).trim().toLowerCase();
      const allLocs = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (window.CAMPUS_LOCATIONS || []);
      const matched = allLocs.find(l => 
        (l.id && l.id.toLowerCase() === cleanTarget) ||
        (l.name && l.name.toLowerCase() === cleanTarget) ||
        (l.location_notation && l.location_notation.toLowerCase() === cleanTarget)
      );

      if (matched && window.UIController) {
        setTimeout(() => {
          window.UIController.showLocationDetails(matched, false, "minimized");
        }, 350);
      }
    }
  } catch (err) {
    console.warn("[LPUNavix] Error parsing deep link loc param:", err);
  }

  console.log("✨ LPU Map Frontend Initialized Successfully!");
});
