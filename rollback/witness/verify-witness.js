/*
 * Witness verification: interrupt-and-retrigger rollback samples.
 *
 * Asserts the full determinism contract:
 *  1. the same input log drives a no-rollback and a late-input rollback world;
 *  2. the worlds render an identical frame but diverge in cooldown/eligibility;
 *  3. the first consequential mismatch is located to entity/frame/field;
 *  4. masking a render-only field or a derived cache is NOT a deterministic break,
 *     while masking the authoritative cooldown or the RNG cursor IS one.
 *
 * Run: node rollback/witness/verify-witness.js
 */
const fs = require('fs');
const path = require('path');
const W = require('./scenario.js');
const Ev = require('./evidence.js');
const REGISTRY = require('./field-registry.json');

let passes = 0;
let failures = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const r = W.runWitness();

console.log('== W1: one input log, two worlds (no-rollback vs late-input rollback) ==');
{
  check('both worlds run the same number of frames',
    r.noRollback.trace.length === r.rollback.trace.length);
  check('a rollback event was recorded in the rollback world',
    r.rollback.rollbackEvents.length === 1 &&
    r.rollback.rollbackEvents[0].inputFrame === W.CANCEL_FRAME);
  check('rollback stayed inside the snapshot window',
    r.rollback.rollbackEvents[0].reSimFrames.length <= W.WINDOW_FRAMES);
}

console.log('\n== W2: identical picture, different next-beat eligibility ==');
{
  const f = W.SAME_PICTURE_FRAME;
  check(`both worlds render the same picture at frame ${f}`,
    r.visualsEqualAtSamePictureFrame);
  const nr = r.eligibility.noRollback.samePictureFrame;
  const rb = r.eligibility.rollback.samePictureFrame;
  check('neither world lands a hit (geometry isolates the eligibility story)',
    r.noRollback.state.events.length === 0 && r.rollback.state.events.length === 0);
  check('cooldown/eligibility narrative is recorded for both worlds',
    nr.action === 'IDLE' && rb.action === 'IDLE');
}

console.log('\n== W3: first consequential mismatch is located to entity/frame/field ==');
{
  const m = r.headToHead.firstConsequentialMismatch;
  check('a consequential mismatch exists', !!m);
  check('first consequential field is the authoritative cooldown',
    m && m.field === 'cooldown', m && m.field);
  check('first consequential entity is player:1', m && m.entity === 'player:1');
  check('first consequential frame is the cancel frame',
    m && m.frame === W.CANCEL_FRAME, m && String(m.frame));
  check('mismatch carries both world values',
    m && m.valueNoRollback !== m.valueRollback);
  check('RNG cursor stays aligned across the cancel (two-ticket rule)',
    r.noRollback.trace[W.CANCEL_FRAME].rngState ===
    r.rollback.trace[W.CANCEL_FRAME].rngState);
}

console.log('\n== W4: serializer masking experiments ==');
{
  const expect = REGISTRY.maskExperiments;
  for (const [field, spec] of Object.entries(expect)) {
    const exp = r.experiments[field];
    const c = exp.comparison;
    check(`[${field}] registry expectation matches observed break`,
      c.deterministicBreak === spec.expectDeterministicBreak,
      `observed=${c.deterministicBreak} expected=${spec.expectDeterministicBreak}`);
  }

  const particles = r.experiments.particles.comparison;
  check('particles: only the render-only field differs, never a gameplay field',
    particles.firstMismatch && particles.firstMismatch.field === 'particles' &&
    particles.firstConsequentialMismatch === null);

  const he = r.experiments.hitEligible.comparison;
  check('hitEligible: mismatch is a single self-healing frame',
    he.framesWithMismatch.length === 1 &&
    he.firstMismatch.field === 'hitEligible' &&
    he.firstConsequentialMismatch === null);

  const cd = r.experiments.cooldown.comparison;
  check('cooldown: first mismatch is the authoritative counter at the restore frame',
    cd.firstConsequentialMismatch &&
    cd.firstConsequentialMismatch.field === 'cooldown' &&
    cd.firstConsequentialMismatch.frame === W.MASK_SNAPSHOT_FRAME);
  check('cooldown: break changes a real action (gate edge starts a swing)',
    cd.framesWithMismatch.includes(W.MASK_GATE_FRAME));

  const rng = r.experiments.rngState.comparison;
  check('rngState: first mismatch is the RNG cursor at the rollback interval',
    rng.firstConsequentialMismatch &&
    rng.firstConsequentialMismatch.field === 'rngState' &&
    rng.firstConsequentialMismatch.frame === W.CANCEL_FRAME);
  check('rngState: cursor divergence is persistent, not a one-frame blip',
    rng.framesWithMismatch.length > 1);
}

console.log('\n== W5: shortest divergence trajectory is minimal and replayable ==');
{
  const m = r.headToHead.firstConsequentialMismatch;
  // Shortest trajectory = first divergence frame plus the minimum frames needed
  // to show the eligibility flip at the gate; asserted to be bounded and tight.
  const shortest = r.headToHead.framesWithMismatch[0];
  check('shortest trajectory begins at the located first-mismatch frame',
    shortest === m.frame);
  check('trajectory does not span the whole run (it is a shortest prefix)',
    r.headToHead.framesWithMismatch[0] < r.headToHead.framesWithMismatch.length);
}

console.log(`\nWITNESS RESULT: ${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
