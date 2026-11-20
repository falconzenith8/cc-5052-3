/*
 * Witness scenario: interrupt-and-retrigger fiction.
 *
 * ONE dense input log drives the headline pair:
 *
 *  no-rollback world: a peer that never receives the late cancel edge, so its
 *    prediction (no edge is ever invented) stands and the first swing runs on.
 *
 *  rollback world: the same peer, but the cancel edge for `cancelFrame` is
 *    injected late. It restores the snapshot at cancelFrame-1 and replays with
 *    the truth inputs; the deferred RNG effect is consumed at the active frame
 *    at the tail of the rollback interval.
 *
 * A second, narrower runner powers the serializer masking experiments. It
 * restores a snapshot taken AFTER the attack and steps the next-beat gate edge,
 * so a field dropped at restore is not rewritten by replaying startAttack:
 *
 *  - dropping the authoritative cooldown makes the gate edge fire a swing that
 *    the control world correctly refuses (deterministic gameplay break);
 *  - dropping the derived hitEligible cache differs for one frame then self-heals;
 *  - dropping render-only particles never reaches any gameplay field;
 *  - dropping the RNG cursor re-rolls the deferred crit at the interval tail.
 */
(function (global) {
  'use strict';

  const E = (typeof module !== 'undefined' && module.exports)
    ? require('../lib/engine.js')
    : global.RollbackEngine;
  const Ev = (typeof module !== 'undefined' && module.exports)
    ? require('./evidence.js')
    : global.WitnessEvidence;

  const I = E.INPUT;

  // P2 is parked well outside LIGHT reach so neither world ever lands a hit:
  // the worlds then differ ONLY in P1's internal cooldown/eligibility, while
  // rendering strictly identical frames.
  const POSITIONS = { p1x: 120, p2x: 400 };
  const SEED = 777;
  const WINDOW_FRAMES = 30;

  // Headline timeline (P1 only; P2 holds no inputs).
  const ATTACK_FRAME = 2;       // LIGHT edge -> first swing starts (RNG ticket #1)
  const CANCEL_FRAME = 5;       // late edge: NR active (ticket #2), RB cancels (ticket #2)
  const SAME_PICTURE_FRAME = 15; // both worlds render IDLE; cooldown/eligibility differ
  const RETRIGGER_FRAME = 18;
  const LAST_FRAME = 30;
  const DELIVER_CLOCK = CANCEL_FRAME + 3; // late, inside the snapshot window

  // Mask-experiment timeline: a gate edge lands while cooldown is still live.
  const MASK_ATTACK_FRAME = 2;
  const MASK_CANCEL_FRAME = 5;
  const MASK_SNAPSHOT_FRAME = 6; // restore point: post-attack, cooldown still > 0
  const MASK_GATE_FRAME = 7;     // control refuses (cd>0); masked cooldown=0 starts a swing
  const MASK_LAST_FRAME = 12;

  function denseLog(rows, lastFrame) {
    const p1 = new Array(lastFrame + 1).fill(0);
    const p2 = new Array(lastFrame + 1).fill(0);
    for (const [f, v] of rows) p1[f] = v;
    return [p1, p2];
  }

  function buildInputLog() {
    return denseLog([
      [ATTACK_FRAME, I.LIGHT],
      [CANCEL_FRAME, I.LIGHT],
      [RETRIGGER_FRAME, I.LIGHT],
    ], LAST_FRAME);
  }

  function buildMaskLog() {
    return denseLog([
      [MASK_ATTACK_FRAME, I.LIGHT],
      [MASK_CANCEL_FRAME, I.LIGHT],
      [MASK_GATE_FRAME, I.LIGHT],
    ], MASK_LAST_FRAME);
  }

  // The cancel entry is withheld from this world's ledger; prediction never
  // invents edge buttons.
  function withoutCancelAt(inputs, cancelFrame) {
    const p1 = inputs[0].slice();
    const p2 = inputs[1].slice();
    p1[cancelFrame] = 0;
    return [p1, p2];
  }

  function freshState() {
    const s = E.createInitialState(SEED);
    s.players[0].x = POSITIONS.p1x;
    s.players[1].x = POSITIONS.p2x;
    s.players[0].facing = 1;
    s.players[1].facing = -1;
    return s;
  }

  function runStraight(inputs, lastFrame) {
    const state = freshState();
    const trace = [E.cloneState(state)];
    for (let f = 1; f <= lastFrame; f++) {
      E.step(state, [inputs[0][f], inputs[1][f]]);
      trace.push(E.cloneState(state));
    }
    return { state, trace };
  }

  // Headline rollback world: late cancel edge + snapshot/replay, corrected trace.
  function runHeadlineRollback(maskField) {
    const truth = buildInputLog();
    const predicted = withoutCancelAt(truth, CANCEL_FRAME);
    const state = freshState();
    const snapshots = new Map();
    snapshots.set(0, E.cloneState(state));
    const trace = [E.cloneState(state)];
    const rollbackEvents = [];

    const restore = (f) => {
      const snap = snapshots.get(f);
      return maskField ? Ev.maskedSnapshot(snap, maskField) : E.cloneState(snap);
    };

    for (let f = 1; f <= LAST_FRAME; f++) {
      E.step(state, [predicted[0][f], predicted[1][f]]);

      if (f === DELIVER_CLOCK) {
        const base = CANCEL_FRAME - 1;
        const work = restore(base);
        const reSimFrames = [];
        for (let k = base + 1; k <= f; k++) {
          E.step(work, [truth[0][k], truth[1][k]]);
          snapshots.set(k, E.cloneState(work));
          reSimFrames.push(k);
          trace[k] = E.cloneState(work);
        }
        rollbackEvents.push({
          type: 'ROLLBACK', inputFrame: CANCEL_FRAME, detectedAtFrame: f,
          baseFrame: base, reSimFrames, maskedField: maskField || null,
          checksumBefore: E.checksum(state), checksumAfter: E.checksum(work),
        });
        Object.assign(state, work);
      }

      snapshots.set(f, E.cloneState(state));
      if (!trace[f]) trace[f] = E.cloneState(state);
    }
    return { state, trace, rollbackEvents };
  }

  // Mask-experiment world: run the truth history to the post-attack snapshot,
  // restore it (optionally dropping one field), then continue with the gate edge.
  // Because the restore point is AFTER startAttack/cancel, a dropped cooldown is
  // not rewritten and survives to the gate edge where it changes eligibility.
  function runMaskExperiment(maskField) {
    const truth = buildMaskLog();
    const state = freshState();
    const snapshots = new Map();
    snapshots.set(0, E.cloneState(state));
    for (let f = 1; f <= MASK_SNAPSHOT_FRAME; f++) {
      E.step(state, [truth[0][f], truth[1][f]]);
      snapshots.set(f, E.cloneState(state));
    }

    const restore = (f) => {
      const snap = snapshots.get(f);
      return maskField ? Ev.maskedSnapshot(snap, maskField) : E.cloneState(snap);
    };

    // Both arms restore the SAME snapshot frame; only the serializer differs.
    const control = E.cloneState(snapshots.get(MASK_SNAPSHOT_FRAME));
    const masked = restore(MASK_SNAPSHOT_FRAME);
    // Absolute-frame-indexed traces; frames before the restore share the truth
    // history and are intentionally identical, so comparison starts at restore.
    const ctlTrace = new Array(MASK_LAST_FRAME + 1).fill(null);
    const mskTrace = new Array(MASK_LAST_FRAME + 1).fill(null);
    ctlTrace[MASK_SNAPSHOT_FRAME] = E.cloneState(control);
    mskTrace[MASK_SNAPSHOT_FRAME] = E.cloneState(masked);
    for (let f = MASK_SNAPSHOT_FRAME + 1; f <= MASK_LAST_FRAME; f++) {
      E.step(control, [truth[0][f], truth[1][f]]);
      E.step(masked, [truth[0][f], truth[1][f]]);
      ctlTrace[f] = E.cloneState(control);
      mskTrace[f] = E.cloneState(masked);
    }
    return {
      controlTrace: ctlTrace,
      maskedTrace: mskTrace,
      comparison: Ev.compareFrames(ctlTrace, mskTrace),
    };
  }

  function pick(trace, f) {
    const p = trace[f].players[0];
    return {
      frame: f, action: p.action, cooldown: p.cooldown,
      hitEligible: p.hitEligible, particles: p.particles,
    };
  }

  function runWitness() {
    const log = buildInputLog();
    const noRollback = runStraight(withoutCancelAt(log, CANCEL_FRAME), LAST_FRAME);
    const rollback = runHeadlineRollback(null);

    const experiments = {};
    for (const field of ['particles', 'hitEligible', 'cooldown', 'rngState']) {
      const scope = Ev.WORLD_FIELDS.includes(field) ? 'world' : 'player';
      let comparison;
      if (field === 'rngState') {
        // The cursor omission is exercised by the headline rollback interval,
        // whose tail active frame consumes the deferred crit ticket.
        const control = runHeadlineRollback(null);
        const masked = runHeadlineRollback('rngState');
        comparison = Ev.compareFrames(control.trace, masked.trace);
      } else {
        comparison = runMaskExperiment(field).comparison;
      }
      experiments[field] = {
        field,
        registryClass: Ev.registryClass(scope, field),
        comparison,
      };
    }

    return {
      config: {
        seed: SEED, windowFrames: WINDOW_FRAMES, positions: POSITIONS,
        attackFrame: ATTACK_FRAME, cancelFrame: CANCEL_FRAME,
        samePictureFrame: SAME_PICTURE_FRAME, retriggerFrame: RETRIGGER_FRAME,
        lastFrame: LAST_FRAME, deliverClock: DELIVER_CLOCK,
        maskSnapshotFrame: MASK_SNAPSHOT_FRAME, maskGateFrame: MASK_GATE_FRAME,
      },
      inputLog: log,
      maskLog: buildMaskLog(),
      noRollback,
      rollback,
      headToHead: Ev.compareFrames(noRollback.trace, rollback.trace),
      eligibility: {
        noRollback: {
          cancelFrame: pick(noRollback.trace, CANCEL_FRAME),
          samePictureFrame: pick(noRollback.trace, SAME_PICTURE_FRAME),
        },
        rollback: {
          cancelFrame: pick(rollback.trace, CANCEL_FRAME),
          samePictureFrame: pick(rollback.trace, SAME_PICTURE_FRAME),
        },
      },
      visualsEqualAtSamePictureFrame:
        Ev.visualSignature(noRollback.trace[SAME_PICTURE_FRAME]) ===
        Ev.visualSignature(rollback.trace[SAME_PICTURE_FRAME]),
      experiments,
    };
  }

  const api = {
    SEED, WINDOW_FRAMES, POSITIONS,
    ATTACK_FRAME, CANCEL_FRAME, SAME_PICTURE_FRAME, RETRIGGER_FRAME, LAST_FRAME,
    MASK_SNAPSHOT_FRAME, MASK_GATE_FRAME, MASK_LAST_FRAME, DELIVER_CLOCK,
    buildInputLog, buildMaskLog, withoutCancelAt, freshState,
    runStraight, runHeadlineRollback, runMaskExperiment, runWitness,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WitnessScenario = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
