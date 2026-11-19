/* Minimal DOM shim smoke test for the browser bundle (no browser/jsdom here).
 * Scripts are evaluated as browser-style globals via vm (module is undefined),
 * exercising the exact code paths index.html loads.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const noop = () => {};

function makeEl(id) {
  const el = {
    id,
    textContent: '',
    value: id === 'windowSize' ? '30' : id === 'latency' ? '8' :
      id === 'jitter' ? '2' : id === 'loss' ? '10' :
      id === 'speedSelect' ? '1' : 'flip',
    children: [],
    childElementCount: 0,
    style: {},
    remove: noop,
    getContext: () => new Proxy({}, { get: () => noop }),
    addEventListener: noop,
  };
  el.prepend = (child) => {
    el.children.unshift(child);
    el.childElementCount = el.children.length;
    while (el.children.length > 200) el.children.pop();
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children.length = 0; el.childElementCount = 0; },
  });
  Object.defineProperty(el, 'lastChild', {
    get() { return el.children[el.children.length - 1] || null; },
  });
  return el;
}

const ids = ['modeLabel', 'eventLog', 'canvas1', 'canvas2', 'canvas1Status', 'canvas2Status',
  'clockLabel', 'netLabel', 'refLabel', 'btnPlay', 'btnStep', 'btnReset', 'scenarioSelect',
  'btnInteractive', 'speedSelect', 'btnHitboxes', 'windowSize', 'latency', 'jitter', 'loss'];
const els = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));

let queued = [];
const sandbox = {
  console,
  document: {
    getElementById: (id) => els[id] || makeEl(id),
    createElement: () => makeEl('dyn'),
  },
  setTimeout: (fn) => { queued.push(fn); return queued.length; },
  clearTimeout: noop,
  addEventListener: noop,
  Math, JSON, Object, Array, Set, Map, Proxy, Infinity,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
function flushTimers() {
  const q = queued; queued = [];
  for (const fn of q) fn();
}
function load(rel) {
  const code = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

load('lib/engine.js');
load('lib/netcode.js');
load('lib/scenarios.js');
load('lib/app.js');

const E = sandbox.RollbackEngine;
const demo = sandbox.rollbackDemo;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL', msg); process.exitCode = 1; }
  else console.log('PASS', msg);
}

function ledgersSettled() {
  const a = demo.app;
  if (a.clock <= a.scriptFrames || a.net.inFlight() !== 0) return false;
  if (a.peers.some((p) => p.needsResync)) return false;
  return a.peers.every((p) => {
    for (let f = 1; f <= a.scriptFrames; f++) {
      if (p.localInputs[f] === null || p.localInputs[f] === undefined) return false;
      if (p.remoteInputs[f] === null || p.remoteInputs[f] === undefined) return false;
    }
    return true;
  });
}

assert(demo && demo.app.peers && demo.app.net, 'app initialized with two peers and network');
assert(demo.app.mode === 'script', 'starts in script mode');

// run the whole flip scenario through the exact UI tick path
let guard = 0;
while (!ledgersSettled() && demo.app.clock < demo.app.maxClock && guard++ < 2000) {
  demo.tick();
  flushTimers();
  demo.app.running = false; // drive manually instead of letting the timer self-schedule
}
const app = demo.app;
const refHash = E.checksum(app.refState);
assert(E.checksum(app.peers[0].state) === refHash, 'UI peer1 converges to authoritative reference');
assert(E.checksum(app.peers[1].state) === refHash, 'UI peer2 converges to authoritative reference');
const allRb = app.peers.flatMap((p) => p.rollbackLog);
assert(allRb.some((r) => r.removedHitIds.length || r.addedHitIds.length),
  'UI path recorded a hit-changing rollback');
assert(els.eventLog.children.some((c) => String(c.className).includes('rollback-hit')),
  'hit-changing rollback rendered into the event log');
assert(els.eventLog.children.some((c) => String(c.className).includes('final')),
  'final convergence summary rendered');

// interactive mode: drive keys for 121 ticks through the same path
demo.startInteractive();
assert(app.mode === 'interactive', 'switches to interactive mode');
demo.setKey(1, E.INPUT.RIGHT, true);
demo.setKey(2, E.INPUT.LEFT, true);
for (let k = 0; k < 40; k++) { demo.tick(); flushTimers(); }
demo.setKey(1, E.INPUT.LIGHT, true); // edge held one frame
demo.tick(); flushTimers();
demo.setKey(1, E.INPUT.LIGHT, false);
demo.setKey(2, E.INPUT.LEFT, false);
demo.setKey(2, E.INPUT.BLOCK, true);
for (let k = 0; k < 80; k++) { demo.tick(); flushTimers(); }
assert(app.peers[0].state.frame === 121 && app.peers[1].state.frame === 121,
  'both interactive peers advance in lockstep to frame 121');
assert(E.checksum(app.peers[0].state) === E.checksum(app.peers[1].state),
  'interactive peers produce identical checksums from the same inputs');

// resync scenario through UI
demo.loadScenario('resync');
guard = 0;
while (!ledgersSettled() && demo.app.clock < demo.app.maxClock && guard++ < 500) {
  demo.tick();
  flushTimers();
  demo.app.running = false;
}
assert(demo.app.peers.some((p) => p.resyncLog.length > 0), 'UI path records an explainable resync');
assert(els.eventLog.children.some((c) => String(c.className).includes('resync')),
  'resync reason rendered into the event log');
assert(E.checksum(demo.app.peers[0].state) === E.checksum(demo.app.refState) &&
  E.checksum(demo.app.peers[1].state) === E.checksum(demo.app.refState),
  'resync scenario converges after hard resync');

console.log(process.exitCode ? '\nBROWSER SMOKE: FAILURES' : '\nBROWSER SMOKE: ALL OK');
