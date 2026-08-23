/**
 * LPU Map - Live Kart Tracking Controller (Panel 4)
 * Manages active shuttle karts, route polylines, and live GPS simulator.
 */

class KartTrackingController {
  constructor() {
    this.activeKartMarkers = {};
    this.selectedKartId = null;
    this.animationTimer = null;
  }

  init() {
    this.renderKartList();
    this.renderKartsOnMap();
  }

  renderKartList() {
    const listEl = document.getElementById("karts-list-container");
    if (!listEl) return;

    listEl.innerHTML = "";

    if (!Array.isArray(CAMPUS_KARTS) || CAMPUS_KARTS.length === 0) {
      listEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">No active karts on route</div>`;
      return;
    }

    CAMPUS_KARTS.forEach(kart => {
      const card = document.createElement("div");
      card.className = "kart-item-card";
      card.dataset.id = kart.id;

      card.innerHTML = `
        <div class="kart-info-left">
          <div class="kart-icon-box">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
          </div>
          <div>
            <div class="kart-name">Kart</div>
            <div class="kart-current-loc">${kart.location}</div>
          </div>
        </div>
        <div class="kart-eta-tag">${kart.eta}</div>
      `;

      card.addEventListener("click", () => {
        document.querySelectorAll(".kart-item-card").forEach(c => c.classList.remove("active"));
        card.classList.add("active");
        this.focusKart(kart);
      });

      listEl.appendChild(card);
    });
  }

  renderKartsOnMap() {
    if (!window.CampusMap || !window.CampusMap.kartsLayer) return;

    window.CampusMap.kartsLayer.clearLayers();

    CAMPUS_KARTS.forEach(kart => {
      const kartIconHtml = `
        <div class="kart-marker" title="Kart">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
        </div>
      `;

      const kartIcon = L.divIcon({
        className: "kart-marker-div",
        html: kartIconHtml,
        iconSize: [80, 30],
        iconAnchor: [40, 15]
      });

      const marker = L.marker(kart.coords, { icon: kartIcon });
      marker.on("click", () => this.focusKart(kart));

      window.CampusMap.kartsLayer.addLayer(marker);
      this.activeKartMarkers[kart.id] = marker;
    });
  }

  focusKart(kart) {
    this.selectedKartId = kart.id;
    if (window.CampusMap) {
      window.CampusMap.flyToLocation(kart.coords[0], kart.coords[1], 17);
      
      // Draw designated kart route line
      if (kart.route) {
        L.polyline(kart.route, {
          color: "#10b981",
          weight: 4,
          opacity: 0.8,
          dashArray: "6, 8"
        }).addTo(window.CampusMap.routesLayer);
      }
    }
  }
}

// Global Kart Tracking instance
window.KartTracker = new KartTrackingController();
