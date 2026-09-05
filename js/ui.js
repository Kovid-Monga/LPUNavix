/**
 * LPU Map - Main UI Controller
 * Manages panels, sidebar navigation, theme switcher, satellite layer toggle, search auto-suggest, and category filtering.
 */

class UIController {
  constructor() {
    this.currentActivePanel = null;
    this.currentTheme = localStorage.getItem("lpu_theme") || "light";
    this.currentLayerMode = "satellite";
    this.isHandlingPopState = false;
  }

  init() {
    this.applyTheme(this.currentTheme);
    this.bindSidebarEvents();
    this.bindMobileNavEvents();
    this.bindSearchAndFilters();
    this.bindFloatingMapControls();
    this.toggleAssistant(false, true);

    // Ensure base root history state is set so back button never exits to browser home page
    if (!history.state || history.state.type !== "map") {
      try {
        history.replaceState({ type: "map", depth: 0 }, "");
      } catch (err) {}
    }

    // Centralized Hierarchical Browser / Phone Back Button Handler across ALL slides
    window.addEventListener("popstate", (e) => {
      this.isHandlingPopState = true;
      const state = e.state || { type: "map", depth: 0 };

      // 1. Hide route preview if moving to non-route state
      if (state.type !== "route") {
        if (window.Directions) {
          window.Directions.hideRoutePreview();
          if (window.CampusMap) window.CampusMap.clearRoute();
        }
      }

      // 2. Close search suggestions if open
      const suggestionsPanel = document.getElementById("search-suggestions");
      if (suggestionsPanel) suggestionsPanel.classList.remove("active");

      // 3. Dispatch to target state cleanly
      switch (state.type) {
        case "details":
          if (state.loc) {
            this.showLocationDetails(state.loc, true);
          } else if (state.group) {
            this.showGroupDetails(state.group, true);
          }
          break;

        case "directions":
          this.openLeftPanel("directions-panel", null, true);
          document.querySelectorAll(".mobile-nav-item").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.view === "directions");
          });
          document.querySelectorAll(".nav-item-btn:not([data-view='assistant'])").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.view === "directions");
          });
          break;

        case "route":
          if (window.Directions && state.dest) {
            window.Directions.showDirections(state.origin || "Your location", state.dest, true);
          }
          break;

        case "karts":
          this.openLeftPanel("karts-panel", null, true);
          document.querySelectorAll(".mobile-nav-item").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.view === "karts");
          });
          document.querySelectorAll(".nav-item-btn:not([data-view='assistant'])").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.view === "karts");
          });
          if (window.KartTracker) {
            window.KartTracker.renderKartsOnMap();
          }
          break;

        case "alerts":
          this.openLeftPanel("alerts-panel", null, true);
          document.querySelectorAll(".nav-item-btn:not([data-view='assistant'])").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.view === "alerts");
          });
          break;

        case "settings":
          this.openLeftPanel("settings-panel", null, true);
          document.querySelectorAll(".nav-item-btn:not([data-view='assistant'])").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.view === "settings");
          });
          break;

        case "filters":
          this.openLeftPanel("search-filter-panel", null, true);
          break;

        case "assistant":
          this.toggleAssistant(true, true);
          break;

        case "map":
        default:
          this.closeLeftPanels();
          this.toggleAssistant(false, true);
          document.querySelectorAll(".mobile-nav-item").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.view === "map");
          });
          document.querySelectorAll(".nav-item-btn:not([data-view='assistant'])").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.view === "map" || btn.dataset.view === "home");
          });
          break;
      }

      this.isHandlingPopState = false;
    });

    const layerBtn = document.getElementById("ctrl-layer-toggle");
    if (layerBtn) layerBtn.classList.add("active");
  }

  setNavState(type, data = {}, forceReplace = false) {
    const isRoot = type === "map";
    // Depth: root=0. Route from details or directions=2. Top-level panel=1.
    let depth = 1;
    if (isRoot) {
      depth = 0;
    } else if (type === "route") {
      const prevType = history.state?.type;
      depth = (prevType === "details" || prevType === "directions") ? 2 : 1;
    }

    const newState = { type, depth, ...data };

    try {
      // Sibling replacement rule:
      // If currently at depth 1 and opening another depth 1 item (e.g. from Location A directly to Location B, or Karts to Settings),
      // we replaceState so pressing Back immediately redirects to Map / Home without looping!
      const isSibling = history.state && history.state.depth === depth && depth > 0;
      if (forceReplace || isSibling) {
        history.replaceState(newState, "");
      } else {
        history.pushState(newState, "");
      }
    } catch (err) {
      console.warn("[LPUNavix] History navigation state error:", err);
    }
  }

  closePanelWithHistory() {
    if (history.state && history.state.depth > 0) {
      try {
        history.back();
        return;
      } catch (err) {}
    }
    this.closeLeftPanels();
    this.toggleAssistant(false, true);
    if (window.Directions) {
      window.Directions.hideRoutePreview();
      if (window.CampusMap) window.CampusMap.clearRoute();
    }
  }

  /* ==========================================================================
     Sidebar & Mobile Navigation
     ========================================================================== */
  bindSidebarEvents() {
    const navButtons = document.querySelectorAll(".nav-item-btn");
    navButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        this.switchView(view);
      });
    });

    // Theme toggle button in sidebar
    const themeBtn = document.getElementById("theme-toggle-btn");
    if (themeBtn) {
      themeBtn.addEventListener("click", () => {
        this.toggleTheme();
      });
    }

    // Assistant close/minimize button
    const assistantCloseBtn = document.querySelector("#assistant-panel .panel-close-btn");
    if (assistantCloseBtn) {
      assistantCloseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closePanelWithHistory();
      });
    }

    // Left Panel close buttons (Universal close with history synchronization)
    const leftCloseBtns = document.querySelectorAll(".side-panel-drawer:not(#assistant-panel) .panel-close-btn");
    leftCloseBtns.forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closePanelWithHistory();
      });
    });
  }

  bindMobileNavEvents() {
    const mobileNavItems = document.querySelectorAll(".mobile-nav-item");
    mobileNavItems.forEach(btn => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        this.switchView(view);
      });
    });
  }

  toggleTheme() {
    const newTheme = this.currentTheme === "light" ? "dark" : "light";
    this.applyTheme(newTheme);
  }

  toggleMobileMenu() {
    // Open settings / overview drawer on mobile
    this.switchView("settings");
  }

  toggleLayersCard(forceState = null) {
    const card = document.getElementById("map-layer-toggle-card");
    if (!card) return;
    if (forceState !== null) {
      card.classList.toggle("collapsed", !forceState);
    } else {
      card.classList.toggle("collapsed");
    }
  }

  /* ==========================================================================
     Path Visibility Filters (Roads & Footpaths)
     ========================================================================== */
  onPathToggle(type, checked) {
    if (window.CampusMap) {
      window.CampusMap.setLayerVisibility(type, checked);
    }
    this.updatePresetButtonsState();
  }

  setPathPreset(mode) {
    const roadsChk = document.getElementById("toggle-roads-chk");
    const footpathsChk = document.getElementById("toggle-footpaths-chk");
    const boundaryChk = document.getElementById("toggle-boundary-chk");
    const isAll = mode === "all";

    if (roadsChk) roadsChk.checked = isAll;
    if (footpathsChk) footpathsChk.checked = isAll;
    if (boundaryChk) boundaryChk.checked = isAll;

    if (window.CampusMap) {
      window.CampusMap.setAllLayersVisibility(isAll);
    }

    this.updatePresetButtonsState();
  }

  updatePresetButtonsState() {
    const roadsChk = document.getElementById("toggle-roads-chk");
    const footpathsChk = document.getElementById("toggle-footpaths-chk");
    const boundaryChk = document.getElementById("toggle-boundary-chk");
    const presetAll = document.getElementById("preset-all");
    const presetNone = document.getElementById("preset-none");

    const r = roadsChk ? roadsChk.checked : true;
    const f = footpathsChk ? footpathsChk.checked : true;
    const b = boundaryChk ? boundaryChk.checked : true;

    if (presetAll) presetAll.classList.toggle("active", r && f && b);
    if (presetNone) presetNone.classList.toggle("active", !r && !f && !b);
  }

  /* ==========================================================================
     Navigation & Panel Switching
     ========================================================================== */
  toggleAssistant(forceState = null, skipHistory = false) {
    const panel = document.getElementById("assistant-panel");
    if (!panel) return;

    const isMobile = window.innerWidth <= 768;
    const willBeOpen = forceState !== null ? forceState : (
      isMobile ? !panel.classList.contains("active") : panel.classList.contains("collapsed")
    );

    if (isMobile) {
      if (willBeOpen) {
        document.querySelectorAll(".side-panel-drawer:not(#assistant-panel)").forEach(p => p.classList.remove("active"));
      }
      panel.classList.toggle("active", willBeOpen);
      panel.classList.toggle("collapsed", !willBeOpen);
      document.body.classList.toggle("assistant-collapsed", !willBeOpen);
    } else {
      panel.classList.toggle("collapsed", !willBeOpen);
      document.body.classList.toggle("assistant-collapsed", !willBeOpen);
    }

    const assistantNavBtn = document.querySelector('.nav-item-btn[data-view="assistant"]');
    if (assistantNavBtn) {
      assistantNavBtn.classList.toggle("active", willBeOpen);
    }

    if (!skipHistory) {
      if (willBeOpen) {
        this.setNavState("assistant");
      } else if (history.state && history.state.type === "assistant") {
        this.closePanelWithHistory();
      }
    }
  }

  switchView(viewName, customOrigin = null, customDest = null) {
    if (viewName === "assistant") {
      this.toggleAssistant();
      return;
    }

    // Update sidebar buttons active state
    document.querySelectorAll(".nav-item-btn:not([data-view='assistant'])").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });

    // Update mobile bottom nav buttons active state
    document.querySelectorAll(".mobile-nav-item").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });

    if (viewName === "home" || viewName === "map") {
      if (history.state && history.state.depth > 0) {
        try {
          history.go(-history.state.depth);
          return;
        } catch (err) {}
      }
      this.closeLeftPanels();
      this.toggleAssistant(false, true);
      if (window.Directions) {
        window.Directions.hideRoutePreview();
        if (window.CampusMap) window.CampusMap.clearRoute();
      }
      if (window.CampusMap) {
        window.CampusMap.renderLocationMarkers("all");
      }
      return;
    }

    if (viewName === "directions") {
      const originInput = document.getElementById("direction-origin-input");
      const destInput = document.getElementById("direction-dest-input");
      const o = customOrigin || (originInput && originInput.value ? originInput.value : "Your location");

      if (customDest && customDest.trim() !== "") {
        if (originInput) originInput.value = o;
        if (destInput) destInput.value = customDest;
        this.closeLeftPanels(true);
        if (window.Directions) {
          window.Directions.showDirections(o, customDest);
        }
      } else {
        if (originInput) originInput.value = o;
        const currentDest = (customDest !== undefined) ? customDest : (destInput ? destInput.value : "");
        this.openLeftPanel("directions-panel");
        if (window.CampusMap && (!currentDest || currentDest.trim() === "")) {
          window.CampusMap.clearRoute();
        }
        if (window.Directions) {
          window.Directions.hideRoutePreview();
          window.Directions.updateDestinationState(currentDest);
        }
      }
    } else if (viewName === "karts") {
      this.openLeftPanel("karts-panel");
      if (window.KartTracker) {
        window.KartTracker.renderKartsOnMap();
      }
    } else if (viewName === "alerts") {
      this.openLeftPanel("alerts-panel");
      if (window.Directions) {
        window.Directions.showDetourRerouting();
      }
    } else if (viewName === "settings") {
      this.openLeftPanel("settings-panel");
    }
  }

  openLeftPanel(panelId, data = null, skipHistory = false) {
    this.closeLeftPanels(true);
    const panel = document.getElementById(panelId);
    if (panel) {
      panel.classList.add("active");
      this.currentActivePanel = panelId;

      if (!skipHistory) {
        let type = "map";
        if (panelId === "directions-panel") type = "directions";
        else if (panelId === "karts-panel") type = "karts";
        else if (panelId === "alerts-panel") type = "alerts";
        else if (panelId === "settings-panel") type = "settings";
        else if (panelId === "search-filter-panel") type = "filters";
        else if (panelId === "details-panel") type = "details";

        this.setNavState(type, data || {});
      }
    }
  }

  closeLeftPanels(isOpeningAnother = false) {
    document.querySelectorAll(".side-panel-drawer:not(#assistant-panel)").forEach(p => p.classList.remove("active"));
    this.currentActivePanel = null;
    if (window.CampusMap) {
      window.CampusMap.clearRevealedLocations();
    }
  }

  closeAllPanels() {
    this.closeLeftPanels();
  }

  /* ==========================================================================
     Active Navigation ETA Floating Bar
     ========================================================================== */
  startActiveNavigation(destinationName = "Block 25 (CSE)", duration = "5 min", distance = "350 m", mode = "walking", routePath = null) {
    const etaBar = document.getElementById("mobile-nav-eta-bar");
    if (etaBar) {
      const durationVal = document.getElementById("eta-duration-val");
      const distanceVal = document.getElementById("eta-distance-val");
      const targetVal = document.getElementById("eta-target-time");

      const modeIcon = mode === "kart" ? "🛺" : "🚶";
      if (durationVal) durationVal.textContent = `${modeIcon} ${duration}`;
      if (distanceVal) distanceVal.textContent = `${distance} remaining`;
      if (targetVal) targetVal.textContent = `Navigating to ${destinationName}`;

      etaBar.classList.add("active");
    }

    // Close drawers so the dotted path and map are fully visible
    document.querySelectorAll(".side-panel-drawer:not(#assistant-panel)").forEach(p => p.classList.remove("active"));
    this.currentActivePanel = null;
    this.toggleAssistant(false);

    // Draw dotted route on map and focus
    if (window.CampusMap) {
      if (routePath && routePath.length >= 2) {
        window.CampusMap.drawRoute(routePath, false, null, {
          mode: mode || "walking",
          originName: "Your Current Location",
          destName: destinationName
        });
        const startPt = routePath[0];
        window.CampusMap.flyToLocation(startPt[0], startPt[1], 17.5);
      } else if (window.Directions) {
        window.Directions.showDirections("Your Current Location", destinationName);
      }
    }
  }

  endActiveNavigation() {
    const etaBar = document.getElementById("mobile-nav-eta-bar");
    if (etaBar) etaBar.classList.remove("active");
    if (window.CampusMap) {
      window.CampusMap.clearRoutes();
    }
  }

  /* ==========================================================================
     Theme Switcher (Light / Dark)
     ========================================================================== */
  applyTheme(theme) {
    this.currentTheme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("lpu_theme", theme);

    if (window.CampusMap) {
      if (this.currentLayerMode !== "satellite") {
        window.CampusMap.setBaseLayer("street");
      }
    }
  }

  /* ==========================================================================
     Search & Category Filter Chips
     ========================================================================== */
  bindSearchAndFilters() {
    const searchInput = document.getElementById("global-search-input");
    const suggestionsPanel = document.getElementById("search-suggestions");
    const clearBtn = document.getElementById("search-clear-btn");

    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        const val = e.target.value.trim().toLowerCase();
        if (clearBtn) clearBtn.classList.toggle("visible", val.length > 0);

        if (val.length > 0) {
          this.renderSearchSuggestions(val);
        } else {
          if (suggestionsPanel) suggestionsPanel.classList.remove("active");
        }
      });

      if (clearBtn) {
        clearBtn.addEventListener("click", () => {
          searchInput.value = "";
          clearBtn.classList.remove("visible");
          if (suggestionsPanel) suggestionsPanel.classList.remove("active");
        });
      }
    }

    // Category filter chips
    const filterChips = document.querySelectorAll(".chip-btn");
    filterChips.forEach(chip => {
      chip.addEventListener("click", (e) => {
        filterChips.forEach(c => c.classList.remove("active"));
        const btn = e.currentTarget;
        btn.classList.add("active");
        const category = btn.dataset.category || "all";

        if (window.CampusMap) {
          window.CampusMap.renderLocationMarkers(category);
        }
      });
    });
  }

  renderSearchSuggestions(query) {
    const panel = document.getElementById("search-suggestions");
    if (!panel) return;

    const q = query.toLowerCase();

    // 1. Search in CAMPUS_GROUPS (Departments, Food Courts, Complexes)
    const matchingGroups = Array.isArray(CAMPUS_GROUPS) ? CAMPUS_GROUPS.filter(g =>
      g.name.toLowerCase().includes(q) ||
      (Array.isArray(g.tags) && g.tags.some(t => t.toLowerCase().includes(q))) ||
      (g.desc && g.desc.toLowerCase().includes(q))
    ) : [];

    // 2. Search in individual CAMPUS_LOCATIONS (Blocks, Labs, Shops)
    const allLocations = getAllCampusLocations();
    const matchingLocations = allLocations.filter(loc =>
      loc.name.toLowerCase().includes(q) ||
      (loc.groupName && loc.groupName.toLowerCase().includes(q)) ||
      (Array.isArray(loc.facilities) && loc.facilities.some(f => f.toLowerCase().includes(q))) ||
      (Array.isArray(loc.tags) && loc.tags.some(t => t.toLowerCase().includes(q))) ||
      (loc.desc && loc.desc.toLowerCase().includes(q))
    );

    if (matchingGroups.length === 0 && matchingLocations.length === 0) {
      panel.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:13px;">No campus location or department found for "<strong>${query}</strong>"</div>`;
      panel.classList.add("active");
      return;
    }

    let html = "";

    // Render Department / Food Court Groups first
    if (matchingGroups.length > 0) {
      html += `<div style="padding:6px 14px 2px;font-size:10px;font-weight:800;letter-spacing:0.05em;color:var(--text-muted);text-transform:uppercase;">Departments & Zones</div>`;
      matchingGroups.forEach(g => {
        const memberCount = (g.blocks && g.blocks.length) || (g.shops && g.shops.length) || 0;
        const subLabel = g.blocks ? `Includes ${g.blocks.length} Blocks (${g.blocks.join(', ').replace(/block-/g, 'B')})` : (g.shops ? `Includes ${g.shops.length} Outlets` : "Campus Zone");

        html += `
          <div class="suggestion-item" onclick="window.UIController.selectGroupSearchResult('${g.id}')">
            <div class="suggestion-icon" style="background:#eff6ff;color:#2563eb;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
            </div>
            <div class="suggestion-info">
              <span class="suggestion-title">${g.name}</span>
              <span class="suggestion-sub" style="color:var(--color-primary);font-weight:600;">${subLabel}</span>
            </div>
            <span class="suggestion-type" style="background:#dbeafe;color:#1e40af;">Zone</span>
          </div>
        `;
      });
    }

    // Render Individual Locations (Blocks, Shops, Labs)
    if (matchingLocations.length > 0) {
      if (matchingGroups.length > 0) {
        html += `<div style="padding:10px 14px 2px;font-size:10px;font-weight:800;letter-spacing:0.05em;color:var(--text-muted);text-transform:uppercase;border-top:1px solid var(--border-subtle);">Individual Blocks & Outlets</div>`;
      }
      matchingLocations.forEach(loc => {
        const subText = loc.groupName ? `${loc.floor || ""} • ${loc.groupName}` : (loc.floor || "");

        html += `
          <div class="suggestion-item" onclick="window.UIController.selectSearchResult('${loc.id}')">
            <div class="suggestion-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
            </div>
            <div class="suggestion-info">
              <span class="suggestion-title">${loc.name}</span>
              <span class="suggestion-sub">${subText}</span>
            </div>
            <span class="suggestion-type">${loc.type || "Location"}</span>
          </div>
        `;
      });
    }

    panel.innerHTML = html;
    panel.classList.add("active");
  }

  selectSearchResult(locationId) {
    const loc = getAllCampusLocations().find(l => l.id === locationId);
    if (!loc) return;

    const panel = document.getElementById("search-suggestions");
    if (panel) panel.classList.remove("active");

    const searchInput = document.getElementById("global-search-input");
    if (searchInput) searchInput.value = loc.name;

    this.showLocationDetails(loc);
    if (window.CampusMap) {
      window.CampusMap.revealLocation(locationId);
    }
  }

  selectGroupSearchResult(groupId) {
    const group = CAMPUS_GROUPS.find(g => g.id === groupId);
    if (!group) return;

    const panel = document.getElementById("search-suggestions");
    if (panel) panel.classList.remove("active");

    const searchInput = document.getElementById("global-search-input");
    if (searchInput) searchInput.value = group.name;

    this.showGroupDetails(group);
  }

  /* ==========================================================================
     Group / Department Details Modal (Panel 5)
     ========================================================================== */
  showGroupDetails(group, skipHistory = false) {
    const detailsPanel = document.getElementById("details-panel");
    if (!detailsPanel) return;

    const heroImg = document.getElementById("detail-hero-img");
    if (heroImg) heroImg.src = group.image || "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600";

    const titleEl = document.getElementById("detail-title");
    if (titleEl) titleEl.textContent = group.name;

    const floorEl = document.getElementById("detail-floor");
    if (floorEl) {
      floorEl.textContent = group.blocks ? `${group.blocks.length} Blocks in this zone` : (group.shops ? `${group.shops.length} Outlets inside` : "Campus Zone");
    }

    // Get child member locations
    const childLocations = group.blocks
      ? CAMPUS_LOCATIONS.filter(l => group.blocks.includes(l.id))
      : (group.shops ? CAMPUS_LOCATIONS.filter(l => l.groupId === group.id) : []);

    let childMembersHtml = "";
    if (childLocations.length > 0) {
      childMembersHtml = `
        <div style="margin-top:10px;">
          <div style="font-weight:800;font-size:12px;color:var(--text-primary);margin-bottom:6px;">Locations Inside this Zone:</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${childLocations.map(loc => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg-pill);border-radius:var(--radius-md);cursor:pointer;" onclick="window.UIController.showLocationDetails(getAllCampusLocations().find(l=>l.id==='${loc.id}'))">
                <div>
                  <div style="font-weight:700;font-size:13px;color:var(--text-primary);">${loc.name}</div>
                  <div style="font-size:11px;color:var(--text-muted);">${loc.floor || ""}</div>
                </div>
                <button class="preset-pill-btn" style="font-size:10px;">View</button>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }

    const descEl = document.getElementById("detail-desc");
    if (descEl) descEl.innerHTML = `${group.desc || ""}${childMembersHtml}`;

    const hoursEl = document.getElementById("detail-hours");
    if (hoursEl) hoursEl.textContent = "Open on Campus Schedule";

    const phoneEl = document.getElementById("detail-phone");
    if (phoneEl) phoneEl.textContent = "University Helpdesk";

    const getDirectionsBtn = document.getElementById("detail-get-directions-btn");
    if (getDirectionsBtn) {
      getDirectionsBtn.onclick = () => {
        const originVal = document.getElementById("direction-origin-input")?.value || "Your Current Location";
        this.switchView("directions", originVal, group.name);
      };
    }

    if (!skipHistory) {
      this.setNavState("details", { group: group, groupId: group.id });
    }

    this.openLeftPanel("details-panel", { group }, true);

    if (!skipHistory && window.CampusMap && group.centerCoords) {
      window.CampusMap.flyToLocation(group.centerCoords[0], group.centerCoords[1], 16.5);
    }
  }

  /* ==========================================================================
     Location Details Modal (Panel 5)
     ========================================================================== */
  showLocationDetails(loc, skipHistory = false) {
    const detailsPanel = document.getElementById("details-panel");
    if (!detailsPanel) return;

    const heroImg = document.getElementById("detail-hero-img");
    if (heroImg) heroImg.src = loc.image || "https://images.unsplash.com/photo-1541829070764-84a7d30dd3f3?w=600&auto=format&fit=crop&q=80";

    const titleEl = document.getElementById("detail-title");
    if (titleEl) titleEl.textContent = loc.name;

    const floorEl = document.getElementById("detail-floor");
    if (floorEl) {
      const parentBadge = loc.groupName ? ` • Part of ${loc.groupName}` : "";
      floorEl.textContent = `${loc.floor || ""}${parentBadge}`;
    }

    // Facilities badge list
    let facilitiesHtml = "";
    if (Array.isArray(loc.facilities) && loc.facilities.length > 0) {
      facilitiesHtml = `
        <div style="margin-top:8px;">
          <div style="font-weight:700;font-size:11px;color:var(--text-muted);margin-bottom:4px;">KEY FACILITIES / LABS:</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;">
            ${loc.facilities.map(f => `<span style="padding:2px 8px;border-radius:12px;background:var(--bg-pill);font-size:11px;font-weight:600;color:var(--text-secondary);">${f}</span>`).join("")}
          </div>
        </div>
      `;
    }

    const descEl = document.getElementById("detail-desc");
    if (descEl) descEl.innerHTML = `${loc.desc || ""}${facilitiesHtml}`;

    const hoursEl = document.getElementById("detail-hours");
    if (hoursEl) hoursEl.textContent = loc.hours || "Open Daily";

    const phoneEl = document.getElementById("detail-phone");
    if (phoneEl) phoneEl.textContent = loc.phone || "N/A";

    const getDirectionsBtn = document.getElementById("detail-get-directions-btn");
    if (getDirectionsBtn) {
      getDirectionsBtn.onclick = () => {
        const originVal = document.getElementById("direction-origin-input")?.value || "Your Current Location";
        this.switchView("directions", originVal, loc.name);
      };
    }

    if (!skipHistory) {
      this.setNavState("details", { loc: loc, locId: loc.id });
    }

    this.openLeftPanel("details-panel", { loc }, true);

    if (!skipHistory && window.CampusMap && loc.lat && loc.lng) {
      window.CampusMap.flyToLocation(loc.lat, loc.lng, 17.5);
    }
  }

  triggerShowOnMap(locationId, targetTitle = null) {
    let destName = targetTitle || locationId;

    if (locationId) {
      const allLocs = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (window.CAMPUS_LOCATIONS || []);
      const matchedLoc = allLocs.find(l => 
        (l.id && l.id.toLowerCase() === String(locationId).toLowerCase()) ||
        (l.name && l.name.toLowerCase() === String(locationId).toLowerCase())
      );
      if (matchedLoc) {
        destName = matchedLoc.name;
      } else if (typeof CAMPUS_GROUPS !== "undefined" && Array.isArray(CAMPUS_GROUPS)) {
        const matchedGroup = CAMPUS_GROUPS.find(g => 
          (g.id && g.id.toLowerCase() === String(locationId).toLowerCase()) ||
          (g.name && g.name.toLowerCase() === String(locationId).toLowerCase())
        );
        if (matchedGroup) {
          destName = matchedGroup.name;
        }
      }
    }

    if (!destName) {
      destName = "Block 25 (CSE)";
    }

    // 1. Close or collapse assistant drawer so the user can see the map and route clearly
    this.toggleAssistant(false);

    // 2. Open directions view with "Your Current Location" as origin (which calculates route & displays preview)
    const origin = "Your Current Location";
    this.switchView("directions", origin, destName);
  }

  /* ==========================================================================
     Floating Map Action Controls (Zoom +, Zoom -, Satellite Toggle, Recenter)
     ========================================================================== */
  bindFloatingMapControls() {
    const compassBtn = document.getElementById("ctrl-compass");
    const zoomInBtn = document.getElementById("ctrl-zoom-in");
    const zoomOutBtn = document.getElementById("ctrl-zoom-out");
    const recenterBtn = document.getElementById("ctrl-recenter");
    const layerBtn = document.getElementById("ctrl-layer-toggle");

    // 1. Compass Button (resets orientation to North, does NOT recenter/locateUser)
    if (compassBtn) {
      compassBtn.addEventListener("click", () => {
        if (window.CampusMap && typeof window.CampusMap.resetOrientation === "function") {
          window.CampusMap.resetOrientation();
        }
      });
    }

    // 2. Zoom In (+)
    if (zoomInBtn) {
      zoomInBtn.addEventListener("click", () => {
        if (window.CampusMap) window.CampusMap.zoomIn();
      });
    }

    // 3. Zoom Out (−)
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener("click", () => {
        if (window.CampusMap) window.CampusMap.zoomOut();
      });
    }

    // 4. My Location / Recenter
    if (recenterBtn) {
      recenterBtn.addEventListener("click", () => {
        if (window.CampusMap) {
          if (typeof window.CampusMap.locateUser === "function") {
            window.CampusMap.locateUser();
          } else {
            window.CampusMap.recenterCampus();
          }
        }
      });
    }

    // Desktop layer toggle button (if present)
    if (layerBtn) {
      layerBtn.addEventListener("click", () => {
        if (!window.CampusMap) return;
        if (this.currentLayerMode === "street") {
          window.CampusMap.setBaseLayer("satellite");
          this.currentLayerMode = "satellite";
          layerBtn.classList.add("active");
        } else {
          window.CampusMap.setBaseLayer("street");
          this.currentLayerMode = "street";
          layerBtn.classList.remove("active");
        }
      });
    }

    // Init filter panel interactions
    this.initFilterPanel();
  }

  /* ==========================================================================
     Search Filter Panel
     ========================================================================== */
  initFilterPanel() {
    // Single-select chip groups (click toggles active within its own group)
    document.querySelectorAll(".filter-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const group = chip.closest(".filter-chip-group");
        if (group) {
          group.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
        }
        chip.classList.add("active");
      });
    });

    // Close button
    const filterPanel = document.getElementById("search-filter-panel");
    if (filterPanel) {
      const closeBtn = filterPanel.querySelector(".panel-close-btn");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => this.closePanelWithHistory());
      }
    }

    // Reset button
    const resetBtn = document.getElementById("filter-reset-btn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        // Reset every group's first chip to active
        document.querySelectorAll(".filter-chip-group").forEach(group => {
          group.querySelectorAll(".filter-chip").forEach((c, i) => c.classList.toggle("active", i === 0));
        });
        const openNow = document.getElementById("filter-open-now");
        const hasLoc  = document.getElementById("filter-has-location");
        if (openNow) openNow.checked = false;
        if (hasLoc)  hasLoc.checked  = true;
        this._showFilterBadge(false);
      });
    }
  }

  applySearchFilters() {
    // Read active selections
    const category = document.querySelector("#filter-category-group .filter-chip.active")?.dataset.value || "all";
    const type      = document.querySelector("#filter-type-group .filter-chip.active")?.dataset.value || "all";
    const distance  = document.querySelector("#filter-distance-group .filter-chip.active")?.dataset.value || "far";
    const openNow   = document.getElementById("filter-open-now")?.checked || false;

    // Highlight the filter button if any filter is non-default
    const isFiltered = category !== "all" || type !== "all" || distance !== "far" || openNow;
    this._showFilterBadge(isFiltered);

    // Sync category chips row with filter panel selection (if a known category was chosen)
    if (["all","academics","hostels","food","parking","others"].includes(category)) {
      document.querySelectorAll(".category-chips-row .chip-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.category === category);
      });
      // Trigger the existing chip click to fire any search handler
      const matchingChip = document.querySelector(`.category-chips-row .chip-btn[data-category="${category}"]`);
      if (matchingChip) matchingChip.click();
    }

    // Close the panel with history synchronization
    this.closePanelWithHistory();
  }

  _showFilterBadge(show) {
    const btn = document.getElementById("search-filter-btn");
    if (!btn) return;
    btn.classList.toggle("has-active-filter", show);
  }
}

// Global UI Controller instance
window.UIController = new UIController();
