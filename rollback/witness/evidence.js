/*
 * Witness evidence engine.
 *
 * Two roles:
 *  - maskedSnapshot: strip a registered field from a serialized snapshot,
 *    rehydrating it with its declared default, to simulate a serializer that
 *    forgot the field.
 *  - compareFrames: field-level diff of two frame traces that locates the FIRST
 *    mismatch down to entity + frame + field and classifies it through the field
 *    registry so render-only/cosmetic differences are never reported as
 *    deterministic breaks.
 */
(function (global) {
  'use strict';

  const E = (typeof module !== 'undefined' && module.exports)
    ? require('../lib/engine.js')
    : global.RollbackEngine;
  const REGISTRY = (typeof module !== 'undefined' && module.exports)
    ? require('./field-registry.json')
    : global.FIELD_REGISTRY;

  const PLAYER_FIELDS = ['cooldown', 'hitEligible', 'particles', 'pendingCritRoll'];
  const WORLD_FIELDS = ['rngState'];

  function registryClass(scope, field) {
    const node = REGISTRY.entities[scope] && REGISTRY.entities[scope][field];
    return node ? node.class : 'unknown';
  }

  function defaultValue(scope, field) {
    const node = REGISTRY.entities[scope] && REGISTRY.entities[scope][field];
    if (!node) return undefined;
    if (Object.prototype.hasOwnProperty.call(node, 'default')) {
      return node.default === 'seed' ? 0 : node.default;
    }
    return null;
  }

  // Deep-clone via JSON and delete the masked field everywhere it can occur.
  // `field` is one of the registered names; world-level vs player-level is
  // resolved from the registry, so a name cannot accidentally hit the wrong scope.
  function maskedSnapshot(state, field) {
    const clone = E.cloneState(state);
    if (WORLD_FIELDS.includes(field) && REGISTRY.entities.world[field]) {
      clone[field] = defaultValue('world', field);
      return clone;
    }
    if (PLAYER_FIELDS.includes(field) && REGISTRY.entities.player[field]) {
      for (const p of clone.players) {
        p[field] = defaultValue('player', field);
      }
      return clone;
    }
    throw new Error(`witness: cannot mask unregistered field '${field}'`);
  }

  function valueEqual(a, b) {
    return E.stableStringify(a) === E.stableStringify(b);
  }

  // Flat list of every comparable leaf as {scope, entity, field, value}.
  function leaves(state) {
    const out = [];
    for (const f of WORLD_FIELDS) {
      out.push({ scope: 'world', entity: 'world', field: f, value: state[f] });
    }
    for (const p of state.players) {
      for (const f of PLAYER_FIELDS) {
        out.push({ scope: 'player', entity: `player:${p.id}`, field: f, value: p[f] });
      }
    }
    return out;
  }

  // Compare two equally-long frame traces (arrays of state clones) frame by
  // frame. Returns the first mismatch per frame with registry classification,
  // and the earliest frame that carries a gameplay-consequential difference.
  function compareFrames(traceA, traceB) {
    const frames = [];
    let firstConsequential = null;
    let firstAny = null;

    const maxF = Math.min(traceA.length, traceB.length) - 1;
    for (let f = 0; f <= maxF; f++) {
      const a = traceA[f];
      const b = traceB[f];
      if (!a || !b) continue; // frames before a runner's restore point
      const la = leaves(a);
      const lb = leaves(b);
      const mismatches = [];
      for (let i = 0; i < la.length; i++) {
        if (!valueEqual(la[i].value, lb[i].value)) {
          const cls = registryClass(la[i].scope, la[i].field);
          const entry = {
            frame: f,
            entity: la[i].entity,
            field: la[i].field,
            registryClass: cls,
            affectsGameplay: cls === 'authoritative' || cls === 'rng-cursor',
            valueNoRollback: la[i].value,
            valueRollback: lb[i].value,
          };
          mismatches.push(entry);
          if (!firstAny) firstAny = entry;
          if (entry.affectsGameplay && !firstConsequential) firstConsequential = entry;
        }
      }
      if (mismatches.length) frames.push({ frame: f, mismatches });
    }

    return {
      firstMismatch: firstAny,
      firstConsequentialMismatch: firstConsequential,
      framesWithMismatch: frames.map((x) => x.frame),
      frames,
      deterministicBreak: firstConsequential !== null,
    };
  }

  // A compact, stable signature of all authoritative gameplay leaves at a frame,
  // used to prove that two worlds are "the same picture, different next beat".
  function gameplaySignature(state) {
    const players = state.players.map((p) => ({
      id: p.id,
      hp: p.hp,
      action: p.action,
      actionFrame: p.actionFrame,
      cooldown: p.cooldown,
      hitEligible: p.hitEligible,
      x: p.x,
      y: p.y,
      pendingCritRoll: p.pendingCritRoll,
    }));
    return E.stableStringify({ frame: state.frame, rngState: state.rngState, players });
  }

  // Render-facing leaves only: pose/position visuals. The particle counter is
  // deliberately excluded: it is registered render-only and must never decide
  // whether two worlds show "the same picture".
  function visualSignature(state) {
    const players = state.players.map((p) => ({
      id: p.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      facing: p.facing, action: p.action, actionFrame: p.actionFrame,
      blocking: p.blocking,
    }));
    return E.stableStringify({ frame: state.frame, players });
  }

  const api = {
    PLAYER_FIELDS, WORLD_FIELDS,
    registryClass, defaultValue,
    maskedSnapshot, compareFrames,
    gameplaySignature, visualSignature,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WitnessEvidence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
