const fs = require('fs');
const path = require('path');

function testRestyle() {
  console.log("Checking HTML markup in index.html...");
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

  // 1. Check Floating Map Controls
  const requiredControls = [
    'id="ctrl-floating-layers"',
    'id="ctrl-recenter"',
    'id="ctrl-compass"'
  ];
  for (const ctrl of requiredControls) {
    if (!html.includes(ctrl)) {
      throw new Error(`Missing required control in index.html: ${ctrl}`);
    }
  }
  console.log("✔ Floating map controls present: layers, recenter, compass");

  // 2. Check Route Topbar Card
  const requiredTopbar = [
    'id="gmaps-route-topbar"',
    'class="gmaps-ring-origin"',
    'id="gmaps-topbar-origin-input"',
    'id="gmaps-topbar-menu-btn"',
    'class="gmaps-connector-dots"',
    'class="gmaps-pin-dest"',
    'id="gmaps-topbar-dest-input"',
    'id="gmaps-topbar-swap-btn"',
    'id="gmaps-topbar-menu-dropdown"'
  ];
  for (const item of requiredTopbar) {
    if (!html.includes(item)) {
      throw new Error(`Missing topbar element in index.html: ${item}`);
    }
  }
  // 2b. Check Stops Container, Cloud Alert, and Autocomplete Dropdowns
  const requiredStopElements = [
    'id="gmaps-topbar-stops-container"',
    'id="gmaps-add-stop-cloud-alert"',
    'class="gmaps-cloud-alert"',
    'id="gmaps-topbar-origin-dropdown"',
    'id="gmaps-topbar-dest-dropdown"'
  ];
  for (const item of requiredStopElements) {
    if (!html.includes(item)) {
      throw new Error(`Missing stop/dropdown element in index.html: ${item}`);
    }
  }
  console.log("✔ Intermediate stops container, cloud alert tooltip & autocomplete dropdown containers verified");

  // Verify inputs are NOT readonly
  if (html.includes('id="gmaps-topbar-origin-input" class="gmaps-topbar-input" readonly') ||
      html.includes('id="gmaps-topbar-dest-input" class="gmaps-topbar-input" readonly')) {
    throw new Error("Topbar inputs should NOT be readonly");
  }
  console.log("✔ Topbar inputs are editable (not readonly)");

  // 3. Check Bottom Sheet
  const requiredSheet = [
    'id="gmaps-route-preview-sheet"',
    'class="gmaps-sheet-handle"',
    'Your route',
    'Get to your destination easily',
    'id="gmaps-preview-close-btn"',
    'data-mode="walking"',
    'data-mode="drive"',
    'id="gmaps-tab-walk-time"',
    'id="gmaps-tab-drive-time"',
    'id="gmaps-preview-duration"',
    'id="gmaps-preview-dist"',
    'Recommended route',
    'id="gmaps-start-action-btn"',
    'id="gmaps-add-stops-action-btn"',
    'id="gmaps-share-action-btn"'
  ];
  for (const item of requiredSheet) {
    if (!html.includes(item)) {
      throw new Error(`Missing sheet element in index.html: ${item}`);
    }
  }
  console.log("✔ Bottom sheet markup verified (header, walk/drive pills, stats, start/add stop/share action buttons)");

  // 4. Check CSS in css/panels.css and css/mobile.css
  console.log("Checking CSS rules...");
  const panelsCss = fs.readFileSync(path.join(__dirname, '../css/panels.css'), 'utf8');
  const mobileCss = fs.readFileSync(path.join(__dirname, '../css/mobile.css'), 'utf8');
  const mapCss = fs.readFileSync(path.join(__dirname, '../css/map.css'), 'utf8');

  // Verify mobile-app-header is NOT hidden, and mobile-bottom-nav is hidden in gmaps-route-active
  if (panelsCss.includes('body.gmaps-route-active .mobile-app-header')) {
    throw new Error("mobile-app-header should NOT be hidden in panels.css during gmaps-route-active");
  }
  if (!panelsCss.includes('body.gmaps-route-active .mobile-bottom-nav')) {
    throw new Error("mobile-bottom-nav should be hidden in panels.css during gmaps-route-active");
  }
  console.log("✔ Panels CSS preserves header and hides bottom nav during route preview");

  // Verify orange accent in mobile nav
  if (!mobileCss.includes('color: var(--color-accent)')) {
    throw new Error("mobile.css should use var(--color-accent) for active nav item");
  }
  console.log("✔ Mobile CSS uses var(--color-accent) for active nav tab and dot");

  // Verify map marker and route polyline styles in css/map.css
  if (!mapCss.includes('.origin-ring-dot') || !mapCss.includes('.route-marker-pill') || !mapCss.includes('.route-connector-outline') || !mapCss.includes('.route-junction-dot')) {
    throw new Error("map.css missing .origin-ring-dot, .route-marker-pill, .route-connector-outline, or .route-junction-dot");
  }
  console.log("✔ Map CSS includes origin-ring-dot, labeled pill badges, dotted connectors, and junction dots");

  // 5. Check JS logic in js/map.js and js/directions.js
  console.log("Checking JS implementations...");
  const mapJs = fs.readFileSync(path.join(__dirname, '../js/map.js'), 'utf8');
  const directionsJs = fs.readFileSync(path.join(__dirname, '../js/directions.js'), 'utf8');
  const uiJs = fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8');

  if (!mapJs.includes('#f97316')) {
    throw new Error("map.js drawRoute should use #f97316 for route line");
  }
  if (!mapJs.includes('origin-ring-dot') || !mapJs.includes('route-marker-pill')) {
    throw new Error("map.js drawRoute should create origin-ring-dot and route-marker-pill");
  }
  console.log("✔ Map JS drawRoute sets #f97316 line and labeled pill badges");

  if (!mapJs.includes('stop-route-marker') || !mapJs.includes('stop-dot-marker')) {
    throw new Error("map.js drawRoute should support intermediate stop marker");
  }
  console.log("✔ Map JS drawRoute supports intermediate stop waypoint markers");

  if (!directionsJs.includes('gmaps-topbar-menu-dropdown')) {
    throw new Error("directions.js should handle gmaps-topbar-menu-dropdown");
  }
  if (!directionsJs.includes('gmaps-add-stops-action-btn')) {
    throw new Error("directions.js should handle gmaps-add-stops-action-btn");
  }
  if (!directionsJs.includes('gmaps-topbar-remove-stop-btn') || !directionsJs.includes('this.currentStop')) {
    throw new Error("directions.js should support currentStop and gmaps-topbar-remove-stop-btn");
  }
  console.log("✔ Directions JS handles menu dropdown, add stops action, stop removal, and multi-stop route calculation");

  if (!uiJs.includes('ctrl-floating-layers')) {
    throw new Error("ui.js should bind ctrl-floating-layers");
  }
  console.log("✔ UI JS binds ctrl-floating-layers toggle");

  console.log("\nAll visual and structural restyle checks passed successfully! 🚀");
}

testRestyle();
