import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def test_all():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    with open(os.path.join(base_dir, 'index.html'), 'r', encoding='utf-8') as f:
        html = f.read()
    with open(os.path.join(base_dir, 'js', 'directions.js'), 'r', encoding='utf-8') as f:
        directions_js = f.read()
    with open(os.path.join(base_dir, 'js', 'map.js'), 'r', encoding='utf-8') as f:
        map_js = f.read()
    with open(os.path.join(base_dir, 'js', 'ui.js'), 'r', encoding='utf-8') as f:
        ui_js = f.read()
    with open(os.path.join(base_dir, 'js', 'assistant.js'), 'r', encoding='utf-8') as f:
        assistant_js = f.read()
    with open(os.path.join(base_dir, 'css', 'panels.css'), 'r', encoding='utf-8') as f:
        panels_css = f.read()
    with open(os.path.join(base_dir, 'css', 'map.css'), 'r', encoding='utf-8') as f:
        map_css = f.read()

    # 1. Check Floating Map Controls
    for ctrl in ['id="ctrl-floating-layers"', 'id="ctrl-recenter"', 'id="ctrl-compass"']:
        assert ctrl in html, f"Missing {ctrl} in index.html"
    print("✔ Floating map controls present")

    # 2. Check Route Topbar Card
    for item in [
        'id="gmaps-route-topbar"',
        'class="gmaps-ring-origin"',
        'id="gmaps-topbar-origin-input"',
        'id="gmaps-topbar-menu-btn"',
        'class="gmaps-connector-dots"',
        'class="gmaps-pin-dest"',
        'id="gmaps-topbar-dest-input"',
        'id="gmaps-topbar-swap-btn"',
        'id="gmaps-topbar-menu-dropdown"',
        'id="gmaps-topbar-stops-container"',
        'id="gmaps-add-stop-cloud-alert"',
        'class="gmaps-cloud-alert"'
    ]:
        assert item in html, f"Missing {item} in index.html"
    print("✔ Topbar card and stops container verified")

    # 3. Check Route Preview Sheet with Walk & Kart
    for item in [
        'id="gmaps-route-preview-sheet"',
        'class="gmaps-sheet-handle"',
        'Your route',
        'Get to your destination easily',
        'id="gmaps-preview-close-btn"',
        'data-mode="walking"',
        'data-mode="drive"',
        'id="gmaps-tab-walk-time"',
        'id="gmaps-tab-drive-time"',
        'id="gmaps-tab-walk-dist"',
        'id="gmaps-tab-drive-dist"',
        'id="gmaps-preview-duration"',
        'id="gmaps-preview-dist"',
        'Recommended route',
        'id="gmaps-start-action-btn"',
        'id="gmaps-add-stops-action-btn"',
        'id="gmaps-share-action-btn"'
    ]:
        assert item in html, f"Missing {item} in index.html"
    print("✔ Route preview sheet with Walk and Kart pills verified")

    # 4. Check CSS
    assert '.origin-ring-dot' in map_css
    assert '.route-marker-pill' in map_css
    assert '.stop-dot-marker' in map_css
    assert '.route-connector-outline' in map_css
    assert '.route-connector-dots' in map_css
    assert '.route-junction-dot' in map_css
    assert '.route-dark-nav-path' in map_css
    assert '.route-dotted-preview-path' in map_css
    assert '.map-route-floating-badge' in map_css
    assert 'body.navigation-active' in map_css
    print("✔ Map CSS styles verified (dotted preview, dark navigation, on-route badge)")

    # 5. Check JS logic
    assert '#f97316' in map_js
    assert 'origin-ring-dot' in map_js
    assert 'route-marker-pill' in map_js
    assert 'stop-route-marker' in map_js
    assert 'stop-dot-marker' in map_js
    assert 'mainLineColor = "#0f172a"' in map_js
    assert 'dashArray: mainLineDashArray' in map_js
    assert 'map-route-floating-badge' in map_js
    print("✔ map.js verified (dark navigation line, dotted preview, on-route badge)")

    assert 'gmaps-topbar-menu-dropdown' in directions_js
    assert 'gmaps-add-stops-action-btn' in directions_js
    assert 'this.currentStops' in directions_js
    assert 'connectors: activeRoute.connectors' in directions_js
    assert 'this.currentMode = "walking"' in directions_js
    assert 'walkDuration: walkRoute.duration' in directions_js
    assert 'kartDuration: driveRoute.duration' in directions_js
    assert 'isNavigating: false' in directions_js
    assert 'gmaps-tab-walk-dist' in directions_js
    assert 'gmaps-tab-drive-dist' in directions_js
    print("✔ directions.js verified (multimodal Walk & Kart, distances, dotted preview)")

    assert 'triggerShowOnMap' in ui_js
    assert 'startActiveNavigation' in ui_js
    assert 'navigation-active' in ui_js
    assert 'isNavigating: true' in ui_js
    print("✔ ui.js verified (triggerShowOnMap, startActiveNavigation)")

    assert 'triggerShowOnMap' in assistant_js
    print("✔ assistant.js verified")

    print("\n🎉 ALL TESTS AND ASSERTIONS PASSED PERFECTLY!")

if __name__ == '__main__':
    test_all()
