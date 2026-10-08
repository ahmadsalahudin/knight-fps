/* hud.js - window.HUD (B4 rewrite).
   All markup and CSS live in src/index.template.html; this module only looks elements up (lazily, so any HUD call
   works even before HUD.init(), e.g. Game.init() calls updateAmmo/updateHP first) and animates them.

   Every timed effect (banner fade, hit marker, damage arcs, vignette, HP/boss "ghost" trails) is driven by ONE
   requestAnimationFrame loop that reads performance.now(), so it follows the QA harness' virtual clock and
   never uses setTimeout/CSS transitions. The loop sleeps whenever nothing is animating.

   API (docs/FIX_PLAN.md "HUD and Sfx"):
     init()                              look up elements, bind the restart buttons (idempotent)
     setWave(n, total)                   "WAVE 2 / 5" ("FINAL WAVE" when n >= total). No BEST text.
     banner(title, sub, ms, opts)        centre banner for ms (default 2500). Same title while visible => only the
                                         subtitle changes and the time is extended (no re-fade: used by the countdown).
                                         opts.kind: 'boss' | 'clear'.  banner('') / clearBanner() hides it.
     updateAmmo(ammo, max, reloading)
     updateHP(hp, max = 100)
     playerHit(fromAngle?, strength?)    red vignette flash + a directional arc around the crosshair.
                                         fromAngle (radians) is RELATIVE TO THE VIEW: 0 = attacker straight ahead,
                                         +PI/2 = on the player's right, PI = behind, -PI/2 = left.
                                         It may also be a world position ({x, z} / THREE.Vector3): the arc then keeps
                                         pointing at it while the player turns. No argument = vignette only.
     angleTo(worldPos) -> relative angle in radians (helper, same convention)
     hitmark('hit'|'head'|'kill')        white ticks / gold ticks + ring / big red ticks + ring
     bossBar(show, frac, name)           cheap to call every frame
     setKills(n), setEnemiesLeft(n)
     gameOver(stats|wave), victory(stats|wave)   stats: { wave, kills, shots, time(s), best } */
(function () {
  'use strict';

  const now = () => performance.now();
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const $ = (id) => document.getElementById(id);
  const easeOut = (p) => 1 - (1 - p) * (1 - p);

  // ---------------------------------------------------------------- element cache
  let E = null;
  let bound = false;

  function ensure() {
    if (E) return E;
    E = {
      wave: $('waveInfo'), enemies: $('enemiesLeft'), kills: $('killCount'),
      bossBar: $('bossBar'), bossName: $('bossName'), bossFill: $('bossFill'), bossGhost: $('bossGhost'), bossPct: $('bossPct'),
      banner: $('banner'), bannerTitle: $('bannerTitle'), bannerSub: $('bannerSub'),
      hit: $('hitMarker'), hitTicks: [], hitRing: null,
      vignette: $('vignette'), lowHp: $('lowHp'),
      hpFill: $('hpFill'), hpGhost: $('hpGhost'), hpText: $('hpText'),
      pipsBox: $('ammoPips'), spinner: $('reloadSpinner'),
      arcs: Array.prototype.slice.call(document.querySelectorAll('#dmgDirs .dmg-arc')),
      gameOver: $('gameOverScreen'), victory: $('victoryScreen'),
    };
    if (E.hit) {
      E.hitTicks = Array.prototype.slice.call(E.hit.querySelectorAll('i'));
      E.hitRing = E.hit.querySelector('b');
    }
    if (!bound) {
      bound = true;
      const reload = () => { try { window.location.reload(); } catch (e) { /* ignore */ } };
      const r = $('restartButton'), c = $('continueButton');
      if (r) r.addEventListener('click', reload);
      if (c) c.addEventListener('click', reload);
    }
    return E;
  }

  // ---------------------------------------------------------------- animation state
  const S = {
    banner: null,                 // { t0, dur, title, kind }
    hit: null,                    // { t0, kind }
    vig: null,                    // { t0, dur, peak }
    arcs: [],                     // { el, t0, dur, angle, pos }
    hpFrac: 1,
    hp: { v: 1, target: 1, hold: 0 },
    boss: { v: 1, target: 1, hold: 0, shown: false, name: '', pct: -1 },
    last: 0,
  };
  let raf = 0;

  function wake() {
    if (raf) return;
    S.last = now();
    raf = requestAnimationFrame(tick);
  }

  // trailing "ghost" value behind a bar: jumps up instantly, trails down after a short hold
  function ghostSet(g, frac) {
    if (frac >= g.v) g.v = frac;
    else if (frac < g.target) g.hold = 0.4;
    g.target = frac;
  }
  function ghostStep(g, dt) {
    if (g.v <= g.target + 0.0005) { g.v = g.target; return false; }
    if (g.hold > 0) { g.hold -= dt; return true; }
    g.v = Math.max(g.target, g.v - dt * 0.55);
    return true;
  }

  const HIT_KINDS = {
    hit:  { dur: 170, w: 2, l: 8,  d0: 7,  d1: 12, ring: false },
    head: { dur: 320, w: 3, l: 11, d0: 9,  d1: 17, ring: true },
    kill: { dur: 560, w: 4, l: 15, d0: 10, d1: 27, ring: true },
  };

  function relAngle(px, pz) {
    // angle of world point (px, pz) relative to where the camera looks: 0 ahead, + right
    const G = window.Game;
    if (!G || !G.camera || !G.playerObj) return 0;
    const cam = G.camera, pp = G.playerObj.position;
    const e = cam.matrixWorld.elements;
    // camera looks down its local -Z: world forward = -(third column)
    let dx = -e[8], dz = -e[10];
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    const vx = px - pp.x, vz = pz - pp.z;
    // right vector on the ground plane = (-fz, fx)  (same convention as debug.js)
    return Math.atan2(vx * -dz + vz * dx, vx * dx + vz * dz);
  }

  function tick() {
    raf = 0;
    const t = now();
    const dt = clamp((t - S.last) / 1000, 0, 0.1);
    S.last = t;
    const e = ensure();
    let busy = false;

    // ---- banner
    const b = S.banner;
    if (b && e.banner) {
      const el = t - b.t0;
      if (el >= b.dur) {
        S.banner = null;
        e.banner.style.opacity = '0'; e.banner.style.visibility = 'hidden';
      } else {
        const fin = clamp(el / 240, 0, 1), fout = clamp((b.dur - el) / 480, 0, 1);
        e.banner.style.opacity = String(Math.min(easeOut(fin), fout));
        e.banner.style.transform = 'scale(' + (1 + 0.1 * (1 - easeOut(fin))).toFixed(3) + ')';
        busy = true;
      }
    }

    // ---- hit marker
    const h = S.hit;
    if (h && e.hit) {
      const k = HIT_KINDS[h.kind] || HIT_KINDS.hit;
      const p = (t - h.t0) / k.dur;
      if (p >= 1) {
        S.hit = null; e.hit.style.opacity = '0';
      } else {
        const q = easeOut(clamp(p, 0, 1));
        e.hit.style.opacity = String(p < 0.15 ? 1 : 1 - Math.pow((p - 0.15) / 0.85, 1.6));
        e.hit.style.setProperty('--d', (k.d0 + (k.d1 - k.d0) * q).toFixed(2) + 'px');
        if (k.ring) e.hit.style.setProperty('--ring', (1 + 1.5 * q).toFixed(3));
        busy = true;
      }
    }

    // ---- red vignette flash
    const v = S.vig;
    if (v && e.vignette) {
      const p = (t - v.t0) / v.dur;
      if (p >= 1) {
        S.vig = null; e.vignette.style.opacity = '0'; e.vignette.style.visibility = 'hidden';
      } else {
        e.vignette.style.opacity = String(v.peak * Math.pow(1 - p, 1.4));
        busy = true;
      }
    }

    // ---- directional damage arcs
    if (S.arcs.length) {
      const sc = Math.min(window.innerWidth, window.innerHeight) / 720;
      for (let i = S.arcs.length - 1; i >= 0; i--) {
        const a = S.arcs[i];
        const p = (t - a.t0) / a.dur;
        if (p >= 1) {
          a.el.style.opacity = '0'; a.el.style.visibility = 'hidden';
          S.arcs.splice(i, 1);
          continue;
        }
        if (a.pos) a.angle = relAngle(a.pos.x, a.pos.z);
        a.el.style.opacity = String(p < 0.3 ? 1 : 1 - (p - 0.3) / 0.7);
        a.el.style.transform = 'rotate(' + (a.angle * 180 / Math.PI).toFixed(1) + 'deg) scale(' + sc.toFixed(3) + ')';
        busy = true;
      }
    }

    // ---- HP ghost + low-HP pulse
    if (ghostStep(S.hp, dt)) busy = true;
    if (e.hpGhost) e.hpGhost.style.width = (S.hp.v * 100).toFixed(1) + '%';
    if (e.lowHp) {
      if (S.hpFrac > 0 && S.hpFrac < 0.3) {
        const sev = 1 - S.hpFrac / 0.3;
        e.lowHp.style.visibility = 'visible';
        e.lowHp.style.opacity = String((0.25 + 0.2 * Math.sin(t / 170)) * (0.4 + 0.6 * sev));
        busy = true;
      } else if (e.lowHp.style.visibility !== 'hidden') {
        e.lowHp.style.opacity = '0'; e.lowHp.style.visibility = 'hidden';
      }
    }

    // ---- boss ghost
    if (S.boss.shown) {
      if (ghostStep(S.boss, dt)) busy = true;
      if (e.bossGhost) e.bossGhost.style.width = (S.boss.v * 100).toFixed(1) + '%';
    }

    if (busy) raf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- stats helpers
  function bestWave() {
    try { return parseInt(localStorage.getItem('kf_best') || '0', 10) || 0; } catch (e) { return 0; }
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function resolveStats(x) {
    const W = window.Waves, G = window.Game;
    const s = (x && typeof x === 'object') ? Object.assign({}, x) : {};
    if (typeof x === 'number') s.wave = x;
    if (s.wave == null) s.wave = (W && typeof W.current === 'number') ? W.current : 1;
    if (s.kills == null) s.kills = (W && typeof W.kills === 'number') ? W.kills : (G && G.kills) || 0;
    if (s.shots == null) s.shots = (G && G.shots) || 0;
    if (s.time == null && W && typeof W.runTime === 'number') s.time = W.runTime;
    if (s.accuracy == null && s.hits != null && s.shots) s.accuracy = s.hits / s.shots;
    s.best = Math.max(s.best || 0, bestWave(), s.wave);
    return s;
  }
  function fillStats(boxId, rows) {
    const box = $(boxId);
    if (!box) return;
    box.textContent = '';
    for (const r of rows) {
      const a = document.createElement('span'); a.textContent = r[0];
      const b = document.createElement('span'); b.textContent = String(r[1]);
      box.appendChild(a); box.appendChild(b);
    }
  }
  function statRows(s, waveLabel) {
    const rows = [[waveLabel, s.wave], ['KILLS', s.kills], ['SHOTS FIRED', s.shots]];
    if (typeof s.accuracy === 'number' && s.shots) rows.push(['ACCURACY', Math.round(s.accuracy * 100) + '%']);
    if (typeof s.headshots === 'number') rows.push(['HEADSHOTS', s.headshots]);
    if (s.time != null) rows.push(['TIME', fmtTime(s.time)]);
    rows.push(['BEST WAVE', s.best]);
    return rows;
  }

  // ---------------------------------------------------------------- public API
  const HUD = {
    init: function () {
      const e = ensure();
      if (e.hit) { e.hit.style.opacity = '0'; }
      wake();
    },

    setWave: function (n, total) {
      const e = ensure();
      if (!e.wave) return;
      const fin = total > 1 && n >= total;
      e.wave.textContent = fin ? 'FINAL WAVE' : (total ? 'WAVE ' + n + ' / ' + total : 'WAVE ' + n);
      e.wave.classList.toggle('final', fin);
    },

    banner: function (title, sub, ms, opts) {
      const e = ensure();
      if (!e.banner) return;
      if (title === null || title === undefined || title === '') { HUD.clearBanner(); return; }
      const t = now();
      ms = (ms === undefined || ms === null) ? 2500 : Math.max(200, Number(ms) || 2500);
      const kind = (opts && opts.kind) || '';
      const cur = S.banner;
      if (cur && cur.title === title && cur.kind === kind && t - cur.t0 < cur.dur) {
        cur.dur = (t - cur.t0) + ms;               // same banner still up: just extend it
      } else {
        S.banner = { t0: t, dur: ms, title: title, kind: kind };
        e.bannerTitle.textContent = title;
        e.banner.className = kind;
        e.banner.style.visibility = 'visible';
        e.banner.style.opacity = '0';
      }
      e.bannerSub.textContent = sub || '';
      e.bannerSub.style.display = sub ? '' : 'none';
      wake();
    },

    clearBanner: function () {
      const e = ensure();
      S.banner = null;
      if (e.banner) { e.banner.style.opacity = '0'; e.banner.style.visibility = 'hidden'; }
    },

    updateAmmo: function (ammo, maxAmmo, reloading) {
      const e = ensure();
      if (e.pipsBox) {
        const max = Math.max(1, (maxAmmo | 0) || 6);
        let pips = e.pipsBox.children;
        while (pips.length < max) { const p = document.createElement('span'); p.className = 'ammo-pip'; e.pipsBox.appendChild(p); }
        while (pips.length > max) e.pipsBox.removeChild(e.pipsBox.lastChild);
        for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('empty', i >= ammo);
      }
      if (e.spinner) e.spinner.style.display = reloading ? 'block' : 'none';
    },

    updateHP: function (hp, maxHp) {
      const e = ensure();
      const max = maxHp > 0 ? maxHp : 100;
      const frac = clamp((Number(hp) || 0) / max, 0, 1);
      S.hpFrac = frac;
      if (e.hpFill) {
        e.hpFill.style.width = (frac * 100).toFixed(1) + '%';
        e.hpFill.style.background = 'hsl(' + Math.round(frac * 115) + ',68%,' + (frac < 0.3 ? 46 : 40) + '%)';
      }
      if (e.hpText) e.hpText.textContent = String(Math.ceil(Math.max(0, hp) || 0));
      ghostSet(S.hp, frac);
      wake();
    },

    playerHit: function (fromAngle, strength) {
      const e = ensure();
      const t = now();
      S.vig = { t0: t, dur: 420, peak: clamp(strength === undefined ? 0.9 : strength, 0.2, 1) };
      if (e.vignette) { e.vignette.style.visibility = 'visible'; e.vignette.style.opacity = String(S.vig.peak); }

      let angle = null, pos = null;
      if (typeof fromAngle === 'number' && isFinite(fromAngle)) angle = fromAngle;
      else if (fromAngle && typeof fromAngle === 'object' && isFinite(fromAngle.x) && isFinite(fromAngle.z)) {
        pos = { x: fromAngle.x, z: fromAngle.z };
        angle = relAngle(pos.x, pos.z);
      }
      if (angle !== null && e.arcs.length) {
        // reuse an arc that already points the same way, else a free one, else the oldest
        let slot = null;
        for (const a of S.arcs) {
          const d = Math.abs(((a.angle - angle) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
          if (d < 0.35) { slot = a; break; }
        }
        if (!slot) {
          const busyEls = S.arcs.map((a) => a.el);
          const free = e.arcs.find((el) => busyEls.indexOf(el) < 0);
          if (free) { slot = { el: free }; S.arcs.push(slot); }
          else { S.arcs.sort((a, b) => a.t0 - b.t0); slot = S.arcs[0]; }   // all busy: recycle the oldest
        }
        slot.t0 = t; slot.dur = 1100; slot.angle = angle; slot.pos = pos;
        slot.el.style.visibility = 'visible';
        slot.el.style.opacity = '1';
      }
      wake();
    },

    angleTo: function (p) { return p ? relAngle(p.x, p.z) : 0; },

    hitmark: function (kind) {
      const e = ensure();
      if (!e.hit) return;
      if (!HIT_KINDS[kind]) kind = 'hit';
      const k = HIT_KINDS[kind];
      e.hit.className = kind;
      e.hit.style.setProperty('--w', k.w + 'px');
      e.hit.style.setProperty('--l', k.l + 'px');
      e.hit.style.setProperty('--d', k.d0 + 'px');
      e.hit.style.setProperty('--ring', '1');
      e.hit.style.opacity = '1';
      S.hit = { t0: now(), kind: kind };
      wake();
    },

    bossBar: function (show, frac, name) {
      const e = ensure();
      if (!e.bossBar) return;
      const B = S.boss;
      if (!show) {
        if (B.shown) { B.shown = false; e.bossBar.classList.add('hidden'); }
        return;
      }
      frac = clamp(Number(frac) || 0, 0, 1);
      if (!B.shown) {
        B.shown = true; B.v = frac; B.target = frac; B.hold = 0; B.pct = -1;
        e.bossBar.classList.remove('hidden');
        if (e.bossGhost) e.bossGhost.style.width = (frac * 100).toFixed(1) + '%';
      }
      if (name !== undefined && name !== B.name) { B.name = name; if (e.bossName) e.bossName.textContent = name; }
      if (frac !== B.target) {
        ghostSet(B, frac);
        if (e.bossFill) e.bossFill.style.width = (frac * 100).toFixed(1) + '%';
        const pct = Math.ceil(frac * 100);
        if (pct !== B.pct) { B.pct = pct; if (e.bossPct) e.bossPct.textContent = pct + '%'; }
        wake();
      } else if (B.pct < 0) {
        B.pct = Math.ceil(frac * 100);
        if (e.bossFill) e.bossFill.style.width = (frac * 100).toFixed(1) + '%';
        if (e.bossPct) e.bossPct.textContent = B.pct + '%';
      }
    },

    setKills: function (n) {
      const e = ensure();
      if (e.kills) { const s = String(n | 0); if (e.kills.textContent !== s) e.kills.textContent = s; }
    },

    setEnemiesLeft: function (n) {
      const e = ensure();
      if (!e.enemies) return;
      const s = n > 0 ? 'ENEMIES LEFT  ' + (n | 0) : '';
      if (e.enemies.textContent !== s) e.enemies.textContent = s;
    },

    gameOver: function (x) {
      const e = ensure();
      const s = resolveStats(x);
      HUD.clearBanner(); HUD.bossBar(false);
      const tag = $('gameOverWave'); if (tag) tag.textContent = 'Fallen on wave ' + s.wave + (s.newBest ? ' - new best!' : '');
      fillStats('gameOverStats', statRows(s, 'WAVE REACHED'));
      if (e.gameOver) e.gameOver.style.display = 'flex';
    },

    victory: function (x) {
      const e = ensure();
      const s = resolveStats(x);
      HUD.clearBanner(); HUD.bossBar(false);
      const tag = $('victoryWave'); if (tag) tag.textContent = 'The Iron Warlord has fallen';
      fillStats('victoryStats', statRows(s, 'WAVES CLEARED'));
      if (e.victory) e.victory.style.display = 'flex';
    },
  };

  window.HUD = HUD;
})();
