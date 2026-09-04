/**
 * LPU Map - Application Bootstrap & Orchestrator
 */

document.addEventListener("DOMContentLoaded", () => {
  console.log("🚀 Initializing LPU Map Application...");

  // 1. Initialize Leaflet Campus Map
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
  if (window.Assistant) {
    window.Assistant.init();
  }

  // 5. Initialize Live Kart Tracking Controller
  if (window.KartTracker) {
    window.KartTracker.init();
  }

  console.log("✨ LPU Map Frontend Initialized Successfully!");
});
