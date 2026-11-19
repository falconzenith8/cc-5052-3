/*
 * Scenario runner that prints rollback-corrected hit results and final state
 * summaries, and writes machine-readable JSON next to this script.
 *   node rollback/scripts/report.js [scenarioName]
 */
const fs = require('fs');
const path = require('path');
const E = require('../lib/engine.js');
const S = require('../lib/scenarios.js');

const SCENARIOS = {
  baseline: S.scenarioBaseline,
  flip: S.scenarioRollbackFlip,
  resync: S.scenarioBeyondWindow,
  lossy: S.scenarioLossyLink,
};

function hitLine(ev) {
  const hpAfter = ev.hpAfter !== undefined ? ev.hpAfter :
    (ev.defenderHpAfter !== undefined ? ev.defenderHpAfter : '?');
  return `frame ${String(ev.frame).padStart(3)}  ${ev.type.padEnd(11)} ` +
    `P${ev.attacker} ${ev.attack} -> P${ev.defender}  crit=${ev.crit}  dmg=${ev.damage}  hpAfter=${hpAfter}`;
}

function runOne(name, factory) {
  const result = S.runScenario(factory());
  const ref = result.reference.state;
  const out = {
    scenario: name,
    config: {
      seed: result.cfg.seed, frames: result.cfg.frames,
      windowFrames: result.cfg.windowFrames, latency: result.cfg.latency,
      jitter: result.cfg.jitter, lossPct: result.cfg.lossPct,
      networkSeed: result.cfg.networkSeed, stalls: result.cfg.stalls || [],
      positions: result.cfg.positions || null,
    },
    network: result.net.stats,
    peerStats: result.peers.map((p) => p.stats),
    rollbacks: result.peers.map((p) => p.rollbackLog.map((r) => ({
      clock: r.clock, inputFrame: r.inputFrame, reason: r.reason,
      predictedInput: r.predictedInput, actualInput: r.actualInput,
      reSimFrames: [r.reSimFrames[0], r.reSimFrames[r.reSimFrames.length - 1]],
      corrected: r.corrected,
      removedHitIds: r.removedHitIds, addedHitIds: r.addedHitIds,
      checksumBefore: r.checksumBefore, checksumAfter: r.checksumAfter,
    }))),
    resyncs: result.resyncs.map((r) => ({
      reason: r.reason, sourcePeer: r.sourcePeer, adoptedFrame: r.adoptedFrame,
      detail: r.detail, checksumBefore: r.checksumBefore, checksumAfter: r.checksumAfter,
    })),
    authoritativeHits: S.hitsOf(ref),
    finalSummary: E.summarize(ref),
    peerConvergence: result.peers.map((p) => ({
      peer: p.id,
      matchesReference: E.checksum(p.state) === E.checksum(ref),
      checksum: E.checksum(p.state),
    })),
  };
  return out;
}

const wanted = process.argv[2];
const names = wanted ? [wanted] : Object.keys(SCENARIOS);
const all = {};
for (const name of names) {
  if (!SCENARIOS[name]) {
    console.error(`unknown scenario '${name}'; choose from ${Object.keys(SCENARIOS).join(', ')}`);
    process.exitCode = 1;
    continue;
  }
  const report = runOne(name, SCENARIOS[name]);
  all[name] = report;

  console.log(`\n===== ${report.scenario} =====`);
  console.log('config:', JSON.stringify(report.config));
  console.log('network packets:', JSON.stringify(report.network));
  for (const p of report.peerStats) {
    console.log(`peer stats: ${JSON.stringify(p)}`);
  }
  for (let i = 0; i < report.rollbacks.length; i++) {
    for (const r of report.rollbacks[i]) {
      console.log(`ROLLBACK peer${i + 1} clock=${r.clock} inputFrame=${r.inputFrame} ` +
        `${r.reason} predicted=${r.predictedInput} actual=${r.actualInput} ` +
        `reSim=${r.reSimFrames[0]}..${r.reSimFrames[1]} corrected=${r.corrected} ` +
        `removedHits=[${r.removedHitIds}] addedHits=[${r.addedHitIds}]`);
    }
  }
  for (const r of report.resyncs) {
    console.log(`RESYNC ${r.reason} source=peer${r.sourcePeer} adoptedFrame=${r.adoptedFrame} detail=${JSON.stringify(r.detail)}`);
  }
  console.log('authoritative hit results:');
  if (!report.authoritativeHits.length) console.log('  (none)');
  for (const h of report.authoritativeHits) console.log('  ' + hitLine(h));
  console.log('final state summary:');
  for (const p of report.finalSummary.players) {
    console.log(`  P${p.id} pos=(${p.x},${p.y}) v=(${p.vx},${p.vy}) hp=${p.hp} ` +
      `action=${p.action} phase=${p.phase} actionFrame=${p.actionFrame} blocking=${p.blocking} invuln=${p.invuln}`);
  }
  for (const c of report.peerConvergence) {
    console.log(`convergence peer${c.peer}: ${c.matchesReference ? 'MATCHES reference checksum' : 'DIVERGED'} (${c.checksum})`);
  }
}

const outFile = path.join(__dirname, 'report.json');
fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
console.log(`\nwrote ${outFile}`);
