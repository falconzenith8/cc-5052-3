/*
 * Generate and persist the rollback witness artifacts:
 *   traces/divergence-shortest.json   - shortest head-to-head divergence trajectory
 *   traces/mask-<field>.json          - one artifact per registry masking experiment
 *   compat/compat-samples.json        - canonical expected outcomes (compatibility samples)
 *
 * Run: node rollback/witness/save-witness.js
 */
const fs = require('fs');
const path = require('path');
const E = require('../lib/engine.js');
const W = require('./scenario.js');
const Ev = require('./evidence.js');
const REGISTRY = require('./field-registry.json');

const traceDir = path.join(__dirname, 'traces');
const compatDir = path.join(__dirname, 'compat');
fs.mkdirSync(traceDir, { recursive: true });
fs.mkdirSync(compatDir, { recursive: true });

const r = W.runWitness();

function slimState(s) {
  return {
    frame: s.frame,
    rngState: s.rngState,
    players: s.players.map((p) => ({
      id: p.id, x: p.x, y: p.y, action: p.action, actionFrame: p.actionFrame,
      hp: p.hp, cooldown: p.cooldown, hitEligible: p.hitEligible,
      particles: p.particles, pendingCritRoll: p.pendingCritRoll,
    })),
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  console.log('wrote', path.relative(path.join(__dirname, '..'), file));
}

// ---- shortest head-to-head divergence trajectory --------------------------
// Keep only the frames from the shared prefix through the first consequential
// mismatch and the next-beat gate that proves the eligibility flip.
const firstFrame = r.headToHead.firstConsequentialMismatch.frame;
const gateFrame = r.config.retriggerFrame;
const stopFrame = Math.min(gateFrame, r.config.lastFrame);
const shortest = {
  kind: 'shortest-divergence-trajectory',
  schemaVersion: REGISTRY.schemaVersion,
  generatedFrom: 'witness/scenario.js runWitness().headToHead',
  seed: r.config.seed,
  locatedFirstMismatch: r.headToHead.firstConsequentialMismatch,
  frameRange: [firstFrame, stopFrame],
  samePictureFrame: r.config.samePictureFrame,
  inputLog: { p1: r.inputLog[0], p2: r.inputLog[1] },
  frames: [],
};
for (let f = firstFrame; f <= stopFrame; f++) {
  shortest.frames.push({
    frame: f,
    noRollback: slimState(r.noRollback.trace[f]),
    rollback: slimState(r.rollback.trace[f]),
    visualEqual: Ev.visualSignature(r.noRollback.trace[f]) ===
      Ev.visualSignature(r.rollback.trace[f]),
  });
}
writeJson(path.join(traceDir, 'divergence-shortest.json'), shortest);

// ---- one trace artifact per masking experiment -----------------------------
for (const [field, exp] of Object.entries(r.experiments)) {
  const c = exp.comparison;
  const start = c.firstMismatch ? c.firstMismatch.frame : r.config.maskSnapshotFrame;
  const end = c.framesWithMismatch.length
    ? c.framesWithMismatch[c.framesWithMismatch.length - 1]
    : r.config.maskSnapshotFrame;
  const artifact = {
    kind: 'mask-experiment',
    schemaVersion: REGISTRY.schemaVersion,
    maskedField: field,
    registryClass: exp.registryClass,
    expectDeterministicBreak: REGISTRY.maskExperiments[field].expectDeterministicBreak,
    observedDeterministicBreak: c.deterministicBreak,
    firstMismatch: c.firstMismatch,
    firstConsequentialMismatch: c.firstConsequentialMismatch,
    framesWithMismatch: c.framesWithMismatch,
    mismatchWindow: [start, end],
  };
  writeJson(path.join(traceDir, `mask-${field}.json`), artifact);
}

// ---- canonical compatibility samples --------------------------------------
// These are the expected outcomes a maintainer's serializer must reproduce as
// the state structure evolves. They pin the first-mismatch coordinates and the
// break classification for every registered field.
const compat = {
  kind: 'compatibility-samples',
  schemaVersion: REGISTRY.schemaVersion,
  engine: {
    cooldownFull: E.ATTACK_COOLDOWN_FULL,
    cooldownCancelRefund: E.ATTACK_COOLDOWN_CANCEL_REFUND,
  },
  scenario: r.config,
  headToHead: {
    firstConsequentialMismatch: r.headToHead.firstConsequentialMismatch,
    samePictureFrame: r.config.samePictureFrame,
    samePictureVisualEqual: r.visualsEqualAtSamePictureFrame,
  },
  expectedByField: {},
};
for (const [field, exp] of Object.entries(r.experiments)) {
  const c = exp.comparison;
  compat.expectedByField[field] = {
    registryClass: exp.registryClass,
    deterministicBreak: c.deterministicBreak,
    firstMismatch: c.firstMismatch && {
      frame: c.firstMismatch.frame,
      entity: c.firstMismatch.entity,
      field: c.firstMismatch.field,
    },
  };
}
writeJson(path.join(compatDir, 'compat-samples.json'), compat);
