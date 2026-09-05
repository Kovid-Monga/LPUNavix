const assert = require('assert');

// 1. Setup Mock DOM & History
class MockHistory {
  constructor() {
    this.stack = [];
    this.index = -1;
  }
  get state() {
    return this.stack[this.index] || null;
  }
  pushState(state, title, url) {
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(JSON.parse(JSON.stringify(state)));
    this.index++;
  }
  replaceState(state, title, url) {
    if (this.index >= 0) {
      this.stack[this.index] = JSON.parse(JSON.stringify(state));
    } else {
      this.pushState(state, title, url);
    }
  }
  back() {
    if (this.index > 0) {
      this.index--;
      if (global.window && global.window._popstateHandler) {
        global.window._popstateHandler({ state: this.state });
      }
    }
  }
  go(delta) {
    const target = this.index + delta;
    if (target >= 0 && target < this.stack.length) {
      this.index = target;
      if (global.window && global.window._popstateHandler) {
        global.window._popstateHandler({ state: this.state });
      }
    }
  }
}

global.history = new MockHistory();
global.window = {
  history: global.history,
  addEventListener(event, handler) {
    if (event === 'popstate') {
      this._popstateHandler = handler;
    }
  },
  innerWidth: 400
};
global.localStorage = {
  getItem: () => null,
  setItem: () => {}
};

class MockElement {
  constructor(id) {
    this.id = id;
    const set = new Set();
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        if (force !== undefined) {
          if (force) set.add(c); else set.delete(c);
          return force;
        }
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
    };
    this.style = {};
  }
  addEventListener() {}
  closest() { return this; }
  querySelectorAll() { return []; }
  querySelector() { return new MockElement('sub'); }
}

const elements = {};
function getEl(id) {
  if (!elements[id]) elements[id] = new MockElement(id);
  return elements[id];
}

global.document = {
  getElementById: (id) => getEl(id),
  querySelectorAll: (sel) => [],
  querySelector: (sel) => getEl('mock'),
  documentElement: new MockElement('html'),
  body: new MockElement('body')
};

// Test Navigation State Logic
function runTests() {
  console.log('Testing Navigation State Transitions...');

  // Set Root
  global.history.replaceState({ type: 'map', depth: 0 }, '');
  assert.strictEqual(global.history.state.type, 'map');
  assert.strictEqual(global.history.state.depth, 0);

  function setNavState(type, data = {}, forceReplace = false) {
    const isRoot = type === 'map';
    let depth = 1;
    if (isRoot) {
      depth = 0;
    } else if (type === 'route') {
      const prevType = global.history.state?.type;
      depth = (prevType === 'details' || prevType === 'directions') ? 2 : 1;
    }

    const newState = { type, depth, ...data };
    const isSibling = global.history.state && global.history.state.depth === depth && depth > 0;
    if (forceReplace || isSibling) {
      global.history.replaceState(newState, '');
    } else {
      global.history.pushState(newState, '');
    }
  }

  // TEST 1: Open Karts -> pushes depth 1
  setNavState('karts');
  assert.strictEqual(global.history.state.type, 'karts');
  assert.strictEqual(global.history.state.depth, 1);
  assert.strictEqual(global.history.stack.length, 2);

  // Back from Karts -> returns to map
  let activePanel = 'karts-panel';
  global.window._popstateHandler = (e) => {
    if (e.state.type === 'map') activePanel = null;
  };
  global.history.back();
  assert.strictEqual(global.history.state.type, 'map');
  assert.strictEqual(activePanel, null);
  console.log('✔ Test 1 Passed: Karts open -> Back closes slide and returns to Map');

  // TEST 2: Sibling Location Replacement
  setNavState('details', { loc: { name: 'Location A' } });
  assert.strictEqual(global.history.state.loc.name, 'Location A');
  assert.strictEqual(global.history.stack.length, 2);

  // Directly select Location B while Location A is open
  setNavState('details', { loc: { name: 'Location B' } });
  assert.strictEqual(global.history.state.loc.name, 'Location B');
  // Must have replaced state, stack length must STILL be 2!
  assert.strictEqual(global.history.stack.length, 2);

  // Pressing Back from Location B must go to MAP (Home), NOT Location A!
  global.history.back();
  assert.strictEqual(global.history.state.type, 'map');
  console.log('✔ Test 2 Passed: Sibling Location B replaced Location A; Back goes directly to Map!');

  // TEST 3: Chained Navigation (Map -> Details -> Directions/Route -> Back -> Details -> Back -> Map)
  setNavState('details', { loc: { name: 'Location A' } });
  assert.strictEqual(global.history.state.type, 'details');
  assert.strictEqual(global.history.state.depth, 1);

  // Click Get Directions -> Route preview opens (depth 2)
  setNavState('route', { origin: 'Your location', dest: 'Location A', from: 'details' });
  assert.strictEqual(global.history.state.type, 'route');
  assert.strictEqual(global.history.state.depth, 2);
  assert.strictEqual(global.history.stack.length, 3);

  let currentView = 'route';
  global.window._popstateHandler = (e) => {
    currentView = e.state.type;
  };

  // Press Back from Route:
  global.history.back();
  assert.strictEqual(global.history.state.type, 'details');
  assert.strictEqual(currentView, 'details');
  assert.strictEqual(global.history.state.loc.name, 'Location A');
  console.log('✔ Test 3a Passed: Back from Route Preview restores Location Details card!');

  // Press Back from Location Details:
  global.history.back();
  assert.strictEqual(global.history.state.type, 'map');
  assert.strictEqual(currentView, 'map');
  console.log('✔ Test 3b Passed: Back from Location Details returns cleanly to Map!');

  // TEST 4: Explicit Close Discards Chain
  setNavState('settings');
  assert.strictEqual(global.history.state.type, 'settings');
  // Explicit close calls history.back()
  global.history.back();
  assert.strictEqual(global.history.state.type, 'map');

  // Now open Alerts
  setNavState('alerts');
  assert.strictEqual(global.history.state.type, 'alerts');
  assert.strictEqual(global.history.stack.length, 2); // [map, alerts]
  // Back from alerts goes to map, NEVER resurrects settings!
  global.history.back();
  assert.strictEqual(global.history.state.type, 'map');
  console.log('✔ Test 4 Passed: Explicit close discards chain, previous closed slides are never reopened!');

  console.log('\nAll Navigation Flow Verification Tests Passed Successfully! 🎉');
}

runTests();
