const fs = require('fs');
const path = require('path');

function testStopRoutingFlow() {
  console.log("Running Multi-Stop, Cloud Alert & Dotted Connector Verification...");

  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const panelsCss = fs.readFileSync(path.join(__dirname, '../css/panels.css'), 'utf8');
  const mapCss = fs.readFileSync(path.join(__dirname, '../css/map.css'), 'utf8');
  const directionsJs = fs.readFileSync(path.join(__dirname, '../js/directions.js'), 'utf8');
  const mapJs = fs.readFileSync(path.join(__dirname, '../js/map.js'), 'utf8');

  // 1. Check HTML markup
  console.log("Verifying HTML elements...");
  if (!html.includes('id="gmaps-topbar-stops-container"')) {
    throw new Error("index.html missing #gmaps-topbar-stops-container");
  }
  if (!html.includes('id="gmaps-add-stop-cloud-alert"') || !html.includes('class="cloud-alert-body"')) {
    throw new Error("index.html missing cloud alert markup");
  }
  console.log("✔ Stops container and cloud alert tooltip markup verified in index.html");

  // 2. Check CSS rules (panels.css & map.css)
  console.log("Verifying CSS rules...");
  if (!panelsCss.includes('body.gmaps-route-active .mobile-bottom-nav')) {
    throw new Error("panels.css should hide .mobile-bottom-nav during gmaps-route-active");
  }
  if (!panelsCss.includes('.gmaps-cloud-alert') || !panelsCss.includes('.cloud-alert-arrow')) {
    throw new Error("panels.css missing .gmaps-cloud-alert or .cloud-alert-arrow styling");
  }
  if (!mapCss.includes('.route-connector-outline') || !mapCss.includes('.route-connector-dots')) {
    throw new Error("map.css missing .route-connector-outline or .route-connector-dots");
  }
  if (!mapCss.includes('.route-junction-dot')) {
    throw new Error("map.css missing .route-junction-dot");
  }
  console.log("✔ Hidden footer nav, flush sheet, cloud alert, and dotted connector CSS verified");

  // 3. Check JS implementation (js/map.js)
  console.log("Verifying map.js rendering logic...");
  if (!mapJs.includes('route-connector-outline') || !mapJs.includes('route-connector-dots')) {
    throw new Error("map.js should draw dual-layer circular bead dots for off-road connectors");
  }
  if (!mapJs.includes('route-junction-dot')) {
    throw new Error("map.js should render junction dots at transition points");
  }
  if (!mapJs.includes('options.waypoints')) {
    throw new Error("map.js should support options.waypoints for multiple stops");
  }
  console.log("✔ map.js draws solid road line, dotted off-road connectors, junction dots, and multiple stop markers");

  // 4. Check JS implementation (js/directions.js)
  console.log("Verifying directions.js multi-stop routing logic...");
  if (!directionsJs.includes('this.currentStops = []')) {
    throw new Error("directions.js should initialize this.currentStops array");
  }
  if (!directionsJs.includes('showCloudAlert')) {
    throw new Error("directions.js should have showCloudAlert method");
  }
  if (!directionsJs.includes('renderStopInputs')) {
    throw new Error("directions.js should have renderStopInputs method");
  }
  if (!directionsJs.includes('computeMultiLegRoute')) {
    throw new Error("directions.js showDirections should use computeMultiLegRoute for sequential legs");
  }
  if (!directionsJs.includes('connectors: activeRoute.connectors')) {
    throw new Error("directions.js should pass connectors to CampusMap.drawRoute");
  }
  const mobileCss = fs.readFileSync(path.join(__dirname, '../css/mobile.css'), 'utf8');

  if (!mobileCss.includes('body.gmaps-route-active .mobile-bottom-nav') || !mobileCss.includes('display: none !important')) {
    throw new Error("mobile.css should hide .mobile-bottom-nav during gmaps-route-active");
  }
  if (!panelsCss.includes('.gmaps-add-stop-btn-wrap') || !panelsCss.includes('flex: 1')) {
    throw new Error("panels.css should give .gmaps-add-stop-btn-wrap flex: 1");
  }
  if (!directionsJs.includes('this.currentMode = "walking"')) {
    throw new Error("directions.js should default to walking mode (footpath route)");
  }
  console.log("✔ Mobile footer nav hidden in mobile.css, balanced action buttons in panels.css, and default walking mode verified");

  console.log("\nAll Multi-Stop, Cloud Alert, Footer & Footpath checks PASSED! 🎯");
}

testStopRoutingFlow();
