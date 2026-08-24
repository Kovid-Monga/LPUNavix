/**
 * LPU Map - Live Kart Tracking Controller (Panel 4)
 * Manages active shuttle karts, real-time GPS locations from tracking server,
 * and live Leaflet map markers.
 *
 * GPS smoothing strategy:
 *  1. EMA (Exponential Moving Average) — blends new raw GPS with the last
 *     smoothed position to kill high-frequency jitter.
 *  2. Deadband filter — ignores updates smaller than MIN_MOVE_DEG (~3 m)
 *     so a stationary kart doesn't wobble on the map.
 *  3. Animated interpolation — marker glides to the new position over
 *     ANIM_DURATION_MS instead of teleporting instantly.
 */

// ─── Tuning knobs ────────────────────────────────────────────────────────────
// EMA smoothing factor: 0.0 = frozen, 1.0 = raw GPS, 0.25 is a good balance.
const EMA_ALPHA        = 0.25;

// Ignore updates where the kart moved less than this in degrees (~3 m).
const MIN_MOVE_DEG     = 0.00003;

// How long (ms) the marker takes to glide to its new position.
const ANIM_DURATION_MS = 2500;
// ─────────────────────────────────────────────────────────────────────────────

class KartTrackingController {
  constructor() {
    this.activeKartMarkers = {};  // id → Leaflet marker
    this.smoothedPositions = {};  // id → { lat, lng }  (EMA state)
    this.animationFrames   = {};  // id → rAF handle
    this.selectedKartId    = null;
    this.pollInterval      = null;

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

  // ── EMA smoothing ──────────────────────────────────────────────────────────
  // Blends the raw GPS reading with the previous smoothed value.
  _smooth(id, rawLat, rawLng) {
    const prev = this.smoothedPositions[id];
    if (!prev) {
      this.smoothedPositions[id] = { lat: rawLat, lng: rawLng };
      return this.smoothedPositions[id];
    }
    const smoothed = {
      lat: prev.lat + EMA_ALPHA * (rawLat - prev.lat),
      lng: prev.lng + EMA_ALPHA * (rawLng - prev.lng)
    };
    this.smoothedPositions[id] = smoothed;
    return smoothed;
  }

  // ── Deadband check ─────────────────────────────────────────────────────────
  // Returns true only if the kart moved more than MIN_MOVE_DEG (~3 m).
  _hasMoved(marker, newLat, newLng) {
    const cur = marker.getLatLng();
    return Math.abs(cur.lat - newLat) > MIN_MOVE_DEG ||
           Math.abs(cur.lng - newLng) > MIN_MOVE_DEG;
  }

  // ── Smooth animated marker movement ───────────────────────────────────────
  // Interpolates the marker from its current position to [toLat, toLng]
  // over ANIM_DURATION_MS using requestAnimationFrame with ease-out cubic.
  _animateMarker(id, toLat, toLng) {
    const marker = this.activeKartMarkers[id];
    if (!marker) return;

    if (this.animationFrames[id]) {
      cancelAnimationFrame(this.animationFrames[id]);
      delete this.animationFrames[id];
    }

    const from      = marker.getLatLng();
    const startTime = performance.now();

    const step = (now) => {
      const elapsed = now - startTime;
      const t       = Math.min(elapsed / ANIM_DURATION_MS, 1);
      const ease    = 1 - Math.pow(1 - t, 3); // ease-out cubic

      marker.setLatLng([
        from.lat + (toLat - from.lat) * ease,
        from.lng + (toLng - from.lng) * ease
      ]);

      if (t < 1) {
        this.animationFrames[id] = requestAnimationFrame(step);
      } else {
        delete this.animationFrames[id];
      }
    };

    this.animationFrames[id] = requestAnimationFrame(step);
  }

  // ── Main update ────────────────────────────────────────────────────────────
  updateKarts(activeKarts) {
    const activeIds  = new Set(activeKarts.map(k => k.id));
    const kartsLayer = window.CampusMap ? window.CampusMap.kartsLayer : null;
    const hadNoKartMarkers = Object.keys(this.activeKartMarkers).length === 0;

    activeKarts.forEach(k => {
      // 1. Smooth the raw GPS coordinate via EMA.
      const { lat, lng } = this._smooth(k.id, k.lat, k.lng);

      const timeStr      = k.timestamp ? new Date(k.timestamp).toLocaleTimeString() : "Live";
      const popupContent = `<b>${k.id}</b><br>Last update: ${timeStr}`;

      if (this.activeKartMarkers[k.id]) {
        // 2. Only animate if the kart moved enough (deadband filter).
        if (this._hasMoved(this.activeKartMarkers[k.id], lat, lng)) {
          this._animateMarker(k.id, lat, lng);
        }
        this.activeKartMarkers[k.id].setPopupContent(popupContent);

      } else if (kartsLayer) {
        // 3. First sighting — create the marker.
        const kartIcon = L.icon({
          iconUrl: "kar.png",
          iconSize: [56, 56],
          iconAnchor: [28, 28],
          popupAnchor: [0, -28]
        });

        const marker = L.marker([lat, lng], { icon: kartIcon })
          .addTo(kartsLayer)
          .bindPopup(popupContent);

        marker.on("click", () => this.focusKart(k));
        this.activeKartMarkers[k.id] = marker;
      }
    });

    // During testing, move the map to the first received kart if it is outside LPU.
    if (hadNoKartMarkers && activeKarts.length > 0 && window.CampusMap) {
      const firstKart = activeKarts[0];
      window.CampusMap.flyToLocation(firstKart.lat, firstKart.lng, 16);
    }

    // 4. Remove markers for karts that are no longer active.
    Object.keys(this.activeKartMarkers).forEach(id => {
      if (!activeIds.has(id)) {
        if (this.animationFrames[id]) {
          cancelAnimationFrame(this.animationFrames[id]);
          delete this.animationFrames[id];
        }
        if (kartsLayer) kartsLayer.removeLayer(this.activeKartMarkers[id]);
        delete this.activeKartMarkers[id];
        delete this.smoothedPositions[id];
      }
    });

    // 5. Update Active Count Badge in UI
    const subtitleEl = document.querySelector("#karts-panel .panel-subtitle-text");
    if (subtitleEl) {
      subtitleEl.textContent = `${activeKarts.length} Active Shuttle${activeKarts.length === 1 ? "" : "s"}`;
    }

    // 6. Update Kart Cards in Side Panel
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
            <div class="kart-current-loc">Lat: ${kart.lat.toFixed(5)}, Lng: ${kart.lng.toFixed(5)}</div>
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

