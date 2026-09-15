/**
 * App init sequence.
 *
 * MERGE NOTE: in your real js/app.js, wherever the existing init
 * sequence constructs `uiController` and other controllers, add these
 * two lines (order matters: uiController must exist first so
 * AssistantController can call its triggerShowOnMap):
 *
 *   const assistant = new AssistantController({ uiController });
 *   assistant.init();
 *
 * Everything else in this file is demo-only wiring so the standalone
 * prototype boots on its own.
 */
document.addEventListener('DOMContentLoaded', () => {
  const uiController = new UIController();

  const assistant = new AssistantController({ uiController });
  assistant.init();

  window.uiController = uiController;
  window.assistant = assistant;
});
