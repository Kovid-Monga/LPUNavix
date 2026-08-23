/**
 * LPU Map - Live Kart Tracking Controller (Panel 4)
 * Manages active shuttle karts, real-time GPS locations from tracking server,
 * and live Leaflet map markers.
 */

class KartTrackingController {
  constructor() {
    this.activeKartMarkers = {};
    this.selectedKartId = null;
    this.pollInterval = null;
    // Relative URL works because FastAPI serves both the frontend and
    // the /api/* endpoints on the same port (3000 locally, or via ngrok).
    this.apiUrl = "/api/locations";
  }

  init() {
    this.refreshKarts();
    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => this.refreshKarts(), 3000);
    }
  }

  async refreshKarts() {
    try {
      const res = await fetch(this.apiUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const activeKarts = await res.json();
      this.updateKarts(activeKarts);
    } catch (err) {
      this.handleOffline();
    }
  }

  updateKarts(activeKarts) {
    const activeIds = new Set(activeKarts.map(k => k.id));
    const kartsLayer = window.CampusMap ? window.CampusMap.kartsLayer : null;

    // 1. Add new markers or update existing ones
    activeKarts.forEach(k => {
      const latlng = [k.lat, k.lng];
      const timeStr = k.timestamp ? new Date(k.timestamp).toLocaleTimeString() : "Live";
      const popupContent = `<b>${k.id}</b><br>Last update: ${timeStr}`;

      if (this.activeKartMarkers[k.id]) {
        this.activeKartMarkers[k.id].setLatLng(latlng);
        this.activeKartMarkers[k.id].setPopupContent(popupContent);
      } else if (kartsLayer) {
        const kartIconHtml = `
          <div class="kart-marker" title="${k.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
            <span>${k.id}</span>
          </div>
        `;

        const kartIcon = L.divIcon({
          className: "kart-marker-div",
          html: kartIconHtml,
          iconSize: [80, 30],
          iconAnchor: [40, 15]
        });

        const marker = L.marker(latlng, { icon: kartIcon })
          .addTo(kartsLayer)
          .bindPopup(popupContent);

        marker.on("click", () => this.focusKart(k));
        this.activeKartMarkers[k.id] = marker;
      }
    });

    // 2. Remove markers for karts that dropped out (no longer active)
    Object.keys(this.activeKartMarkers).forEach(id => {
      if (!activeIds.has(id)) {
        if (kartsLayer) {
          kartsLayer.removeLayer(this.activeKartMarkers[id]);
        }
        delete this.activeKartMarkers[id];
      }
    });

    // 3. Update Active Count Badge in UI
    const subtitleEl = document.querySelector("#karts-panel .panel-subtitle-text");
    if (subtitleEl) {
      subtitleEl.textContent = `${activeKarts.length} Active Shuttle${activeKarts.length === 1 ? "" : "s"}`;
    }

    // 4. Update Kart Cards in Side Panel
    this.renderKartList(activeKarts);
  }

  handleOffline() {
    const subtitleEl = document.querySelector("#karts-panel .panel-subtitle-text");
    if (subtitleEl && Object.keys(this.activeKartMarkers).length === 0) {
      subtitleEl.textContent = "0 Active Shuttles";
    }
    const listEl = document.getElementById("karts-list-container");
    if (listEl && Object.keys(this.activeKartMarkers).length === 0) {
      listEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">No active karts on route<br><span style="font-size:11px;opacity:0.75;">Waiting for live GPS updates from tracking server...</span></div>`;
    }
  }

  renderKartList(activeKarts) {
    const listEl = document.getElementById("karts-list-container");
    if (!listEl) return;

    listEl.innerHTML = "";

    if (!Array.isArray(activeKarts) || activeKarts.length === 0) {
      listEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">No active karts on route<br><span style="font-size:11px;opacity:0.75;">Waiting for live GPS updates from tracking server...</span></div>`;
      return;
    }

    activeKarts.forEach(kart => {
      const card = document.createElement("div");
      card.className = "kart-item-card" + (this.selectedKartId === kart.id ? " active" : "");
      card.dataset.id = kart.id;

      const timeStr = kart.timestamp ? new Date(kart.timestamp).toLocaleTimeString() : "Live";

      card.innerHTML = `
        <div class="kart-info-left">
          <div class="kart-icon-box">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
          </div>
          <div>
            <div class="kart-name">${kart.id}</div>
            <div class="kart-current-loc">Lat: ${kart.lat.toFixed(4)}, Lng: ${kart.lng.toFixed(4)}</div>
          </div>
        </div>
        <div class="kart-eta-tag">${timeStr}</div>
      `;

      card.addEventListener("click", () => {
        document.querySelectorAll(".kart-item-card").forEach(c => c.classList.remove("active"));
        card.classList.add("active");
        this.focusKart(kart);
      });

      listEl.appendChild(card);
    });
  }

  focusKart(kart) {
    this.selectedKartId = kart.id;
    if (window.CampusMap && window.CampusMap.map) {
      // Fly directly using Leaflet map to avoid the strict boundary
      // polygon check in flyToLocation() that can block kart coords.
      window.CampusMap.map.flyTo([kart.lat, kart.lng], 17.5, {
        animate: true,
        duration: 1.2
      });
      if (this.activeKartMarkers[kart.id]) {
        this.activeKartMarkers[kart.id].openPopup();
      }
    }
  }

  // Alias used by ui.js when switching to the Karts panel
  renderKartsOnMap() {
    this.refreshKarts();
  }
}

// Global Kart Tracking instance
window.KartTracker = new KartTrackingController();
