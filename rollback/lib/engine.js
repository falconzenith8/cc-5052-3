/*
 * Deterministic close-combat simulation core.
 * Fixed-point integer math, fixed timestep, explicit hitbox rules,
 * seeded PRNG whose state is part of the simulation snapshot.
 * Shared verbatim by the headless checker (Node) and the browser demo.
 */
(function (global) {
  'use strict';

  // ---------- world / body constants (all integers) ----------
  const STAGE_W = 480;
  const STAGE_H = 200;
  const PLAYER_W = 20;
  const PLAYER_H = 44;
  const WALK_SPEED = 2;
  const GRAVITY = 1;
  const JUMP_VY = 13;
  const GROUND_FRICTION = 1;
  const MAX_HP = 100;
  const POST_HIT_INVULN = 10; // frames of full invulnerability after a clean hit
  // Cooldown gate for re-triggering an attack. A swing that runs to completion
  // grants the full cooldown; interrupting it early (cancel) refunds most of it,
  // so the next attack edge is eligible sooner. This counter is authoritative.
  const ATTACK_COOLDOWN_FULL = 6;
  const ATTACK_COOLDOWN_CANCEL_REFUND = 2;

  // ---------- input bitmask ----------
  const INPUT = {
    LEFT: 1 << 0,
    RIGHT: 1 << 1,
    JUMP: 1 << 2,
    LIGHT: 1 << 3,
    HEAVY: 1 << 4,
    BLOCK: 1 << 5,
  };
  // Held state may be predicted by repeating the last observed remote input.
  // Edge-triggered buttons are never predicted.
  const HELD_MASK = INPUT.LEFT | INPUT.RIGHT | INPUT.BLOCK;
  const EDGE_MASK = INPUT.JUMP | INPUT.LIGHT | INPUT.HEAVY;

  const ACTIONS = {
    LIGHT: {
      startup: 4, active: 3, recovery: 7,
      hx: 18, hy: 14, hyOff: -30,
      damage: 6, blockDamage: 1, hitstun: 12, blockstun: 8,
      knockback: 3, critChance: 10, // percent
    },
    HEAVY: {
      startup: 9, active: 4, recovery: 14,
      hx: 24, hy: 18, hyOff: -32,
      damage: 12, blockDamage: 3, hitstun: 20, blockstun: 16,
      knockback: 7, critChance: 15,
    },
  };

  // ---------- deterministic PRNG: mulberry32, state carried in snapshot ----------
  function rngNext(s) {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return { state: s >>> 0, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
  }

  function createInitialState(seed) {
    return {
      frame: 0,
      rngState: seed >>> 0,
      eventSeq: 0,
      players: [
        makePlayer(1, 120, 1),
        makePlayer(2, STAGE_W - 120, -1),
      ],
      events: [], // authoritative simulation events (clean hits and blocked hits)
    };
  }

  function makePlayer(id, x, facing) {
    return {
      id,
      x, y: 0,
      vx: 0, vy: 0,
      onGround: true,
      facing,
      hp: MAX_HP,
      blocking: false,
      action: 'IDLE',
      actionFrame: 0,
      stunTotal: 0,
      invuln: 0,
      swingId: 0,
      didHitThisSwing: false,
      inputPrev: 0,
      // Witness-layer fields. Registered in witness/field-registry.json; their
      // serialization class drives the rollback masking experiments.
      cooldown: 0,          // authoritative: frames before the next attack edge
      hitEligible: true,    // derived cache: cooldown === 0 (recomputed each step)
      particles: 0,         // render-only: cosmetic particle counter, never read by sim
      pendingCritRoll: null, // RNG effect deferred: {swingId} waits until active frames
    };
  }

  function actionTotal(p) {
    if (p.action === 'LIGHT') { const a = ACTIONS.LIGHT; return a.startup + a.active + a.recovery; }
    if (p.action === 'HEAVY') { const a = ACTIONS.HEAVY; return a.startup + a.active + a.recovery; }
    if (p.action === 'HITSTUN' || p.action === 'BLOCKSTUN') return p.stunTotal;
    return 0;
  }

  function actionPhase(p) {
    if (p.action === 'LIGHT' || p.action === 'HEAVY') {
      const a = ACTIONS[p.action];
      if (p.actionFrame < a.startup) return 'startup';
      if (p.actionFrame < a.startup + a.active) return 'active';
      return 'recovery';
    }
    if (p.action === 'HITSTUN' || p.action === 'BLOCKSTUN') return 'stun';
    if (!p.onGround) return 'airborne';
    return p.blocking ? 'blocking' : (p.vx !== 0 ? 'walk' : 'idle');
  }

  function hurtbox(p) {
    return { x: p.x - PLAYER_W / 2, y: p.y - PLAYER_H, w: PLAYER_W, h: PLAYER_H };
  }

  function hitbox(p) {
    if (p.action !== 'LIGHT' && p.action !== 'HEAVY') return null;
    if (actionPhase(p) !== 'active') return null;
    const a = ACTIONS[p.action];
    const x = p.facing === 1
      ? p.x + PLAYER_W / 2
      : p.x - PLAYER_W / 2 - a.hx;
    return { x, y: p.y + a.hyOff, w: a.hx, h: a.hy };
  }

  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function clampToStage(p) {
    const half = PLAYER_W / 2;
    if (p.x < half) { p.x = half; if (p.vx < 0) p.vx = 0; }
    if (p.x > STAGE_W - half) { p.x = STAGE_W - half; if (p.vx > 0) p.vx = 0; }
  }

  // ---------- one deterministic simulation step ----------
  // inputs: [inputP0, inputP1], integers from the input ledger (or declared prediction)
  function step(state, inputs) {
    state.frame += 1;

    for (const p of state.players) {
      if (p.cooldown > 0) p.cooldown -= 1;
      // Derived cache: deliberately recomputed from the authoritative cooldown.
      // Dropping it from snapshots is harmless; dropping cooldown is not.
      p.hitEligible = p.cooldown === 0;
    }

    for (let i = 0; i < 2; i++) {
      controlPlayer(state, state.players[i], state.players[1 - i], inputs[i]);
    }
    for (let i = 0; i < 2; i++) integrate(state.players[i]);
    for (let i = 0; i < 2; i++) advanceAction(state.players[i]);
    // The deciding RNG ticket is consumed on entering the active phase, whether
    // or not the swing later connects, so the cursor advances deterministically
    // per swing and never depends on hitbox overlap.
    for (const p of state.players) resolveSwingTicket(state, p);
    resolveHits(state);

    for (const p of state.players) {
      if (p.invuln > 0) p.invuln -= 1;
      p.inputPrev = inputs[p.id - 1];
    }
    return state;
  }

  function edge(pressed, prev, mask) {
    return (pressed & mask) !== 0 && (prev & mask) === 0;
  }

  function controlPlayer(state, p, other, input) {
    const prev = p.inputPrev;
    p.blocking = false;

    const stunned = p.action === 'HITSTUN' || p.action === 'BLOCKSTUN';
    const attacking = p.action === 'LIGHT' || p.action === 'HEAVY';
    const attackEdge = edge(input, prev, INPUT.LIGHT) || edge(input, prev, INPUT.HEAVY);

    if (!stunned && attacking && attackEdge) {
      // Interrupt-and-retrigger fiction: cancel the current swing early.
      // Both worlds render the same IDLE body on the cancel frame, but the
      // shortened cooldown changes next-beat hit eligibility (see witness).
      p.particles += 1; // cosmetic cancel puff only; never read by the sim
      // Second RNG ticket of this swing: a completed swing draws its deciding
      // ticket at the active frame; an interrupted swing draws it here instead.
      // Both paths consume exactly two tickets, so the cursor stays aligned.
      const cancelRoll = rngNext(state.rngState);
      state.rngState = cancelRoll.state;
      p.action = 'IDLE';
      p.actionFrame = 0;
      p.didHitThisSwing = false;
      p.pendingCritRoll = null;
      p.cooldown = ATTACK_COOLDOWN_FULL - ATTACK_COOLDOWN_CANCEL_REFUND;
      p.hitEligible = false;
      return;
    }

    if (!stunned && !attacking) {
      // Rule: always face the opponent while free to act; facing locks during attacks/stuns.
      p.facing = other.x >= p.x ? 1 : -1;

      if (p.onGround && (input & INPUT.BLOCK) && !(input & (INPUT.LIGHT | INPUT.HEAVY))) {
        p.blocking = true;
        p.vx = 0;
      } else {
        let dir = 0;
        if (input & INPUT.LEFT) dir -= 1;
        if (input & INPUT.RIGHT) dir += 1;
        p.vx = dir * WALK_SPEED;

        if (p.onGround && edge(input, prev, INPUT.JUMP)) {
          p.vy = -JUMP_VY;
          p.onGround = false;
        }
        // Authoritative cooldown gate: an edge while cooling down is consumed
        // without starting a swing, so the two worlds silently diverge on it.
        if (p.cooldown > 0) return;
        if (edge(input, prev, INPUT.HEAVY)) startAttack(state, p, 'HEAVY');
        else if (edge(input, prev, INPUT.LIGHT)) startAttack(state, p, 'LIGHT');
      }
    }
  }

  function startAttack(state, p, kind) {
    if (!p.onGround) return; // ground-only attacks in this ruleset
    p.action = kind;
    p.actionFrame = 0;
    p.stunTotal = 0;
    p.didHitThisSwing = false;
    state.eventSeq += 1;
    p.swingId = state.eventSeq;
    p.cooldown = ATTACK_COOLDOWN_FULL;
    p.hitEligible = false;
    p.particles += 1; // cosmetic swing spark only; never read by the sim
    // First RNG draw of the swing advances the cursor at start. The deciding
    // crit draw happens at the active frame (tail of the rollback window); a
    // cancel draws its second ticket at the interrupt event instead, so both
    // "completed" and "cancelled" histories advance the cursor by two.
    const startRoll = rngNext(state.rngState);
    state.rngState = startRoll.state;
    p.pendingCritRoll = { swingId: p.swingId, startTicket: startRoll.state };
  }

  function integrate(p) {
    if (p.onGround && !p.blocking && p.action !== 'HITSTUN' && p.action !== 'BLOCKSTUN') {
      // friction only matters for leftover knockback while no walk input drives vx
      if (p.vx !== 0 && !(p.action === 'LIGHT' || p.action === 'HEAVY')) {
        p.vx = p.vx > 0 ? Math.max(0, p.vx - GROUND_FRICTION) : Math.min(0, p.vx + GROUND_FRICTION);
      }
    }
    if (p.action === 'LIGHT' || p.action === 'HEAVY' || p.blocking) p.vx = 0;

    p.x += p.vx;
    if (!p.onGround) {
      p.vy += GRAVITY;
      p.y += p.vy;
      if (p.y >= 0) { p.y = 0; p.vy = 0; p.onGround = true; }
    }
    clampToStage(p);
  }

  function advanceAction(p) {
    if (p.action === 'IDLE') return;
    p.actionFrame += 1;
    const total = actionTotal(p);
    if (total > 0 && p.actionFrame >= total) {
      p.action = 'IDLE';
      p.actionFrame = 0;
      p.stunTotal = 0;
      p.didHitThisSwing = false;
      p.pendingCritRoll = null;
    }
  }

  // Consume the second (deciding) RNG ticket exactly once per swing, on its
  // first active frame — the tail of any rollback window containing the start.
  // A cancelled swing instead draws this ticket at the interrupt event, so both
  // histories advance the cursor by two tickets per swing.
  function resolveSwingTicket(state, p) {
    if (p.action !== 'LIGHT' && p.action !== 'HEAVY') return;
    if (actionPhase(p) !== 'active') return;
    if (!p.pendingCritRoll || p.pendingCritRoll.rolled) return;
    const roll = rngNext(state.rngState);
    state.rngState = roll.state;
    const crit = roll.value * 100 < ACTIONS[p.action].critChance;
    p.pendingCritRoll = {
      swingId: p.swingId,
      startTicket: p.pendingCritRoll.startTicket,
      rolled: true,
      crit,
    };
  }

  // Explicit, rule-driven hit resolution: AABB hitbox vs hurtbox overlap only.
  // Visual contact is never a hit; this function is the sole authority.
  function resolveHits(state) {
    for (let ai = 0; ai < 2; ai++) {
      const atk = state.players[ai];
      const def = state.players[1 - ai];
      if (atk.action !== 'LIGHT' && atk.action !== 'HEAVY') continue;
      if (actionPhase(atk) !== 'active' || atk.didHitThisSwing) continue;

      // The crit was decided by resolveSwingTicket at the active frame; here we
      // only read the carried result and apply its numeric effect.
      const data = ACTIONS[atk.action];
      let crit = false;
      if (atk.pendingCritRoll && atk.pendingCritRoll.swingId === atk.swingId) {
        crit = atk.pendingCritRoll.crit === true;
      }

      const hb = hitbox(atk);
      const hurt = hurtbox(def);
      if (!hb || !overlap(hb, hurt)) continue;

      const facingAttacker = Math.sign(atk.x - def.x) === def.facing;
      const blocked = def.blocking && facingAttacker && def.action === 'IDLE';

      let damage;
      if (!blocked) {
        damage = crit ? Math.round(data.damage * 1.5) : data.damage;
      } else {
        damage = data.blockDamage;
      }

      const ev = {
        type: blocked ? 'BLOCKED_HIT' : 'HIT',
        frame: state.frame,
        hitId: atk.swingId,
        attacker: atk.id,
        defender: def.id,
        attack: atk.action,
        crit,
        damage,
        blocked,
        attackerPos: { x: atk.x, y: atk.y },
        defenderPos: { x: def.x, y: def.y },
        hitbox: hb,
        hurtbox: hurt,
      };

      if (blocked) {
        def.action = 'BLOCKSTUN';
        def.stunTotal = data.blockstun;
        def.actionFrame = 0;
        def.hp = Math.max(0, def.hp - data.blockDamage);
        def.vx = atk.facing * 2;
      } else {
        def.action = 'HITSTUN';
        def.stunTotal = crit ? Math.round(data.hitstun * 1.5) : data.hitstun;
        def.actionFrame = 0;
        def.invuln = POST_HIT_INVULN;
        def.hp = Math.max(0, def.hp - damage);
        def.vx = atk.facing * (crit ? Math.round(data.knockback * 1.5) : data.knockback);
      }
      atk.didHitThisSwing = true;
      atk.particles += 1; // cosmetic impact sparks only; never read by the sim
      ev.defenderHpAfter = def.hp;
      state.eventSeq += 1;
      ev.eventId = state.eventSeq;
      state.events.push(ev);
    }
  }

  // ---------- snapshots, checksums, canonical serialization ----------
  function cloneState(s) {
    return JSON.parse(JSON.stringify(s));
  }

  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  // FNV-1a 32-bit over the canonical state encoding.
  function checksum(state) {
    const str = stableStringify({
      frame: state.frame,
      rngState: state.rngState,
      eventSeq: state.eventSeq,
      players: state.players,
      events: state.events,
    });
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function summarize(state) {
    return {
      frame: state.frame,
      rngState: state.rngState,
      eventSeq: state.eventSeq,
      players: state.players.map((p) => ({
        id: p.id,
        x: p.x, y: p.y, vx: p.vx, vy: p.vy,
        facing: p.facing,
        hp: p.hp,
        action: p.action,
        actionFrame: p.actionFrame,
        phase: actionPhase(p),
        blocking: p.blocking,
        invuln: p.invuln,
        swingId: p.swingId,
        didHitThisSwing: p.didHitThisSwing,
        cooldown: p.cooldown,
        hitEligible: p.hitEligible,
        particles: p.particles,
        pendingCritRoll: p.pendingCritRoll,
      })),
      events: state.events.map((e) => ({
        frame: e.frame, type: e.type, hitId: e.hitId,
        attacker: e.attacker, defender: e.defender,
        attack: e.attack, crit: e.crit, damage: e.damage, blocked: e.blocked,
        hpAfter: e.defenderHpAfter,
      })),
    };
  }

  const api = {
    STAGE_W, STAGE_H, PLAYER_W, PLAYER_H, MAX_HP,
    ATTACK_COOLDOWN_FULL, ATTACK_COOLDOWN_CANCEL_REFUND,
    INPUT, HELD_MASK, EDGE_MASK, ACTIONS,
    createInitialState, step, actionPhase, hitbox, hurtbox,
    cloneState, checksum, summarize, stableStringify, rngNext,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RollbackEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
