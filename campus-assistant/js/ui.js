/**
 * DEMO STUB — for running this prototype standalone only.
 *
 * Your real project already has a full UIController with a working
 * triggerShowOnMap(locationId, targetTitle). Do NOT replace your real
 * js/ui.js with this file. Instead, in your real UIController, make
 * exactly two changes:
 *
 *   1. Add 'assistant' to the view list, e.g.:
 *        this.views = ['map', 'directory', 'search', 'assistant'];
 *
 *   2. Nothing else — triggerShowOnMap already exists and this
 *      prototype's AssistantController calls it as-is.
 *
 * The minimal stub below exists purely so this standalone demo has
 * *something* to call, so you can see the "Show on map" button work
 * end-to-end before wiring it into the real map.
 */
class UIController {
  constructor() {
    this.views = ['map', 'directory', 'search', 'assistant'];
  }

  triggerShowOnMap(locationId, targetTitle) {
    console.log(`[UIController demo stub] triggerShowOnMap(${locationId}, "${targetTitle}")`);
    const toast = document.createElement('div');
    toast.className = 'demo-map-toast';
    toast.textContent = `📍 Would show "${targetTitle || locationId}" on the map now.`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }
}

if (typeof window !== 'undefined') {
  window.UIController = UIController;
}
