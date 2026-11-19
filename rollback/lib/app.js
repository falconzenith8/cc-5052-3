/* Browser demo driver: two rollback peers on one deterministic engine. */
(function () {
  'use strict';
  const E = window.RollbackEngine;
  const I = E.INPUT;

  const $ = (id) => document.getElementById(id);
  const SCALE = 1.25;
  const W = Math.round(E.STAGE_W * SCALE);
  const H = Math.round(E.STAGE_H * SCALE);

  const KEYMAP_P1 = {
    KeyA: I.LEFT, KeyD: I.RIGHT, KeyW: I.JUMP,
    KeyF: I.LIGHT, KeyG: I.HEAVY, KeyS: I.BLOCK,
  };
  const KEYMAP_P2 = {
    ArrowLeft: I.LEFT, ArrowRight: I.RIGHT, ArrowUp: I.JUMP,
    Comma: I.LIGHT, Period: I.HEAVY, ArrowDown: I.BLOCK,
  };

  const SCENARIO_DEFS = {
    baseline: window.Scenarios.scenarioBaseline,
    flip: window.Scenarios.scenarioRollbackFlip,
    resync: window.Scenarios.scenarioBeyondWindow,
    lossy: window.Scenarios.scenarioLossyLink,
  };

  const REASON_TEXT = {
    REMOTE_INPUT_MISMATCH: '迟到的真实输入与预测不符，回滚到快照并重演',
    PREDICTION_CONFIRMED: '迟到输入与预测一致，无需修正',
    LATE_BEYOND_WINDOW: '迟到输入早于最老快照，超出可恢复窗口，执行硬重同步',
    WATCHDOG_STALL: '远端输入连续超时未到达，看门狗触发重同步',
    PROTOCOL_CONFLICT: '同一帧收到冲突的真实输入，协议级重同步',
  };

  const app = {
    mode: 'script',
    scenarioName: 'flip',
    peers: null,
    net: null,
    clock: 0,
    maxClock: 0,
    scriptInputs: null,
    scriptFrames: 0,
    seed: 202,
    running: false,
    speed: 1,
    showHitboxes: true,
    heldP1: 0,
    heldP2: 0,
    announcedHitIds: new Set(),
    flashUntil: {}, // peer id -> clock until which correction flash shows
    refState: null,
  };

  function makePeers(cfg) {
    const p1 = new RollbackNetcode.Peer(1, { seed: cfg.seed, windowFrames: cfg.windowFrames, inputTimeout: cfg.inputTimeout || 40 });
    const p2 = new RollbackNetcode.Peer(2, { seed: cfg.seed, windowFrames: cfg.windowFrames, inputTimeout: cfg.inputTimeout || 40 });
    const pos = cfg.positions;
    if (pos) {
      for (const peer of [p1, p2]) {
        peer.state.players[0].x = pos.p1x;
        peer.state.players[1].x = pos.p2x;
        peer.state.players[0].facing = 1;
        peer.state.players[1].facing = -1;
        peer.snapshots.set(0, E.cloneState(peer.state));
        peer.frameHashes[0] = E.checksum(peer.state);
      }
    }
    const net = new RollbackNetcode.Network({
      latency: cfg.latency ?? 5,
      jitter: cfg.jitter ?? 1,
      lossPct: cfg.lossPct ?? 0,
      networkSeed: cfg.networkSeed ?? 1,
    });
    for (const s of cfg.stalls || []) net.setStall(s.receiver, s.from, s.to);
    return { peers: [p1, p2], net };
  }

  function loadScenario(name) {
    const cfg = SCENARIO_DEFS[name]();
    const built = makePeers(cfg);
    app.mode = 'script';
    app.scenarioName = name;
    app.peers = built.peers;
    app.net = built.net;
    app.clock = 0;
    app.maxClock = cfg.frames + (cfg.flush ?? 120) * 2;
    app.scriptInputs = cfg.inputs;
    app.scriptFrames = cfg.frames;
    app.seed = cfg.seed;
    app.announcedHitIds = new Set();
    app.flashUntil = {};
    app._finalized = false;
    app.refState = window.Scenarios.runReference(cfg.seed, cfg.inputs, cfg.positions).state;
    app.running = false;
    $('eventLog').innerHTML = '';
    $('modeLabel').textContent = '脚本回放';
    logLine(`载入场景 ${cfg.name}（seed=${cfg.seed}，窗口=${cfg.windowFrames}帧，延迟=${cfg.latency}±${cfg.jitter}，丢包=${cfg.lossPct ?? 0}%）`);
    render();
  }

  function startInteractive() {
    const cfg = {
      seed: 909, windowFrames: Number($('windowSize').value),
      inputTimeout: 40,
      latency: Number($('latency').value),
      jitter: Number($('jitter').value),
      lossPct: Number($('loss').value),
      networkSeed: 31,
      positions: { p1x: 170, p2x: 310 },
      stalls: [],
    };
    const built = makePeers(cfg);
    app.mode = 'interactive';
    app.peers = built.peers;
    app.net = built.net;
    app.clock = 0;
    app.maxClock = Infinity;
    app.scriptInputs = null;
    app.announcedHitIds = new Set();
    app.flashUntil = {};
    app._finalized = false;
    app.refState = null;
    app.heldP1 = 0;
    app.heldP2 = 0;
    app.running = true;
    $('modeLabel').textContent = '实时交互（模拟链路）';
    logLine(`进入实时交互：窗口=${cfg.windowFrames} 延迟=${cfg.latency}±${cfg.jitter} 丢包=${cfg.lossPct}%。P1: WASD+F/G，P2: 方向键+,/.`);
    render();
  }

  function logLine(text, cls) {
    const box = $('eventLog');
    const div = document.createElement('div');
    div.className = 'logline ' + (cls || '');
    div.textContent = `t=${app.clock}  ${text}`;
    box.prepend(div);
    while (box.childElementCount > 200) box.lastChild.remove();
  }

  function reconcile() {
    let guard = 0;
    while ((app.peers[0].needsResync || app.peers[1].needsResync) && guard++ < 10) {
      const needy = app.peers.find((p) => p.needsResync);
      const other = app.peers.find((p) => p !== needy);
      const req = needy.needsResync;
      const entry = needy.resyncFrom(other, req.reason, Object.assign({ clock: app.clock }, req.detail));
      logLine(`P${needy.id} 重同步：${REASON_TEXT[req.reason] || req.reason} ` +
        `（采用 P${entry.sourcePeer} 的 frame ${entry.adoptedFrame} 状态，校验 ${entry.checksumBefore}→${entry.checksumAfter}）`, 'resync');
      app.flashUntil[needy.id] = app.clock + 6;
    }
  }

  function drainCorrections(peer, previousLogSizes) {
    const idx = peer.id - 1;
    const logs = peer.rollbackLog;
    while (logs.length > previousLogSizes[idx]) {
      const r = logs[previousLogSizes[idx]++];
      const hitChange = r.removedHitIds.length || r.addedHitIds.length;
      logLine(`P${peer.id} 回滚到模拟帧 ${r.baseFrame}：${REASON_TEXT[r.reason]}。` +
        `重演 ${r.reSimFrames[0]}..${r.reSimFrames[r.reSimFrames.length - 1]}，` +
        `预测输入=${r.predictedInput} 实际=${r.actualInput}，` +
        `命中修正 移除=[${r.removedHitIds}] 补回=[${r.addedHitIds}]，` +
        `校验 ${r.checksumBefore}→${r.checksumAfter}`,
        hitChange ? 'rollback-hit' : 'rollback');
      app.flashUntil[peer.id] = app.clock + 8;
    }
  }

  function tick() {
    if (!app.peers) return;
    app.clock += 1;
    // Late inputs delivered here can trigger rollbacks before advance(); drain
    // their logs immediately so no correction is missed in the UI.
    const earlySizes = app.peers.map((p) => p.rollbackLog.length);
    app.net.deliver(app.clock, app.peers);
    app.peers.forEach((p) => drainCorrections(p, earlySizes));
    reconcile();

    let in1; let in2;
    if (app.mode === 'script') {
      if (app.clock > app.scriptFrames) {
        in1 = 0; in2 = 0;
      } else {
        in1 = app.scriptInputs[0][app.clock];
        in2 = app.scriptInputs[1][app.clock];
      }
    } else {
      in1 = app.heldP1;
      in2 = app.heldP2;
    }

    const logSizes = app.peers.map((p) => p.rollbackLog.length);
    let ok1 = true;
    let ok2 = true;
    if (app.clock <= app.scriptFrames || app.mode === 'interactive') {
      ok1 = app.peers[0].advance(in1, app.clock);
      ok2 = app.peers[1].advance(in2, app.clock);
      if (!ok1 || !ok2) {
        reconcile();
        // Watchdog blocked this frame; real inputs now merged via resync, retry once.
        if (app.mode === 'interactive') {
          app.peers[0].advance(in1, app.clock);
          app.peers[1].advance(in2, app.clock);
        }
      }
    }
    // Retransmit only while a ledger still has gaps: once both peers know every
    // scripted input, further bundles would only create endless in-flight noise.
    const ledgerGap = app.peers.some((p) => {
      for (let f = 1; f <= app.scriptFrames; f++) {
        if (p.remoteInputs[f] === null || p.remoteInputs[f] === undefined) return true;
      }
      return false;
    });
    if (app.mode === 'interactive' || ledgerGap) {
      app.net.send(app.peers[0], app.clock);
      app.net.send(app.peers[1], app.clock);
    }

    app.peers.forEach((p) => drainCorrections(p, logSizes));

    // Announce authoritative hit/block events by stable hitId, so a rollback
    // that removes a previously predicted hit cannot confuse the announcement.
    for (const ev of app.peers[0].state.events) {
      if (app.announcedHitIds.has(ev.hitId)) continue;
      app.announcedHitIds.add(ev.hitId);
      logLine(`判定帧 ${ev.frame}：${ev.blocked ? '格挡' : '命中'} ` +
        `P${ev.attacker} ${ev.attack} → P${ev.defender}，暴击=${ev.crit}，伤害=${ev.damage}`,
        ev.blocked ? 'blocked' : 'hit');
    }

    if (app.mode === 'script' && app.clock > app.scriptFrames && !app._finalized) {
      const ledgersFull = app.peers.every((p) => {
        for (let f = 1; f <= app.scriptFrames; f++) {
          if (p.localInputs[f] === null || p.localInputs[f] === undefined) return false;
          if (p.remoteInputs[f] === null || p.remoteInputs[f] === undefined) return false;
        }
        return true;
      });
      // Require the link to fully drain and no resync to remain pending; the
      // hard-resync scenario keeps packets in flight until after the stall ends.
      const settled = ledgersFull && app.net.inFlight() === 0 &&
        app.peers.every((p) => !p.needsResync);
      if (settled || app.clock >= app.maxClock) {
        app.running = false;
        app._finalized = true;
        finalizeScript();
      }
    }
    render();
  }

  function finalizeScript() {
    const ref = app.refState;
    const lines = app.peers.map((p) => {
      const ok = E.checksum(p.state) === E.checksum(ref);
      return `P${p.id} 最终校验 ${ok ? '与权威参考一致 ✓' : '与权威参考分歧 ✗'} (${E.checksum(p.state)})`;
    });
    lines.forEach((l) => logLine(l, 'final'));
    logLine(`权威参考最终：P1 hp=${ref.players[0].hp} x=${ref.players[0].x} ` +
      `P2 hp=${ref.players[1].hp} x=${ref.players[1].x}，事件数=${ref.events.length}，RNG=${ref.rngState}`, 'final');
  }

  // ---------- rendering ----------
  function drawPeer(canvasId, peer) {
    const canvas = $(canvasId);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // floor
    ctx.strokeStyle = '#475569';
    ctx.beginPath();
    ctx.moveTo(0, H - 2);
    ctx.lineTo(W, H - 2);
    ctx.stroke();

    const correcting = (app.flashUntil[peer.id] || 0) >= app.clock;
    if (correcting) {
      ctx.fillStyle = 'rgba(220,38,38,0.12)';
      ctx.fillRect(0, 0, W, H);
    }

    for (const p of peer.state.players) {
      const hb0 = E.hurtbox(p);
      const hb = scaleBox(hb0);
      const isLocal = p.id === peer.id;
      ctx.fillStyle = p.id === 1 ? '#3b82f6' : '#f59e0b';
      if (!isLocal) ctx.globalAlpha = 0.85;
      ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
      ctx.globalAlpha = 1;

      // facing marker
      ctx.fillStyle = '#0f172a';
      const eyeX = hb.x + (p.facing === 1 ? hb.w - 5 : 2);
      ctx.fillRect(eyeX, hb.y + 6, 3, 3);

      if (app.showHitboxes) {
        const atk = E.hitbox(p);
        if (atk) {
          const a = scaleBox(atk);
          ctx.fillStyle = 'rgba(239,68,68,0.35)';
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 1.5;
          ctx.fillRect(a.x, a.y, a.w, a.h);
          ctx.strokeRect(a.x, a.y, a.w, a.h);
        }
        ctx.strokeStyle = 'rgba(34,197,94,0.9)';
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(hb.x, hb.y, hb.w, hb.h);
        ctx.setLineDash([]);
      }

      if (p.invuln > 0) {
        ctx.strokeStyle = 'rgba(250,204,21,0.9)';
        ctx.strokeRect(hb.x - 2, hb.y - 2, hb.w + 4, hb.h + 4);
      }

      // label: action phase above body
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '11px monospace';
      const phase = E.actionPhase(p);
      ctx.fillText(`P${p.id} ${p.action}(${p.actionFrame}) ${phase} hp=${p.hp}`, hb.x - 4, Math.max(12, hb.y - 6));
    }

    // status strip
    const status = $(canvasId + 'Status');
    const pred = peer.predictedCountInWindow();
    const oldest = peer.oldestSnapshotFrame();
    status.textContent =
      `frame=${peer.state.frame} 校验=${E.checksum(peer.state)}  窗口内预测帧=${pred}  ` +
      `快照 ${oldest}..${peer.state.frame}（${peer.snapshots.size}）  回滚=${peer.stats.rollbacks}  ` +
      `修正=${peer.stats.corrections}  重同步=${peer.stats.resyncs}`;
  }

  function scaleBox(b) {
    return { x: b.x * SCALE, y: H - (b.y + b.h) * SCALE, w: b.w * SCALE, h: b.h * SCALE };
  }

  function render() {
    if (!app.peers) return;
    drawPeer('canvas1', app.peers[0]);
    drawPeer('canvas2', app.peers[1]);
    $('clockLabel').textContent = String(app.clock);
    $('netLabel').textContent =
      `链路 延迟=${app.net.latency}±${app.net.jitter} 丢包=${app.net.lossPct}%  ` +
      `发送=${app.net.stats.sent} 丢失=${app.net.stats.lost} 在途=${app.net.inFlight()}`;
    if (app.refState) {
      const refHash = E.checksum(app.refState);
      $('refLabel').textContent =
        `权威参考（同输入历史直跑）: frame=${app.refState.frame} 校验=${refHash} ` +
        `P1=${app.peers[0].state.frame >= app.refState.frame ? (E.checksum(app.peers[0].state) === refHash ? '一致' : '暂分歧') : '待追帧'} ` +
        `P2=${app.peers[1].state.frame >= app.refState.frame ? (E.checksum(app.peers[1].state) === refHash ? '一致' : '暂分歧') : '待追帧'}`;
    } else {
      $('refLabel').textContent = '实时模式：双端以相同规则各自预测，最终以校验和核对一致性';
    }
  }

  // ---------- controls ----------
  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!app.running) return;
    const interval = 1000 / 60 / app.speed;
    timer = setTimeout(() => { tick(); schedule(); }, interval);
  }

  function setRunning(v) {
    app.running = v;
    $('btnPlay').textContent = v ? '暂停' : '播放';
    schedule();
  }

  function bitFor(ev) {
    return KEYMAP_P1[ev.code] !== undefined ? KEYMAP_P1[ev.code] : KEYMAP_P2[ev.code];
  }
  function whichMap(ev) {
    return KEYMAP_P1[ev.code] !== undefined ? 1 : 2;
  }

  window.addEventListener('keydown', (ev) => {
    if (app.mode !== 'interactive' || !bitFor(ev)) return;
    ev.preventDefault();
    const bit = bitFor(ev);
    if (whichMap(ev) === 1) app.heldP1 |= bit; else app.heldP2 |= bit;
  });
  window.addEventListener('keyup', (ev) => {
    if (!bitFor(ev)) return;
    const bit = bitFor(ev);
    if (whichMap(ev) === 1) app.heldP1 &= ~bit; else app.heldP2 &= ~bit;
  });

  $('btnPlay').addEventListener('click', () => {
    if (app.mode === 'script' && app.clock >= app.maxClock) loadScenario(app.scenarioName);
    setRunning(!app.running);
  });
  $('btnStep').addEventListener('click', () => { setRunning(false); tick(); });
  $('btnReset').addEventListener('click', () => {
    setRunning(false);
    app.mode === 'script' ? loadScenario(app.scenarioName) : startInteractive();
  });
  $('scenarioSelect').addEventListener('change', (e) => {
    setRunning(false);
    loadScenario(e.target.value);
  });
  $('btnInteractive').addEventListener('click', () => { setRunning(false); startInteractive(); });
  $('speedSelect').addEventListener('change', (e) => { app.speed = Number(e.target.value); });
  $('btnHitboxes').addEventListener('click', () => {
    app.showHitboxes = !app.showHitboxes;
    $('btnHitboxes').textContent = app.showHitboxes ? '隐藏命中盒' : '显示命中盒';
    render();
  });

  // expose for quick in-console checks and the headless DOM smoke test
  window.rollbackDemo = {
    app, tick, loadScenario, startInteractive, setRunning,
    setKey(player, bit, down) {
      const tgt = player === 1 ? 'heldP1' : 'heldP2';
      app[tgt] = down ? (app[tgt] | bit) : (app[tgt] & ~bit);
    },
  };

  loadScenario('flip');
})();
