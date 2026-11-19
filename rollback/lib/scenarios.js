/*
 * Scripted scenarios + the authoritative reference runner.
 *
 * The reference run is a pure, network-free E.step loop over the exact same
 * input history. Peer results must match its checksums, RNG state and hit
 * events: that is the determinism contract of the rollback system.
 */
(function (global) {
  'use strict';

  const E = (typeof module !== 'undefined' && module.exports)
    ? require('./engine.js')
    : global.RollbackEngine;
  const N = (typeof module !== 'undefined' && module.exports)
    ? require('./netcode.js')
    : global.RollbackNetcode;

  const I = E.INPUT;

  // Sparse rows [{frame, p1, p2}] -> dense input arrays with 0 fill.
  function buildInputs(frames, rows) {
    const p1 = new Array(frames + 1).fill(0);
    const p2 = new Array(frames + 1).fill(0);
    for (const r of rows) {
      p1[r.frame] = r.p1;
      p2[r.frame] = (r.p2 === undefined ? 0 : r.p2);
    }
    return [p1, p2];
  }

  function runReference(seed, inputs, positions) {
    const state = E.createInitialState(seed >>> 0);
    if (positions) {
      state.players[0].x = positions.p1x;
      state.players[1].x = positions.p2x;
      state.players[0].facing = 1;
      state.players[1].facing = -1;
    }
    const hashes = [E.checksum(state)];
    for (let f = 1; f < inputs[0].length; f++) {
      E.step(state, [inputs[0][f], inputs[1][f]]);
      hashes.push(E.checksum(state));
    }
    return { state, hashes };
  }

  function reconcile(peers, clock) {
    const entries = [];
    let guard = 0;
    while ((peers[0].needsResync || peers[1].needsResync) && guard++ < 10) {
      const needy = peers.find((p) => p.needsResync);
      const other = peers.find((p) => p !== needy);
      const req = needy.needsResync;
      entries.push(needy.resyncFrom(other, req.reason, Object.assign({ clock }, req.detail)));
    }
    return entries;
  }

  // cfg: {seed, frames, inputs, windowFrames, latency, jitter, lossPct,
  //       networkSeed, stalls:[{receiver,from,to}], inputTimeout, flush}
  function runScenario(cfg) {
    const inputs = cfg.inputs;
    const frames = cfg.frames;
    const flush = cfg.flush ?? 120;

    const reference = runReference(cfg.seed, inputs, cfg.positions);

    const p1 = new N.Peer(1, { seed: cfg.seed, windowFrames: cfg.windowFrames, inputTimeout: cfg.inputTimeout });
    const p2 = new N.Peer(2, { seed: cfg.seed, windowFrames: cfg.windowFrames, inputTimeout: cfg.inputTimeout });
    if (cfg.positions) {
      for (const peer of [p1, p2]) {
        peer.state.players[0].x = cfg.positions.p1x;
        peer.state.players[1].x = cfg.positions.p2x;
        peer.state.players[0].facing = 1;
        peer.state.players[1].facing = -1;
        peer.snapshots.set(0, E.cloneState(peer.state));
        peer.frameHashes[0] = E.checksum(peer.state);
      }
    }
    const peers = [p1, p2];
    const net = new N.Network({
      latency: cfg.latency, jitter: cfg.jitter, lossPct: cfg.lossPct,
      networkSeed: cfg.networkSeed,
    });
    for (const s of cfg.stalls || []) net.setStall(s.receiver, s.from, s.to);

    const resyncs = [];
    const trace = [];
    const total = frames + flush;
    for (let clock = 1; clock <= total; clock++) {
      net.deliver(clock, peers);
      for (const r of reconcile(peers, clock)) resyncs.push(r);

      if (clock <= frames) {
        const advanced1 = p1.advance(inputs[0][clock], clock);
        const advanced2 = p2.advance(inputs[1][clock], clock);
        trace.push({ clock, advanced1, advanced2, f1: p1.state.frame, f2: p2.state.frame });
        net.send(p1, clock);
        net.send(p2, clock);
      } else {
        net.send(p1, clock); // retransmit bundles until every entry lands
        net.send(p2, clock);
        if (net.inFlight() === 0 &&
            ledgersComplete(p1, frames) && ledgersComplete(p2, frames)) break;
      }
    }
    net.deliver(total + 1, peers);
    for (const r of reconcile(peers, total + 1)) resyncs.push(r);

    return {
      cfg, peers, net, reference, resyncs, trace,
      rollbackLog: [p1.rollbackLog, p2.rollbackLog],
    };
  }

  function ledgersComplete(peer, frames) {
    for (let f = 1; f <= frames; f++) {
      if (peer.localInputs[f] === null || peer.localInputs[f] === undefined) return false;
      if (peer.remoteInputs[f] === null || peer.remoteInputs[f] === undefined) return false;
    }
    return true;
  }

  function hitsOf(state) {
    return state.events.map((e) => ({
      frame: e.frame, hitId: e.hitId, type: e.type,
      attacker: e.attacker, defender: e.defender,
      attack: e.attack, crit: e.crit, damage: e.damage,
      blocked: e.blocked, hpAfter: e.defenderHpAfter,
    }));
  }

  // ---------------- scripted scenarios ----------------

  // S1: close approach, a blocked light hit, then a clean heavy hit.
  function scenarioBaseline() {
    const frames = 90;
    const rows = [];
    for (let f = 1; f <= frames; f++) rows.push({ frame: f, p1: I.RIGHT, p2: I.BLOCK });
    rows.find((r) => r.frame === 1).p1 = I.RIGHT | I.LIGHT;
    rows.find((r) => r.frame === 20).p1 = I.RIGHT | I.HEAVY;
    return {
      name: 'baseline-approach-and-block',
      seed: 7, frames, windowFrames: 30,
      latency: 4, jitter: 0, lossPct: 0, networkSeed: 7,
      positions: { p1x: 205, p2x: 235 },
      inputs: buildInputs(frames, rows),
    };
  }

  // S2: interleaved attacks. P2's jump edge input arrives late at P1, whose
  // declared prediction (idle, edges are never invented) expected a clean hit.
  // Rollback removes the predicted hit; both peers still converge to truth.
  function scenarioRollbackFlip() {
    const frames = 90;
    const rows = [];
    for (let f = 1; f <= frames; f++) rows.push({ frame: f, p1: I.RIGHT, p2: 0 });
    rows.find((r) => r.frame === 1).p1 = I.RIGHT | I.LIGHT;
    rows.find((r) => r.frame === 2).p2 = I.JUMP;           // evades the frame-4 hitbox
    rows.find((r) => r.frame === 30).p1 = I.RIGHT | I.HEAVY;
    rows.find((r) => r.frame === 30).p2 = I.BLOCK;
    return {
      name: 'interleaved-late-inputs-flip-hits',
      seed: 202, frames, windowFrames: 30,
      latency: 9, jitter: 2, lossPct: 0, networkSeed: 11,
      positions: { p1x: 205, p2x: 235 },
      inputs: buildInputs(frames, rows),
    };
  }

  // S3: a one-way stall lasts longer than the snapshot window. The first
  // post-stall input lands outside recovery range -> explicit hard resync.
  function scenarioBeyondWindow() {
    const frames = 60;
    const rows = [];
    for (let f = 1; f <= frames; f++) rows.push({ frame: f, p1: I.RIGHT, p2: I.LEFT });
    rows.find((r) => r.frame === 25).p1 = I.RIGHT | I.HEAVY;
    return {
      name: 'late-input-beyond-window-resync',
      seed: 303, frames, windowFrames: 12, inputTimeout: 90,
      latency: 3, jitter: 0, lossPct: 0, networkSeed: 13,
      stalls: [{ receiver: 1, from: 5, to: 34 }],
      positions: { p1x: 150, p2x: 300 },
      inputs: buildInputs(frames, rows),
    };
  }

  // S4: lossy link; bundles guarantee every input is eventually delivered.
  function scenarioLossyLink() {
    const frames = 140;
    const rows = [];
    for (let f = 1; f <= frames; f++) rows.push({ frame: f, p1: I.RIGHT, p2: I.LEFT });
    rows.find((r) => r.frame === 2).p1 = I.RIGHT | I.LIGHT;
    rows.find((r) => r.frame === 2).p2 = I.LEFT | I.BLOCK;
    rows.find((r) => r.frame === 40).p1 = I.RIGHT | I.HEAVY;
    rows.find((r) => r.frame === 60).p2 = I.LEFT | I.LIGHT;
    rows.find((r) => r.frame === 90).p1 = I.RIGHT | I.BLOCK;
    rows.find((r) => r.frame === 90).p2 = I.LEFT | I.HEAVY;
    return {
      name: 'lossy-link-deterministic-convergence',
      seed: 404, frames, windowFrames: 30,
      latency: 5, jitter: 1, lossPct: 25, networkSeed: 17,
      positions: { p1x: 205, p2x: 235 },
      inputs: buildInputs(frames, rows),
    };
  }

  const api = {
    I, buildInputs, runReference, runScenario, reconcile, hitsOf,
    scenarioBaseline, scenarioRollbackFlip, scenarioBeyondWindow, scenarioLossyLink,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(global, { Scenarios: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
