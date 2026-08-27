/**
 * LPU Map - Main UI Controller
 * Manages panels, sidebar navigation, theme switcher, satellite layer toggle, search auto-suggest, and category filtering.
 */

class UIController {
  constructor() {
    this.currentActivePanel = null;
    this.currentTheme = localStorage.getItem("lpu_theme") || "light";
    this.currentLayerMode = "satellite";
  }

  init() {
    this.applyTheme(this.currentTheme);
    this.bindSidebarEvents();
    this.bindMobileNavEvents();
    this.bindSearchAndFilters();
    this.bindFloatingMapControls();
    this.toggleAssistant(false);

    const layerBtn = document.getElementById("ctrl-layer-toggle");
    if (layerBtn) layerBtn.classList.add("active");
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
        this.toggleAssistant(false);
      });
    }

    // Left Panel close buttons
    const leftCloseBtns = document.querySelectorAll(".side-panel-drawer:not(#assistant-panel) .panel-close-btn");
    leftCloseBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        this.closeLeftPanels();
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
  toggleAssistant(forceState = null) {
    const panel = document.getElementById("assistant-panel");
    if (!panel) return;

    const isMobile = window.innerWidth <= 768;

    if (isMobile) {
      // Mobile: use active/inactive pattern (same as Campus Status, Directions, Karts)
      const isOpen = forceState !== null ? forceState : !panel.classList.contains("active");
      // Close all other drawers first
      document.querySelectorAll(".side-panel-drawer:not(#assistant-panel)").forEach(p => p.classList.remove("active"));
      panel.classList.toggle("active", isOpen);
      panel.classList.toggle("collapsed", !isOpen);
      document.body.classList.toggle("assistant-collapsed", !isOpen);
    } else {
      // Desktop: use collapsed/slide-right pattern
      const isCollapsed = forceState !== null ? !forceState : !panel.classList.contains("collapsed");
      panel.classList.toggle("collapsed", isCollapsed);
      document.body.classList.toggle("assistant-collapsed", isCollapsed);
    }

    // Update assistant nav button active state
    const assistantNavBtn = document.querySelector('.nav-item-btn[data-view="assistant"]');
    if (assistantNavBtn) {
      const isNowOpen = panel.classList.contains("active") || !panel.classList.contains("collapsed");
      assistantNavBtn.classList.toggle("active", isNowOpen);
    }
  }

  switchView(viewName) {
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

    this.closeLeftPanels();

    if (viewName === "home" || viewName === "map") {
      if (window.CampusMap) {
        window.CampusMap.renderLocationMarkers("all");
        window.CampusMap.recenterCampus();
      }
      return;
    }

    if (viewName === "directions") {
      this.openLeftPanel("directions-panel");
      if (window.Directions) {
        window.Directions.showDirections("Main Gate", "Block 18");
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

  openLeftPanel(panelId) {
    this.closeLeftPanels();
    const panel = document.getElementById(panelId);
    if (panel) {
      panel.classList.add("active");
      this.currentActivePanel = panelId;
    }
  }

  closeLeftPanels() {
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
  startActiveNavigation(destinationName = "Block 18", duration = "6 min", distance = "450 m") {
    const etaBar = document.getElementById("mobile-nav-eta-bar");
    if (!etaBar) return;

    const durationVal = document.getElementById("eta-duration-val");
    const distanceVal = document.getElementById("eta-distance-val");
    const targetVal = document.getElementById("eta-target-time");

    if (durationVal) durationVal.textContent = duration;
    if (distanceVal) distanceVal.textContent = `${distance} remaining`;
    if (targetVal) targetVal.textContent = `Navigating to ${destinationName}`;

    etaBar.classList.add("active");
    this.closeLeftPanels();
  }

  endActiveNavigation() {
    const etaBar = document.getElementById("mobile-nav-eta-bar");
    if (etaBar) etaBar.classList.remove("active");
    if (window.Directions) {
      window.Directions.clearRoute();
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
  showGroupDetails(group) {
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
        this.switchView("directions");
        if (window.Directions) {
          window.Directions.showDirections("Main Gate", group.name);
        }
      };
    }

    this.openLeftPanel("details-panel");

    if (window.CampusMap && group.centerCoords) {
      window.CampusMap.flyToLocation(group.centerCoords[0], group.centerCoords[1], 16.5);
    }
  }

  /* ==========================================================================
     Location Details Modal (Panel 5)
     ========================================================================== */
  showLocationDetails(loc) {
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
        this.switchView("directions");
        if (window.Directions) {
          window.Directions.showDirections("Main Gate", loc.name);
        }
      };
    }

    this.openLeftPanel("details-panel");

    if (window.CampusMap && loc.lat && loc.lng) {
      window.CampusMap.flyToLocation(loc.lat, loc.lng, 17.5);
    }
  }

  triggerShowOnMap(locationId) {
    // Check if it is a group
    const group = CAMPUS_GROUPS.find(g => g.id === locationId);
    if (group) {
      this.showGroupDetails(group);
      return;
    }

    const loc = getAllCampusLocations().find(l => l.id === locationId);
    if (loc) {
      this.showLocationDetails(loc);
    }
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
        closeBtn.addEventListener("click", () => this.closeLeftPanels());
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

    // Close the panel
    this.closeLeftPanels();
  }

  _showFilterBadge(show) {
    const btn = document.getElementById("search-filter-btn");
    if (!btn) return;
    btn.classList.toggle("has-active-filter", show);
  }
}

// Global UI Controller instance
window.UIController = new UIController();
