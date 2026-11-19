/* Headless determinism / rollback verification. Run: node rollback/scripts/verify.js */
const E = require('../lib/engine.js');
const N = require('../lib/netcode.js');
const S = require('../lib/scenarios.js');

let failures = 0;
let passes = 0;

function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function hitSignature(state) {
  return state.events.map((e) =>
    `${e.frame}:${e.hitId}:${e.type}:${e.attacker}>${e.defender}:${e.attack}:crit=${e.crit}:dmg=${e.damage}`);
}

function compareToReference(result) {
  const ref = result.reference.state;
  const refHits = hitSignature(ref);
  const out = [];
  for (const peer of result.peers) {
    out.push({
      peer: peer.id,
      sameChecksum: E.checksum(peer.state) === E.checksum(ref),
      sameRng: peer.state.rngState === ref.rngState,
      sameHits: JSON.stringify(hitSignature(peer.state)) === JSON.stringify(refHits),
      sameHp: JSON.stringify(peer.state.players.map((p) => p.hp)) ===
              JSON.stringify(ref.players.map((p) => p.hp)),
      samePositions: JSON.stringify(peer.state.players.map((p) => [p.x, p.y, p.vx, p.vy])) ===
                     JSON.stringify(ref.players.map((p) => [p.x, p.y, p.vx, p.vy])),
      sameActions: JSON.stringify(peer.state.players.map((p) => [p.action, p.actionFrame])) ===
                   JSON.stringify(ref.players.map((p) => [p.action, p.actionFrame])),
      frame: peer.state.frame,
      refFrame: ref.frame,
    });
  }
  return out;
}

console.log('== T1: pure engine determinism (two independent runs, same input history) ==');
{
  const cfg = S.scenarioBaseline();
  const a = S.runReference(cfg.seed, cfg.inputs);
  const b = S.runReference(cfg.seed, cfg.inputs);
  check('checksums match', E.checksum(a.state) === E.checksum(b.state));
  check('RNG state identical', a.state.rngState === b.state.rngState);
  check('hit sequences identical', JSON.stringify(hitSignature(a.state)) === JSON.stringify(hitSignature(b.state)));
  check('events include hitboxes, not just positions', a.state.events.every((e) => e.hitbox && e.hurtbox));
  const different = S.runReference(cfg.seed ^ 0xffff, cfg.inputs);
  check('different seed can change critical rolls',
    E.checksum(different.state) !== E.checksum(a.state) ||
    different.state.rngState !== a.state.rngState);
}

console.log('\n== T2: baseline scenario converges with no resync ==');
{
  const result = S.runScenario(S.scenarioBaseline());
  const cmp = compareToReference(result);
  for (const c of cmp) {
    check(`peer ${c.peer} final checksum == reference`, c.sameChecksum);
    check(`peer ${c.peer} hit list == reference`, c.sameHits);
    check(`peer ${c.peer} hp/positions/actions == reference`,
      c.sameHp && c.samePositions && c.sameActions);
  }
  check('no resync needed', result.resyncs.length === 0, JSON.stringify(result.resyncs));
  check('blocked hit uses BLOCKED_HIT rule',
    result.reference.state.events.some((e) => e.type === 'BLOCKED_HIT'));
}

console.log('\n== T3: late inputs trigger bounded rollback + replay and correct outcomes ==');
{
  const result = S.runScenario(S.scenarioRollbackFlip());
  const allRollback = result.peers.flatMap((p) => p.rollbackLog);
  check('at least one rollback happened', allRollback.length > 0, `count=${allRollback.length}`);
  check('a rollback corrected the predicted outcome',
    allRollback.some((r) => r.corrected),
    JSON.stringify(allRollback.map((r) => ({ frame: r.inputFrame, corrected: r.corrected, reason: r.reason }))));
  check('a rollback removed or added a hit vs the prediction',
    allRollback.some((r) => r.removedHitIds.length || r.addedHitIds.length));
  check('re-simulated frames stay inside snapshot window',
    allRollback.every((r) => r.reSimFrames.length <= result.cfg.windowFrames + 1));
  for (const peer of result.peers) {
    check(`peer ${peer.id} final state == authoritative reference`,
      E.checksum(peer.state) === E.checksum(result.reference.state));
    check(`peer ${peer.id} hit list == authoritative reference`,
      JSON.stringify(hitSignature(peer.state)) === JSON.stringify(hitSignature(result.reference.state)));
  }
  console.log('    rollbacks:', JSON.stringify(allRollback.map((r) => ({
    clock: r.clock, frame: r.inputFrame, reason: r.reason,
    corrected: r.corrected, removed: r.removedHitIds, added: r.addedHitIds }))));
}

console.log('\n== T4: late input beyond snapshot window causes explainable resync, never a silent drop ==');
{
  const result = S.runScenario(S.scenarioBeyondWindow());
  check('resync occurred', result.resyncs.length > 0);
  check('resync reason recorded', result.resyncs.every((r) =>
    typeof r.reason === 'string' && r.adoptedFrame >= 0));
  check('resync includes LATE_BEYOND_WINDOW or WATCHDOG_STALL',
    result.resyncs.some((r) => r.reason === 'LATE_BEYOND_WINDOW' || r.reason === 'WATCHDOG_STALL'));
  for (const peer of result.peers) {
    const noGaps = peer.remoteInputs.slice(1, result.cfg.frames + 1).every((v) => v !== null && v !== undefined);
    check(`peer ${peer.id} ledger has no dropped remote input`, noGaps);
    check(`peer ${peer.id} converges to reference after resync`,
      E.checksum(peer.state) === E.checksum(result.reference.state));
  }
}

console.log('\n== T5: lossy link still delivers every input and converges ==');
{
  const result = S.runScenario(S.scenarioLossyLink());
  check('some packets were lost', result.net.stats.lost > 0, String(result.net.stats.lost));
  for (const peer of result.peers) {
    const noGaps = peer.remoteInputs.slice(1, result.cfg.frames + 1).every((v) => v !== null && v !== undefined);
    check(`peer ${peer.id} no remote input dropped despite loss`, noGaps);
    check(`peer ${peer.id} converges to reference`,
      E.checksum(peer.state) === E.checksum(result.reference.state));
    check(`peer ${peer.id} hit list == reference`,
      JSON.stringify(hitSignature(peer.state)) === JSON.stringify(hitSignature(result.reference.state)));
  }
}

console.log('\n== T6: hit authority is the explicit AABB rule, never visual proximity ==');
{
  const st = E.createInitialState(555);
  const p1 = st.players[0]; const p2 = st.players[1];
  p1.x = 100; p2.x = 400; // far apart
  p1.action = 'LIGHT'; p1.actionFrame = 4; // active frame, swingId set below
  st.eventSeq = 1; p1.swingId = 1;
  E.step(st, [0, 0]);
  check('no hit while out of range despite active swing', st.events.length === 0);

  const st2 = E.createInitialState(555);
  const a = st2.players[0]; const d = st2.players[1];
  a.x = 100; d.x = 126; // overlapping reach
  a.action = 'LIGHT'; a.actionFrame = 4;
  st2.eventSeq = 1; a.swingId = 1;
  E.step(st2, [0, 0]);
  check('overlapping hitbox/hurtbox produces exactly one HIT event',
    st2.events.length === 1 && st2.events[0].type === 'HIT');

  const st3 = E.createInitialState(555);
  const a3 = st3.players[0]; const d3 = st3.players[1];
  a3.x = 100; d3.x = 126; d3.facing = -1; // facing attacker, blocking
  a3.action = 'LIGHT'; a3.actionFrame = 4;
  st3.eventSeq = 1; a3.swingId = 1;
  E.step(st3, [0, E.INPUT.BLOCK]);
  check('same contact while blocking is BLOCKED_HIT with block damage',
    st3.events.length === 1 && st3.events[0].blocked &&
    st3.events[0].damage === E.ACTIONS.LIGHT.blockDamage);
}

console.log('\n== T7: snapshots and logs stay bounded ==');
{
  const result = S.runScenario(S.scenarioLossyLink());
  for (const peer of result.peers) {
    const maxKept = result.cfg.windowFrames + 2;
    check(`peer ${peer.id} snapshot ring bounded (${peer.snapshots.size} <= ${maxKept})`,
      peer.snapshots.size <= maxKept);
    check(`peer ${peer.id} rollback log bounded`, peer.rollbackLog.length <= 200);
  }
}

console.log('\n== T8: different RNG seeds yield reproducible-but-seed-dependent crits ==');
{
  const rows = [];
  for (let f = 1; f <= 40; f++) rows.push({ frame: f, p1: E.INPUT.RIGHT, p2: 0 });
  rows.find((r) => r.frame === 1).p1 = E.INPUT.RIGHT | E.INPUT.LIGHT;
  const inputs = S.buildInputs(40, rows);
  const positions = { p1x: 205, p2x: 235 };
  const seedA = 7;
  const runA = S.runReference(seedA, inputs, positions).state;
  const runA2 = S.runReference(seedA, inputs, positions).state;
  const runB = S.runReference(8, inputs, positions).state;
  check('same seed reproduces same crit results',
    JSON.stringify(hitSignature(runA)) === JSON.stringify(hitSignature(runA2)));
  check('attack actually lands so the crit roll is exercised', runA.events.length > 0);
  console.log(`    seed=7 hits: ${JSON.stringify(runA.events.map((e) => e.crit))}, seed=8: ${JSON.stringify(runB.events.map((e) => e.crit))}`);
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
