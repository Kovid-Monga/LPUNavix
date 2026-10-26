/**
 * js/admin_blocks.js — Admin Portal & Real-time Road Closures for LPUNavix
 * ========================================================================
 * - Admin authentication (Login, Logout, Session check)
 * - Road & Footpath blocking on the map (Clicked section or Entire way)
 * - MapLibre hazard styling (red hazard dash + barrier icons 🚧)
 * - Real-time sync with polling (30s interval)
 * - Smart rerouting detection for active routes
 * - Dynamic Campus Road Status panel rendering
 */

class AdminBlocksController {
  constructor() {
    this.adminToken = localStorage.getItem("lpunavix_admin_token") || null;
    this.adminUser = localStorage.getItem("lpunavix_admin_user") || null;
    this.isPlottingMode = false;
    this.activeBlocks = [];
    this.mapMarkers = [];
    this.pendingClickFeature = null;
    this.pollInterval = null;
  }

  init() {
    this.checkSession();
    this.initMapHazardLayers();
    this.fetchBlocks();
    this.startPolling();
    this.bindEvents();
    this.updateAdminButtonUI();
  }

  isPlottingActive() {
    return this.isPlottingMode && !!this.adminToken;
  }

  // ---------------- Authentication ----------------

  async checkSession() {
    if (!this.adminToken) {
      this.updateAdminButtonUI();
      return;
    }
    try {
      const res = await fetch("/api/admin/me", {
        headers: { Authorization: `Bearer ${this.adminToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        this.adminUser = data.username || "admin";
        localStorage.setItem("lpunavix_admin_user", this.adminUser);
      } else {
        this.clearSession();
      }
    } catch (e) {
      // Offline / network fallback
    }
    this.updateAdminButtonUI();
  }

  clearSession() {
    this.adminToken = null;
    this.adminUser = null;
    this.isPlottingMode = false;
    localStorage.removeItem("lpunavix_admin_token");
    localStorage.removeItem("lpunavix_admin_user");
    this.updateAdminButtonUI();
    this.updatePlottingToolbar();
  }

  async login(username, password) {
    const errorEl = document.getElementById("admin-login-error");
    if (errorEl) errorEl.style.display = "none";

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || "Login failed");
      }

      this.adminToken = data.token;
      this.adminUser = data.username;
      localStorage.setItem("lpunavix_admin_token", this.adminToken);
      localStorage.setItem("lpunavix_admin_user", this.adminUser);

      this.closeModal("admin-login-modal");
      this.updateAdminButtonUI();
      this.showToast(`Logged in as ${this.adminUser}`);
      this.openAdminPanel();
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message;
        errorEl.style.display = "block";
      }
    }
  }

  async logout() {
    if (this.adminToken) {
      try {
        await fetch("/api/admin/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.adminToken}` }
        });
      } catch (e) {}
    }
    this.clearSession();
    this.closeModal("admin-panel-modal");
    this.showToast("Logged out successfully");
  }

  updateAdminButtonUI() {
    const mobileBtn = document.getElementById("mobile-admin-btn");
    const desktopBtn = document.getElementById("desktop-admin-btn");
    const isLoggedIn = !!this.adminToken;

    [mobileBtn, desktopBtn].forEach(btn => {
      if (!btn) return;
      if (isLoggedIn) {
        btn.classList.add("admin-logged-in");
        btn.setAttribute("title", `Admin Portal (${this.adminUser})`);
      } else {
        btn.classList.remove("admin-logged-in");
        btn.setAttribute("title", "Admin Portal");
      }
    });
  }

  // ---------------- UI & Modals ----------------

  openAdminModal() {
    if (this.adminToken) {
      this.openAdminPanel();
    } else {
      this.openLoginModal();
    }
  }

  openLoginModal() {
    const modal = document.getElementById("admin-login-modal");
    if (!modal) return;
    const errorEl = document.getElementById("admin-login-error");
    if (errorEl) errorEl.style.display = "none";
    const userInp = document.getElementById("admin-user-input");
    const passInp = document.getElementById("admin-pass-input");
    if (userInp) userInp.value = "";
    if (passInp) passInp.value = "";
    modal.style.display = "flex";
  }

  openAdminPanel() {
    const modal = document.getElementById("admin-panel-modal");
    if (!modal) return;
    this.renderAdminBlocksList();
    this.updatePlottingToolbar();
    modal.style.display = "flex";
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = "none";
  }

  togglePlottingMode() {
    this.isPlottingMode = !this.isPlottingMode;
    this.updatePlottingToolbar();
    if (this.isPlottingMode) {
      this.closeModal("admin-panel-modal");
      this.showToast("🚧 Block Mode Active: Click any road or footpath on the map", 4500);
    } else {
      this.showToast("Block Mode disabled");
    }
  }

  updatePlottingToolbar() {
    const bar = document.getElementById("admin-plot-floating-bar");
    if (!bar) return;
    if (this.isPlottingMode && this.adminToken) {
      bar.style.display = "flex";
    } else {
      bar.style.display = "none";
    }
  }

  // ---------------- Map Hazards & Markers ----------------

  initMapHazardLayers() {
    const mapCtrl = window.CampusMap;
    if (!mapCtrl || !mapCtrl.mapReady || !mapCtrl.map) {
      setTimeout(() => this.initMapHazardLayers(), 500);
      return;
    }
    // Clean up any legacy line layers if they exist
    const map = mapCtrl.map;
    if (map.getLayer("campus-blocks-line")) map.removeLayer("campus-blocks-line");
    if (map.getLayer("campus-blocks-casing")) map.removeLayer("campus-blocks-casing");
    if (map.getSource("campus-road-blocks")) map.removeSource("campus-road-blocks");

    this.updateMapHazardSource();
  }

  updateMapHazardSource() {
    const mapCtrl = window.CampusMap;
    if (!mapCtrl || !mapCtrl.map || !mapCtrl.mapReady) return;
    const map = mapCtrl.map;

    // Remove existing HTML markers
    if (this.mapMarkers && this.mapMarkers.length > 0) {
      this.mapMarkers.forEach(m => m.remove());
    }
    this.mapMarkers = [];

    // Create a 🚧 map marker for every active closure
    this.activeBlocks.forEach(b => {
      let lat = null;
      let lng = null;

      if (b.markerCoord && Array.isArray(b.markerCoord) && b.markerCoord.length === 2) {
        lat = b.markerCoord[0];
        lng = b.markerCoord[1];
      } else if (Array.isArray(b.coords) && b.coords.length >= 2) {
        lat = (b.coords[0][0] + b.coords[1][0]) / 2;
        lng = (b.coords[0][1] + b.coords[1][1]) / 2;
      }

      if (lat === null || lng === null) return;

      const wrapper = document.createElement("div");
      wrapper.className = "campus-closure-marker-wrapper";
      wrapper.style.zIndex = "2400";

      const pill = document.createElement("div");
      pill.className = "campus-closure-marker-pill";
      pill.innerHTML = "🚧";
      pill.setAttribute("role", "button");
      pill.setAttribute("aria-label", `Road closure: ${b.name}`);
      wrapper.appendChild(pill);

      const modes = b.modes || [];
      const modeText = modes.includes("walking") && !modes.includes("kart")
        ? "Walking (Pedestrians)"
        : (modes.includes("kart") && !modes.includes("walking") ? "Karts & Vehicles" : "All Modes");

      const popup = new maplibregl.Popup({ offset: 16, closeButton: true }).setHTML(`
        <div style="font-family:inherit;padding:4px 6px;min-width:180px;">
          <div style="font-weight:700;color:#dc2626;font-size:13px;display:flex;align-items:center;gap:6px;">
            <span>🚧</span> <span>CLOSED SECTION</span>
          </div>
          <div style="font-weight:700;font-size:12.5px;margin-top:4px;color:#0f172a;">${b.name || "Campus Pathway"}</div>
          <div style="font-size:11.5px;color:#64748b;margin-top:3px;">Reason: ${b.reason || "Maintenance / Event"}</div>
          <div style="font-size:11px;color:#b91c1c;margin-top:3px;font-weight:600;">Affected: ${modeText}</div>
          ${this.adminToken ? `
            <div style="margin-top:8px;padding-top:6px;border-top:1px solid #e2e8f0;">
              <button style="width:100%;background:#fee2e2;color:#dc2626;border:1px solid #fecaca;padding:5px 10px;border-radius:6px;font-size:11.5px;font-weight:700;cursor:pointer;" onclick="window.AdminBlocks.deleteBlock('${b.id}')">
                Reopen Section
              </button>
            </div>
          ` : ""}
        </div>
      `);

      const marker = new maplibregl.Marker({ element: wrapper, anchor: "center" })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);

      this.mapMarkers.push(marker);
    });
  }

  // ---------------- Map Feature Click / Plotting ----------------

  handleMapFeatureClick(event, featureType) {
    if (!this.isPlottingActive()) return false;

    const clickLngLat = event.lngLat;
    if (!clickLngLat) return false;
    const clickCoord = [clickLngLat.lat, clickLngLat.lng];

    const graph = window.Directions ? window.Directions.roadGraph : null;
    if (!graph || !graph.segments || graph.segments.length === 0) return false;

    // Search ALL navigable segments in the routing graph nearest to the click point
    let bestSegment = null;
    let minDist = Infinity;
    let bestProj = null;

    for (const seg of graph.segments) {
      const proj = graph.projectPointOnSegment(clickCoord[0], clickCoord[1], seg.p1[0], seg.p1[1], seg.p2[0], seg.p2[1]);
      const d = graph.haversineDistance(clickCoord[0], clickCoord[1], proj.lat, proj.lng);
      if (d < minDist) {
        minDist = d;
        bestSegment = seg;
        bestProj = proj;
      }
    }

    if (!bestSegment || minDist > 40) {
      this.showToast("Please click directly on or near a campus road or footpath", 2500);
      return false;
    }

    // Determine footpath vs road from the actual graph segment
    const isFootpath = ['footway', 'path', 'steps', 'pedestrian'].includes(bestSegment.highway) || !bestSegment.isVeh;
    const autoModes = isFootpath ? ["walking"] : ["kart", "drive"];
    const modeLabel = isFootpath ? "Walking (Pedestrians)" : "Karts & Vehicles";
    const roadName = bestSegment.name || (isFootpath ? "Campus Footpath" : "Campus Roadway");

    this.pendingClickFeature = {
      name: roadName,
      wayId: bestSegment.wayId,
      sectionSegment: {
        segId: bestSegment.segId,
        coords: [bestSegment.p1, bestSegment.p2],
        dist: Math.round(bestSegment.dist || 25)
      },
      clickedCoord: [bestProj.lat, bestProj.lng],
      autoModes: autoModes,
      modeLabel: modeLabel,
      isFootpath: isFootpath
    };

    this.openBlockConfirmationModal();
    return true;
  }

  openBlockConfirmationModal() {
    const data = this.pendingClickFeature;
    if (!data) return;
    const modal = document.getElementById("admin-block-confirm-modal");
    if (!modal) return;

    const titleEl = document.getElementById("block-confirm-road-name");
    if (titleEl) titleEl.textContent = data.name;

    const scopeInfo = document.getElementById("block-scope-info");
    if (scopeInfo) scopeInfo.textContent = `Clicked Section (~${data.sectionSegment.dist} m)`;

    const modeInfo = document.getElementById("block-mode-info");
    if (modeInfo) modeInfo.textContent = data.modeLabel;

    const reasonInp = document.getElementById("block-reason-input");
    if (reasonInp) {
      reasonInp.value = data.isFootpath ? "Footpath maintenance / Repair" : "Road maintenance / Construction work";
    }

    modal.style.display = "flex";
  }

  async confirmCreateBlock() {
    const data = this.pendingClickFeature;
    if (!data || !this.adminToken) return;

    const reasonInp = document.getElementById("block-reason-input");
    const reason = (reasonInp && reasonInp.value.trim()) || (data.isFootpath ? "Footpath closed" : "Road closed");

    const expirySel = document.getElementById("block-expiry-select");
    let expiresAt = null;
    if (expirySel && expirySel.value !== "never") {
      const hours = parseInt(expirySel.value, 10);
      if (hours > 0) {
        expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
      }
    }

    // Single section scope & auto travel modes
    const payload = {
      name: data.name,
      type: "segment",
      refId: data.sectionSegment.segId,
      wayId: data.wayId,
      coords: data.sectionSegment.coords,
      markerCoord: data.clickedCoord,
      reason,
      modes: data.autoModes,
      expiresAt
    };

    try {
      const res = await fetch("/api/admin/blocks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.adminToken}`
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to block road");
      }
      this.closeModal("admin-block-confirm-modal");
      this.showToast(`🚧 ${data.name} section closed`);
      await this.fetchBlocks();
    } catch (e) {
      alert("Error adding road block: " + e.message);
    }
  }

  async deleteBlock(blockId) {
    if (!this.adminToken) return;
    try {
      const res = await fetch(`/api/admin/blocks/${blockId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.adminToken}` }
      });
      if (!res.ok) throw new Error("Failed to delete block");
      this.showToast("Road reopened and unblocked");
      await this.fetchBlocks();
      this.renderAdminBlocksList();
    } catch (e) {
      alert("Error removing road block: " + e.message);
    }
  }

  // ---------------- Fetching & Live Sync ----------------

  async fetchBlocks() {
    try {
      const res = await fetch("/api/blocks");
      if (!res.ok) return;
      const blocks = await res.json();
      this.handleBlocksUpdate(blocks);
    } catch (e) {
      // offline
    }
  }

  startPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(() => {
      this.fetchBlocks();
    }, 30000);
  }

  handleBlocksUpdate(newBlocks) {
    const oldBlocks = this.activeBlocks || [];
    this.activeBlocks = newBlocks || [];

    // Sync with router graph
    if (window.Directions && window.Directions.roadGraph) {
      window.Directions.roadGraph.setBlockedRoads(this.activeBlocks);
    }

    // Update map hazards
    this.updateMapHazardSource();

    // Update Alerts panel
    this.renderAlertsPanelContent();

    // Check if an active route intersects any newly added block
    if (window.Directions && window.Directions.activeRoute) {
      const newlyAdded = this.activeBlocks.filter(b => !oldBlocks.some(ob => ob.id === b.id));
      if (newlyAdded.length > 0 && window.Directions.roadGraph.isRouteAffected(window.Directions.activeRoute, newlyAdded)) {
        this.triggerSmartReroute();
      }
    }
  }

  triggerSmartReroute() {
    const dir = window.Directions;
    if (!dir) return;
    this.showToast("⚠️ Active route automatically recalculated to avoid a new campus closure!", 5000);
    // Trigger recalculation with current origin & destination
    if (dir.currentOrigin && dir.currentDestination) {
      dir.showDirections(dir.currentOrigin, dir.currentDestination, true);
    }
  }

  // ---------------- Alerts Panel & Admin Drawer Rendering ----------------

  renderAlertsPanelContent() {
    const container = document.getElementById("alerts-panel-blocks-container");
    if (!container) return;

    if (!this.activeBlocks || this.activeBlocks.length === 0) {
      container.innerHTML = `
        <div class="campus-alert-banner" style="background:#f0fdf4;border-color:#bbf7d0;">
          <svg class="alert-banner-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <div class="alert-banner-text">
            <h4 style="color:#15803d;">All Campus Pathways Open</h4>
            <p style="color:#166534;">There are no active road or footpath closures reported across campus right now.</p>
          </div>
        </div>
      `;
      return;
    }

    let html = `<div style="display:flex;flex-direction:column;gap:12px;">`;
    this.activeBlocks.forEach(b => {
      const modeBadges = (b.modes || ["walking", "kart"]).map(m => `<span class="closure-mode-badge">${m}</span>`).join(" ");
      html += `
        <div class="campus-alert-banner" style="background:#fef2f2;border-color:#fecaca;">
          <div style="font-size:22px;line-height:1;">🚧</div>
          <div class="alert-banner-text" style="flex:1;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <h4 style="color:#dc2626;font-size:13.5px;">${b.name}</h4>
              ${this.adminToken ? `<button class="closure-unblock-btn" onclick="window.AdminBlocks.deleteBlock('${b.id}')">Unblock</button>` : ""}
            </div>
            <p style="color:#7f1d1d;margin-top:3px;font-size:12px;">${b.reason || "Closed for maintenance"}</p>
            <div style="margin-top:6px;display:flex;align-items:center;gap:6px;font-size:11px;color:#991b1b;">
              <span>Affected:</span> ${modeBadges}
            </div>
          </div>
        </div>
      `;
    });
    html += `</div>`;
    container.innerHTML = html;
  }

  renderAdminBlocksList() {
    const listEl = document.getElementById("admin-active-blocks-list");
    if (!listEl) return;

    if (!this.activeBlocks || this.activeBlocks.length === 0) {
      listEl.innerHTML = `<div style="text-align:center;color:#64748b;padding:24px 12px;font-size:13px;">No active closures. Click "Add Road Block" to close a pathway.</div>`;
      return;
    }

    let html = "";
    this.activeBlocks.forEach(b => {
      html += `
        <div class="admin-block-card">
          <div style="flex:1;">
            <div style="font-weight:700;font-size:13px;color:#0f172a;">${b.name}</div>
            <div style="font-size:11.5px;color:#dc2626;margin-top:2px;">Reason: ${b.reason}</div>
            <div style="font-size:10.5px;color:#64748b;margin-top:3px;">Type: ${b.type} • Modes: ${(b.modes || []).join(", ")}</div>
          </div>
          <button class="admin-delete-btn" onclick="window.AdminBlocks.deleteBlock('${b.id}')">Reopen</button>
        </div>
      `;
    });
    listEl.innerHTML = html;
  }

  showToast(msg, duration = 3000) {
    let toast = document.getElementById("lpunavix-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "lpunavix-toast";
      toast.className = "lpunavix-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add("visible");
    setTimeout(() => {
      toast.classList.remove("visible");
    }, duration);
  }

  bindEvents() {
    const loginForm = document.getElementById("admin-login-form");
    if (loginForm) {
      loginForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const u = document.getElementById("admin-user-input").value.trim();
        const p = document.getElementById("admin-pass-input").value;
        this.login(u, p);
      });
    }
  }
}

// Global initialization
window.AdminBlocks = new AdminBlocksController();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => window.AdminBlocks.init());
} else {
  window.AdminBlocks.init();
}
