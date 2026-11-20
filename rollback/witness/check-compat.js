/*
 * Compatibility gate: re-run the witness and diff the located mismatches
 * against the pinned compat-samples.json. A maintainer who changes the state
 * structure runs this after re-generating samples; an unexpected drift in any
 * registered field's break classification or first-mismatch coordinate fails.
 *
 * Run: node rollback/witness/check-compat.js
 */
const fs = require('fs');
const path = require('path');
const W = require('./scenario.js');
const REGISTRY = require('./field-registry.json');

const compatFile = path.join(__dirname, 'compat', 'compat-samples.json');
const pinned = JSON.parse(fs.readFileSync(compatFile, 'utf8'));
const current = W.runWitness();

let passes = 0;
let failures = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

check('schema version matches registry',
  pinned.schemaVersion === REGISTRY.schemaVersion,
  `${pinned.schemaVersion} vs ${REGISTRY.schemaVersion}`);

{
  const m = current.headToHead.firstConsequentialMismatch;
  const p = pinned.headToHead.firstConsequentialMismatch;
  check('head-to-head first mismatch frame is stable', m.frame === p.frame, `${m.frame} vs ${p.frame}`);
  check('head-to-head first mismatch entity is stable', m.entity === p.entity);
  check('head-to-head first mismatch field is stable', m.field === p.field);
  check('same-picture frame still renders identically',
    current.visualsEqualAtSamePictureFrame === pinned.headToHead.samePictureVisualEqual);
}

for (const [field, expected] of Object.entries(pinned.expectedByField)) {
  const exp = current.experiments[field];
  const c = exp.comparison;
  check(`[${field}] break classification stable`,
    c.deterministicBreak === expected.deterministicBreak,
    `${c.deterministicBreak} vs ${expected.deterministicBreak}`);
  if (expected.firstMismatch) {
    const got = c.firstMismatch;
    check(`[${field}] first-mismatch frame stable`,
      got && got.frame === expected.firstMismatch.frame,
      got ? `${got.frame} vs ${expected.firstMismatch.frame}` : 'no mismatch');
    check(`[${field}] first-mismatch entity/field stable`,
      got && got.entity === expected.firstMismatch.entity &&
      got.field === expected.firstMismatch.field);
  } else {
    check(`[${field}] still has no mismatch`, c.firstMismatch === null);
  }
}

console.log(`\nCOMPAT RESULT: ${passes} passed, ${failures} failed`);
if (failures) {
  console.log('Drift detected. If the state structure changed intentionally, regenerate:');
  console.log('  node rollback/witness/save-witness.js');
}
process.exitCode = failures ? 1 : 0;
