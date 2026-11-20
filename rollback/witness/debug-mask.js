/*
 * Debug-window entry: mask ONE registered serialization field and print where
 * the determinism evidence lands. This is the interactive form of the masking
 * experiments used by maintainers while evolving the state structure.
 *
 *   node rollback/witness/debug-mask.js <field>
 *
 * <field> is one of: particles, hitEligible, cooldown, rngState
 */
const W = require('./scenario.js');
const Ev = require('./evidence.js');
const REGISTRY = require('./field-registry.json');

const field = process.argv[2];
const known = Object.keys(REGISTRY.maskExperiments);
if (!field || !known.includes(field)) {
  console.error(`usage: node witness/debug-mask.js <${known.join('|')}>`);
  process.exit(2);
}

const r = W.runWitness();
const exp = r.experiments[field];
const c = exp.comparison;

console.log(`mask field        : ${field} (${exp.registryClass})`);
console.log(`registry expects  : deterministicBreak=${REGISTRY.maskExperiments[field].expectDeterministicBreak}`);
console.log(`observed          : deterministicBreak=${c.deterministicBreak}`);
if (c.firstMismatch) {
  const m = c.firstMismatch;
  console.log(`first mismatch    : frame=${m.frame} entity=${m.entity} field=${m.field}`);
  console.log(`                    noRollback=${JSON.stringify(m.valueNoRollback)}`);
  console.log(`                    rollback  =${JSON.stringify(m.valueRollback)}`);
} else {
  console.log('first mismatch    : none (the two worlds stay identical on all registered leaves)');
}
if (c.firstConsequentialMismatch) {
  const m = c.firstConsequentialMismatch;
  console.log(`gameplay break at : frame=${m.frame} entity=${m.entity} field=${m.field}`);
} else {
  console.log('gameplay break    : NONE — masking this field cannot change the game result');
}
console.log(`mismatch frames   : ${c.framesWithMismatch.length ? c.framesWithMismatch.join(',') : '(none)'}`);

// Non-zero exit only when the observed break contradicts the registry, so this
// doubles as a focused regression check during debugging.
const expected = REGISTRY.maskExperiments[field].expectDeterministicBreak;
process.exitCode = c.deterministicBreak === expected ? 0 : 1;
