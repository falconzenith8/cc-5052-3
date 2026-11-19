/*
 * Rollback netcode layer on top of the deterministic engine.
 *
 * Two peers advance in lockstep driven by a scenario clock. Each peer keeps:
 *  - an input ledger per player (null = not yet received),
 *  - a bounded ring of full simulation snapshots (states, not display coords),
 *  - per-frame checksums and a bounded correction/resync log.
 *
 * Prediction rule (declared, never implicit):
 *  - held inputs (movement / block) repeat the last observed remote input,
 *  - edge inputs (jump / attacks) are never invented,
 *  - the locally owned input is always authoritative.
 *
 * A late remote input inside the snapshot window triggers rollback + replay.
 * Outside the window it triggers an explicit, explainable resync instead of
 * being silently ignored.
 */
(function (global) {
  'use strict';

  const E = (typeof module !== 'undefined' && module.exports)
    ? require('./engine.js')
    : global.RollbackEngine;

  const MAX_LOG = 200;

  function boundedPush(arr, item, cap) {
    arr.push(item);
    if (arr.length > cap) arr.shift();
  }

  class Peer {
    constructor(id, opts) {
      this.id = id;
      this.windowFrames = opts.windowFrames || 30;
      this.inputTimeout = opts.inputTimeout || 40;
      this.state = E.createInitialState(opts.seed >>> 0);
      this.localInputs = [null]; // index = simulation frame
      this.remoteInputs = [null];
      this.predictedRemote = [null];
      this.snapshots = new Map(); // frame -> full state clone at that frame
      this.snapshots.set(0, E.cloneState(this.state));
      this.frameHashes = [E.checksum(this.state)];
      this.rollbackLog = [];
      this.resyncLog = [];
      this.stats = {
        steps: 0, predictedFrames: 0, rollbacks: 0, resyncs: 0,
        corrections: 0, receivedInputs: 0, lateInputs: 0,
        duplicateInputs: 0, conflicts: 0,
      };
      this.consecutivePredicted = 0;
      this.needsResync = null; // {reason, detail}
    }

    oldestSnapshotFrame() {
      let min = Infinity;
      for (const f of this.snapshots.keys()) min = Math.min(min, f);
      return min;
    }

    lastRealRemoteBefore(frame) {
      for (let g = frame - 1; g >= 1; g--) {
        if (this.remoteInputs[g] !== null && this.remoteInputs[g] !== undefined) return this.remoteInputs[g];
      }
      return 0;
    }

    predictRemoteInput(frame) {
      // Declared rule: carry held state only; strip every edge-triggered button.
      return this.lastRealRemoteBefore(frame) & E.HELD_MASK;
    }

    // Called by the link layer with one reliable-delivered input entry.
    receiveInput(frame, value, clock) {
      if (frame <= 0) return;
      while (this.remoteInputs.length <= frame) this.remoteInputs.push(null);
      while (this.predictedRemote.length <= frame) this.predictedRemote.push(null);
      const known = this.remoteInputs[frame];
      if (known !== null && known !== undefined) {
        if (known !== value) {
          // Two different real claims for the same frame: protocol violation.
          this.stats.conflicts++;
          this.needsResync = {
            reason: 'PROTOCOL_CONFLICT',
            detail: { frame, first: known, conflicting: value, clock },
          };
        }
        // Equal re-deliveries are normal bundle retransmissions, not events.
        return;
      }

      this.remoteInputs[frame] = value;
      this.predictedRemote[frame] = null;
      this.stats.receivedInputs++;
      // Real remote input breaks the prediction watchdog chain, including late arrivals.
      this.consecutivePredicted = 0;
      if (frame <= this.state.frame) {
        this.stats.lateInputs++;
        this.handleLateInput(frame, value, clock);
      }
    }

    handleLateInput(frame, actual, clock) {
      const predicted = this.lastRealRemoteBefore(frame) & E.HELD_MASK;
      if (frame - 1 >= this.oldestSnapshotFrame()) {
        if (actual === predicted) {
          // Prediction matched the real input: nothing to correct, no rollback.
          return;
        }
        this.rollback(frame, actual, predicted, clock);
      } else {
        // Explicit resync path; the input is never discarded.
        this.needsResync = {
          reason: 'LATE_BEYOND_WINDOW',
          detail: {
            frame, actual, predicted, clock,
            oldestSnapshot: this.oldestSnapshotFrame(),
            currentFrame: this.state.frame,
            windowFrames: this.windowFrames,
          },
        };
      }
    }

    rollback(frame, actual, predicted, clock) {
      this.stats.rollbacks++;
      const checksumBefore = E.checksum(this.state);
      const hitsBefore = this.state.events.map((ev) => ev.hitId);

      let work = E.cloneState(this.snapshots.get(frame - 1));
      const reSimFrames = [];
      for (let k = frame; k <= this.state.frame; k++) {
        const local = this.localInputs[k];
        if (local === null || local === undefined) {
          throw new Error(`peer ${this.id}: cannot re-simulate frame ${k}, local input missing`);
        }
        let remote = this.remoteInputs[k];
        if (remote === null || remote === undefined) {
          remote = this.lastRealRemoteBefore(k) & E.HELD_MASK;
        }
        const inputs = this.id === 1 ? [local, remote] : [remote, local];
        E.step(work, inputs);
        this.snapshots.set(k, E.cloneState(work));
        this.frameHashes[k] = E.checksum(work);
        reSimFrames.push(k);
      }

      const checksumAfter = E.checksum(work);
      const corrected = checksumBefore !== checksumAfter;
      if (corrected) this.stats.corrections++;

      const hitsAfter = work.events.map((ev) => ev.hitId);
      const beforeSet = new Set(hitsBefore);
      const afterSet = new Set(hitsAfter);
      const entry = {
        type: 'ROLLBACK',
        clock,
        inputFrame: frame,
        detectedAtFrame: this.state.frame,
        reason: actual !== predicted ? 'REMOTE_INPUT_MISMATCH' : 'PREDICTION_CONFIRMED',
        predictedInput: predicted,
        actualInput: actual,
        baseFrame: frame - 1,
        reSimFrames,
        checksumBefore,
        checksumAfter,
        corrected,
        removedHitIds: hitsBefore.filter((id) => !afterSet.has(id)),
        addedHitIds: hitsAfter.filter((id) => !beforeSet.has(id)),
      };
      boundedPush(this.rollbackLog, entry, MAX_LOG);
      this.state = work;
      this.evictSnapshots();
    }

    evictSnapshots() {
      const floor = this.state.frame - this.windowFrames;
      for (const f of Array.from(this.snapshots.keys())) {
        if (f < floor) this.snapshots.delete(f);
      }
    }

    // Advance exactly one simulation frame.
    advance(localInput, clock) {
      if (this.needsResync) {
        throw new Error(`peer ${this.id}: advance blocked while resync pending (${this.needsResync.reason})`);
      }
      const f = this.state.frame + 1;
      while (this.localInputs.length < f) this.localInputs.push(null);
      while (this.remoteInputs.length < f) this.remoteInputs.push(null);
      while (this.predictedRemote.length < f) this.predictedRemote.push(null);
      this.localInputs[f] = localInput;

      let remote = this.remoteInputs[f];
      const wasPredicted = remote === null || remote === undefined;
      if (wasPredicted) {
        remote = this.predictRemoteInput(f);
        this.predictedRemote[f] = remote;
        this.stats.predictedFrames++;
        this.consecutivePredicted++;
        if (this.consecutivePredicted > this.inputTimeout) {
          this.needsResync = {
            reason: 'WATCHDOG_STALL',
            detail: {
              frame: f, clock,
              consecutivePredicted: this.consecutivePredicted,
              inputTimeout: this.inputTimeout,
            },
          };
          return false; // frame not consumed; driver must reconcile first
        }
      } else {
        this.predictedRemote[f] = null;
        this.consecutivePredicted = 0;
      }

      const inputs = this.id === 1 ? [localInput, remote] : [remote, localInput];
      E.step(this.state, inputs);
      this.stats.steps++;
      this.snapshots.set(this.state.frame, E.cloneState(this.state));
      while (this.frameHashes.length <= this.state.frame) this.frameHashes.push(null);
      this.frameHashes[this.state.frame] = E.checksum(this.state);
      this.evictSnapshots();
      return true;
    }

    predictedCountInWindow() {
      const lo = Math.max(1, this.state.frame - this.windowFrames + 1);
      let n = 0;
      for (let f = lo; f <= this.state.frame; f++) {
        if (this.predictedRemote[f] !== null && this.predictedRemote[f] !== undefined) n++;
      }
      return n;
    }

    // Hard resync: adopt the authoritative peer's full state at the current
    // frame and merge its known inputs. The reason and adopted frame are logged.
    resyncFrom(other, reason, detail) {
      const before = E.checksum(this.state);
      const otherScore = other.predictedCountInWindow();
      // A peer that needs resync must never adopt itself: its own prediction is
      // what failed. Only the other peer can carry unknown remote inputs.
      const source = other;

      const adoptedFrame = source.state.frame;
      this.state = E.cloneState(source.state);

      // Merge the source's real inputs. Adopted frames are authoritative, so
      // overwrite predicted values; a conflicting real value is a protocol fault.
      for (let f = 1; f <= adoptedFrame; f++) {
        while (this.localInputs.length <= f) this.localInputs.push(null);
        while (this.remoteInputs.length <= f) this.remoteInputs.push(null);
        while (this.predictedRemote.length <= f) this.predictedRemote.push(null);
        if (this.id === source.id) continue;
        // Source's "remote" is our local input; source's "local" is our remote.
        const srcRemoteToUs = source.localInputs[f];
        const srcLocalToUs = source.remoteInputs[f];
        if (srcRemoteToUs !== null && srcRemoteToUs !== undefined) {
          if (this.remoteInputs[f] !== null && this.remoteInputs[f] !== undefined &&
              this.remoteInputs[f] !== srcRemoteToUs) {
            this.stats.conflicts++;
          }
          this.remoteInputs[f] = srcRemoteToUs;
          this.predictedRemote[f] = null;
        }
        if (srcLocalToUs !== null && srcLocalToUs !== undefined) {
          if (this.localInputs[f] !== null && this.localInputs[f] !== undefined &&
              this.localInputs[f] !== srcLocalToUs) {
            this.stats.conflicts++;
          }
          this.localInputs[f] = srcLocalToUs;
        }
      }

      this.snapshots = new Map();
      this.snapshots.set(adoptedFrame, E.cloneState(this.state));
      while (this.frameHashes.length <= adoptedFrame) this.frameHashes.push(null);
      const after = E.checksum(this.state);
      this.frameHashes[adoptedFrame] = after;
      this.evictSnapshots();
      this.consecutivePredicted = 0;
      this.stats.resyncs++;
      this.needsResync = null;

      const entry = {
        type: 'RESYNC',
        reason,
        detail,
        sourcePeer: source.id,
        sourcePredictedInWindow: otherScore,
        adoptedFrame,
        checksumBefore: before,
        checksumAfter: after,
      };
      boundedPush(this.resyncLog, entry, MAX_LOG);
      return entry;
    }
  }

  // Deterministic link simulator. Packets re-bundle recent inputs, so packet
  // loss only adds delay: a later retransmission carries the same entries and
  // no remote input can be silently dropped.
  class Network {
    constructor(opts) {
      this.latency = opts.latency ?? 4;
      this.jitter = opts.jitter ?? 1;
      this.lossPct = opts.lossPct ?? 0;
      this.bundleFrames = opts.bundleFrames ?? 20;
      let r = (opts.networkSeed ?? 1) >>> 0;
      this._nextRng = () => {
        const out = E.rngNext(r);
        r = out.state;
        return out.value;
      };
      this.queues = { 1: [], 2: [] }; // receiver id -> packets
      this.stalls = { 1: { from: null, to: null }, 2: { from: null, to: null } };
      this.stats = { sent: 0, lost: 0, delivered: 0 };
    }

    setStall(receiverId, fromClock, toClock) {
      this.stalls[receiverId] = { from: fromClock, to: toClock };
    }

    stalled(receiverId, clock) {
      const s = this.stalls[receiverId];
      return s.from !== null && clock >= s.from && clock <= s.to;
    }

    send(sender, clock) {
      const receiverId = sender.id === 1 ? 2 : 1;
      // Stalls are modeled on the receiving side in deliver(): queued packets
      // are held until reconnection rather than dropped or never transmitted.
      const f = sender.state.frame;
      const lo = Math.max(1, f - this.bundleFrames + 1);
      const entries = [];
      for (let k = lo; k <= f; k++) {
        const v = sender.localInputs[k];
        if (v !== null && v !== undefined) entries.push({ frame: k, value: v });
      }
      this.stats.sent++;
      if (this._nextRng() * 100 < this.lossPct) {
        this.stats.lost++;
        return; // entries re-appear in the next bundle
      }
      const jitter = this.jitter > 0 ? Math.floor(this._nextRng() * (this.jitter + 1)) : 0;
      this.queues[receiverId].push({
        arriveFrame: clock + this.latency + jitter,
        sentClock: clock,
        entries,
      });
    }

    deliver(clock, peers) {
      for (const receiverId of [1, 2]) {
        // A disconnected receiver's in-flight packets are held, not lost: their
        // effective arrival is the moment the stall ends, never a stale clock.
        if (this.stalled(receiverId, clock)) continue;
        const q = this.queues[receiverId];
        const ready = q.filter((p) => p.arriveFrame <= clock)
          .sort((a, b) => (a.arriveFrame - b.arriveFrame) || (a.sentClock - b.sentClock));
        this.queues[receiverId] = q.filter((p) => p.arriveFrame > clock);
        for (const pkt of ready) {
          this.stats.delivered++;
          const peer = peers[receiverId - 1];
          for (const e of pkt.entries.slice().sort((a, b) => a.frame - b.frame)) {
            peer.receiveInput(e.frame, e.value, clock);
          }
        }
      }
    }

    inFlight() {
      return this.queues[1].length + this.queues[2].length;
    }
  }

  const api = { Peer, Network };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.RollbackNetcode = api;
    global.Peer = Peer;
    global.Network = Network;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
