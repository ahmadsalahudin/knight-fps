/* waves.js - window.Waves (B4 rewrite; docs/FIX_PLAN.md "Waves", diagnosis 1.5).

   Flow:  waves 1-4 = 5 / 7 / 9 / 11 knights (+-2 on Hard / Easy, see Difficulty), spawned ONE AT A TIME on a ring (radius ~30)
          around the arena centre, preferring points behind / beside the player's view, never on a collider and never near
          the player. A wave is complete only when pending == 0 AND alive == 0.  Then the player is healed (25 HP on Normal,
          everything before the boss) via Game.heal, a 4 s countdown banner, then the next wave.
          Wave 5 = the Boss (intro banner + Sfx.bossRoar, boss bar). Victory only after the boss dies -> HUD.victory(stats).
   Everything is driven by update(dt) timers (no setTimeout), so the QA virtual clock and freezeAI behave.

   Boss (wave 5): `new window.Boss()` (no arguments), then mesh.position is set to the spawn point, `waveNumber` is assigned and
   Enemies.add(boss) is called. Waves reads boss.hp / maxHp / displayName / dead. Minions the boss summons itself (Enemies.add)
   are NOT tracked here: they do not hold the wave open and they are killed when the boss dies (victory comes only from the
   boss's death). If the Boss class is missing, throws or comes back unusable, a tougher Knight stands in (Waves.bossFallback).

   Public API
     Waves.start(n)               begin wave n (1..5) right now. n == 1 also resets the run stats (kills, time).
     Waves.stop()                 halt the wave flow: no more spawns, banner / boss bar hidden, state 'idle'.
                                  Enemies already in Enemies.list are NOT touched (use __dbg.clear()).
     Waves.skipTo(n)              Enemies.clear() + stop() + start(n)
     Waves.update(dt)             called by main.js every frame
     Waves.onEnemyKilled(enemy)   call exactly once per death (extra calls are ignored: deduped with enemy._waveCounted).
                                  Owns the kill counter (mirrored into Game.kills and HUD.setKills).
     Waves.stats()                { wave, kills, shots, time, best }
     Waves.snapshot()             JSON-friendly state for logs
   Fields read by debug.js / HUD: current, active, pending, alive, kills, state, runTime, countdown, boss.
   States: idle | fighting | countdown | victory-wait | victory | error. */
(() => {
  'use strict';

  // ------------------------------------------------------------------------------------------------------------------------
  // Difficulty (window.Difficulty): picked on the title screen, remembered in localStorage ('kf_difficulty').
  // Read lazily by enemies.js / boss.js / hud.js at spawn / hit time, so this block only has to exist before the first wave.
  //   dmg      x enemy damage to the player        hp       x knight HP            knights  added to the knights of every wave
  //   boss     x boss HP                           heal     HP restored per wave   windup   x knight windup (telegraph) time
  //   speed    x knight walk / run speed           reach    x boss sweep / slam reach and attack distance
  //   throwers share of knights that throw daggers (chosen when the knight spawns)
  // ------------------------------------------------------------------------------------------------------------------------
  const LEVELS = {
    easy:   { key: 'easy',   label: 'Easy',   dmg: 0.6, hp: 0.8,  knights: -2, boss: 0.75, heal: 40, windup: 1.0, speed: 0.9,  reach: 0.9,  throwers: 0.20 },
    normal: { key: 'normal', label: 'Normal', dmg: 1.0, hp: 1.0,  knights: 0,  boss: 1.0,  heal: 25, windup: 1.0, speed: 1.0,  reach: 1.0,  throwers: 0.35 },
    hard:   { key: 'hard',   label: 'Hard',   dmg: 1.4, hp: 1.25, knights: 2,  boss: 1.3,  heal: 15, windup: 0.8, speed: 1.15, reach: 1.15, throwers: 0.50 },
  };
  let level = 'normal';
  try { const saved = localStorage.getItem('kf_difficulty'); if (saved && LEVELS[saved]) level = saved; } catch (e) { /* private mode */ }

  function paintButtons() {
    document.querySelectorAll('.diffBtn').forEach((b) => {
      const on = b.getAttribute('data-diff') === level;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  window.Difficulty = {
    levels: LEVELS,
    get() { return LEVELS[level]; },
    set(k) {
      if (!LEVELS[k]) return level;
      level = k;
      try { localStorage.setItem('kf_difficulty', k); } catch (e) { /* private mode */ }
      paintButtons();
      return level;
    },
    // damage dealt to the player by an attack of base damage n (never below 1)
    damage(n) { return Math.max(1, Math.round(n * LEVELS[level].dmg)); },
  };
  const bindButtons = () => {
    document.querySelectorAll('.diffBtn').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); Difficulty.set(b.getAttribute('data-diff')); }));
    paintButtons();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindButtons); else bindButtons();
})();

(() => {
  'use strict';

  const TOTAL = 5;                       // wave 5 is the boss
  const KNIGHTS = [0, 5, 7, 9, 11];      // knights per wave (index = wave number)
  const RING_RADIUS = 30;
  const MIN_FROM_PLAYER = 18;            // never spawn closer than this to the player
  const COUNTDOWN = 4;                   // seconds between waves
  // HP restored when a wave is cleared comes from Difficulty.heal (25 on Normal; 100 HP, 15 per knight hit, no other healing);
  // the break before the boss restores everything (the boss does 22-36 per hit).
  const BOSS_DELAY = 1.8;                // boss appears this long after the intro banner / roar
  const VICTORY_DELAY = 3.0;             // let the boss death play out before the victory screen
  const MAX_ALIVE = 8;                   // never more than this many wave knights alive at once
  const BOSS_NAME = 'The Iron Warlord';

  const bestOf = () => { try { return parseInt(localStorage.getItem('kf_best') || '0', 10) || 0; } catch (e) { return 0; } };
  const saveBest = (n) => { try { if (n > bestOf()) localStorage.setItem('kf_best', String(n)); } catch (e) { /* private mode */ } };

  const isDead = (e) => !!(e && (e.dead === true || (typeof e.hp === 'number' && e.hp <= 0)));
  const hpOf = (e) => (typeof e.hp === 'number' ? e.hp : undefined);
  const inList = (e) => !!(window.Enemies && Enemies.list && Enemies.list.indexOf(e) >= 0);

  // Pick a spawn point on the ring: behind / beside the view, clear of colliders, far from the player.
  function pickSpawn() {
    const G = window.Game;
    const P = G && G.playerObj ? G.playerObj.position : null;
    let fx = 0, fz = -1;
    if (G && G.camera) {
      const d = new THREE.Vector3();
      G.camera.getWorldDirection(d);
      const l = Math.hypot(d.x, d.z);
      if (l > 1e-4) { fx = d.x / l; fz = d.z / l; }
    }
    const cols = (window.World && World.colliders) || [];
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = RING_RADIUS + (Math.random() * 4 - 2);
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      let ok = true;
      for (const c of cols) { if (Math.hypot(x - c.x, z - c.z) < c.r + 1.6) { ok = false; break; } }
      if (!ok) continue;
      let score = Math.random() * 0.6;
      if (P) {
        const dx = x - P.x, dz = z - P.z, dist = Math.hypot(dx, dz);
        if (dist < MIN_FROM_PLAYER) continue;
        score += -(dx * fx + dz * fz) / dist;          // +1 directly behind the player, -1 straight ahead
      }
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    }
    if (!best) {                                         // everything rejected: opposite the view, ignoring colliders
      const a = Math.atan2(-fx, -fz);
      best = { x: Math.sin(a) * RING_RADIUS, z: Math.cos(a) * RING_RADIUS };
    }
    return best;
  }

  function killEnemy(e) {
    try {
      const p = e.mesh.position;
      e.takeHit({ damage: 1e6, zone: 'torso', point: new THREE.Vector3(p.x, 1, p.z), dir: new THREE.Vector3(0, 0, -1) });
    } catch (err) { console.error('[waves] could not kill leftover enemy', err); }
  }

  function standInKnight(wave) {
    const hp = Math.round(800 * Difficulty.get().boss);
    const k = new window.Knight({ scale: 1.5, hp: hp, maxHp: hp, type: 'boss', knockbackScale: 0.1, displayName: BOSS_NAME + ' (stand-in)' });
    k.waveNumber = wave;
    return k;
  }

  // Build the boss. Returns { enemy, fallback }. The real Boss is used when it constructs and looks like a Knight
  // (mesh + takeHit); otherwise a tougher plain Knight stands in so wave 5 can still be played and reported.
  function makeBoss(wave) {
    let err = null;
    try {
      if (typeof window.Boss !== 'function') throw new Error('window.Boss is not defined');
      const b = new window.Boss();
      if (!b || !b.mesh || typeof b.takeHit !== 'function') throw new Error('Boss instance has no mesh / takeHit');
      b.waveNumber = wave;
      return { enemy: b, fallback: false, error: null };
    } catch (e) { err = e; }
    console.error('[waves] Boss construction failed, using a tougher knight as a stand-in:', err);
    const msg = String((err && err.message) || err);
    try {
      return { enemy: standInKnight(wave), fallback: true, error: msg };
    } catch (err2) {
      console.error('[waves] stand-in knight failed too:', err2);
      return { enemy: null, fallback: true, error: msg };
    }
  }

  const Waves = {
    total: TOTAL,
    current: 0,
    active: false,          // a wave is in progress (spawning / fighting)
    state: 'idle',
    pending: 0,             // knights of this wave not spawned yet
    alive: 0,               // spawned by this wave and not yet dead
    kills: 0,
    runTime: 0,             // seconds of wave time since wave 1 started
    countdown: 0,
    boss: null,
    bossKilled: false,
    bossError: null,        // message if `new Boss()` threw
    bossFallback: false,    // true when a tougher Knight stands in for a boss that failed to construct
    spawnFailures: 0,

    _tracked: [],
    _spawnTimer: 0,
    _bossWave: false,
    _bossMax: 1,
    _cdShown: -1,
    _victoryTimer: 0,

    // ------------------------------------------------------------------ control
    start(n) {
      n = Math.max(1, Math.min(TOTAL, Math.floor(Number(n)) || 1));
      if (n === 1) { this.kills = 0; this.runTime = 0; if (window.Game) Game.kills = 0; }
      this._begin(n);
    },

    stop() {
      this._reset();
      this.state = 'idle';
      this.active = false;
      this.pending = 0;
      this.alive = 0;
      this.countdown = 0;
      if (window.Sfx && Sfx.duck) Sfx.duck(false);
      if (window.HUD) {
        if (HUD.clearBanner) HUD.clearBanner();
        if (HUD.bossBar) HUD.bossBar(false);
        if (HUD.setEnemiesLeft) HUD.setEnemiesLeft(0);
      }
    },

    skipTo(n) {
      if (window.Enemies && Enemies.clear) Enemies.clear();
      this.stop();
      this.start(n);
    },

    // ------------------------------------------------------------------ per frame
    update(dt) {
      const st = this.state;
      if (st === 'idle' || st === 'victory' || st === 'error') return;
      this.runTime += dt;

      if (st === 'countdown') {
        this.countdown -= dt;
        const sec = Math.max(1, Math.ceil(this.countdown));
        if (this.countdown <= 0) { this._begin(this.current + 1); return; }
        if (sec !== this._cdShown) { this._cdShown = sec; this._countdownBanner(sec); }
        return;
      }

      if (st === 'victory-wait') {
        this._victoryTimer -= dt;
        this._poll();
        if (this._victoryTimer <= 0) this._victory();
        return;
      }

      // ---- fighting
      this._poll();

      if (this.pending > 0) {
        this._spawnTimer -= dt;
        if (this._spawnTimer <= 0 && (this._bossWave || this.alive < MAX_ALIVE)) {
          this._spawnOne();
          this._spawnTimer = Math.max(0.9, 2.6 - 0.35 * this.current);
        }
      }

      this._updateBossBar();
      this._hud();

      if (this._bossWave && this.bossKilled) { this._beginVictory(); return; }
      if (this.pending === 0 && this.alive === 0) this._finishWave();
    },

    // ------------------------------------------------------------------ kills
    onEnemyKilled(enemy) {
      if (!enemy || enemy._waveCounted) return;
      enemy._waveCounted = true;
      this.kills++;
      if (window.Game) Game.kills = this.kills;
      if (window.HUD && HUD.setKills) HUD.setKills(this.kills);

      const i = this._tracked.indexOf(enemy);
      if (i >= 0) { this._tracked.splice(i, 1); this.alive = Math.max(0, this.alive - 1); }
      if (enemy === this.boss) {
        this.bossKilled = true;
        if (window.HUD && HUD.bossBar) HUD.bossBar(true, 0, this._bossName());
      }
      this._hud();
    },

    stats() {
      const out = {
        wave: this.current,
        kills: this.kills,
        shots: window.Game ? (Game.shots || 0) : 0,
        time: Math.round(this.runTime),
        best: Math.max(bestOf(), this.current),
        difficulty: Difficulty.get().label,
      };
      // Game.stats() (when present) adds hits / headshots / accuracy
      try {
        const g = window.Game && typeof Game.stats === 'function' ? Game.stats() : null;
        if (g) { out.hits = g.hits; out.headshots = g.headshots; out.accuracy = g.accuracy; }
      } catch (e) { /* ignore */ }
      return out;
    },

    snapshot() {
      return {
        state: this.state, wave: this.current, active: this.active, pending: this.pending, alive: this.alive,
        kills: this.kills, countdown: Math.round(this.countdown * 100) / 100, runTime: Math.round(this.runTime * 100) / 100,
        boss: !!this.boss, bossKilled: this.bossKilled, bossError: this.bossError, bossFallback: this.bossFallback,
        spawnFailures: this.spawnFailures,
      };
    },

    // ------------------------------------------------------------------ internals
    _reset() {
      this._tracked.length = 0;
      this._spawnTimer = 0;
      this._victoryTimer = 0;
      this._cdShown = -1;
      this.boss = null;
      this.bossKilled = false;
      this.bossError = null;
      this.bossFallback = false;
      this.spawnFailures = 0;
      this._bossWave = false;
    },

    _bossName() { return this.bossFallback ? BOSS_NAME + ' (stand-in)' : ((this.boss && this.boss.displayName) || BOSS_NAME); },

    _begin(n) {
      this._reset();
      this.current = n;
      this.active = true;
      this.state = 'fighting';
      this.countdown = 0;
      this._bossWave = (n === TOTAL);
      this.pending = this._bossWave ? 1 : Math.max(1, KNIGHTS[n] + Difficulty.get().knights);
      this.alive = 0;
      this._spawnTimer = this._bossWave ? BOSS_DELAY : 0;

      if (window.HUD) {
        if (HUD.setWave) HUD.setWave(n, TOTAL);
        if (HUD.setKills) HUD.setKills(this.kills);
        if (HUD.bossBar) HUD.bossBar(false);
        if (HUD.banner) {
          if (this._bossWave) HUD.banner('Boss wave', BOSS_NAME + ' approaches', 3600, { kind: 'boss' });
          else HUD.banner('Wave ' + n, this.pending + ' knights approach', 2600);
        }
      }
      if (window.Sfx) {
        if (this._bossWave) { if (Sfx.bossRoar) Sfx.bossRoar(); }
        else if (Sfx.waveStart) Sfx.waveStart();
        if (Sfx.duck) Sfx.duck(this._bossWave);                // the meadow ambience drops a little during the boss fight
      }
      // first knight is on the field immediately; the boss waits for its intro
      if (!this._bossWave) { this._spawnOne(); this._spawnTimer = Math.max(0.9, 2.6 - 0.35 * n); }
      this._hud();
    },

    _spawnOne() {
      if (this.pending <= 0) return;
      const pos = pickSpawn();
      let e = null;
      if (this._bossWave) {
        const b = makeBoss(this.current);
        e = b.enemy;
        this.bossFallback = b.fallback;
        this.bossError = b.error;
      } else {
        try { e = new window.Knight(); } catch (err) {
          console.error('[waves] Knight construction failed:', err);
          e = null;
        }
      }

      this.pending--;
      if (!e) { this.spawnFailures++; this._hud(); return; }
      e.waveNumber = this.current;

      try {
        e.mesh.position.set(pos.x, 0, pos.z);
        window.Enemies.add(e);
      } catch (err) {
        console.error('[waves] could not add enemy to the arena:', err);
        if (this._bossWave && !this.bossFallback) {         // the real boss was built but cannot be added: stand-in
          try { if (e.mesh && e.mesh.parent) e.mesh.parent.remove(e.mesh); const i = Enemies.list.indexOf(e); if (i >= 0) Enemies.list.splice(i, 1); } catch (e2) { /* ignore */ }
          this.bossError = String((err && err.message) || err);
          this.bossFallback = true;
          try {
            e = standInKnight(this.current);
            e.mesh.position.set(pos.x, 0, pos.z);
            window.Enemies.add(e);
          } catch (err3) { console.error('[waves] stand-in knight failed too:', err3); this.spawnFailures++; this._hud(); return; }
        } else {
          this.spawnFailures++;
          this._hud();
          return;
        }
      }
      this._tracked.push(e);
      this.alive++;
      if (this._bossWave) {
        this.boss = e;
        const hp = hpOf(e);
        this._bossMax = (typeof e.maxHp === 'number' && e.maxHp > 0) ? e.maxHp : (hp > 0 ? hp : 1);
        if (window.HUD && HUD.bossBar) HUD.bossBar(true, 1, this._bossName());
      }
      this._hud();
    },

    // detect deaths / removals the enemy did not report itself
    _poll() {
      for (let i = this._tracked.length - 1; i >= 0; i--) {
        const e = this._tracked[i];
        if (e._waveCounted) { this._tracked.splice(i, 1); continue; }
        if (isDead(e)) { this.onEnemyKilled(e); continue; }
        if (!inList(e)) {                       // removed without dying (Enemies.clear / debug): not a kill
          this._tracked.splice(i, 1);
          this.alive = Math.max(0, this.alive - 1);
          if (e === this.boss) { this.boss = null; if (window.HUD && HUD.bossBar) HUD.bossBar(false); }
          this._hud();
        }
      }
    },

    _updateBossBar() {
      const b = this.boss;
      if (!b || this.bossKilled || !window.HUD || !HUD.bossBar) return;
      const hp = hpOf(b);
      const max = (typeof b.maxHp === 'number' && b.maxHp > 0) ? b.maxHp : this._bossMax;
      HUD.bossBar(true, typeof hp === 'number' ? Math.max(0, hp) / max : 1, this._bossName());
    },

    // Enemies on the field that this wave did not spawn itself and that are still alive (minions summoned by the boss,
    // debug spawns): they show up in "enemies left" but never hold the wave open.
    _extras() {
      const L = window.Enemies && Enemies.list;
      if (!L) return 0;
      let n = 0;
      for (let i = 0; i < L.length; i++) {
        const e = L[i];
        if (!isDead(e) && !e._waveCounted && this._tracked.indexOf(e) < 0) n++;
      }
      return n;
    },

    _hud() {
      if (window.HUD && HUD.setEnemiesLeft) HUD.setEnemiesLeft(this.pending + this.alive + this._extras());
    },

    _finishWave() {
      if (this._bossWave) {
        // pending and alive are 0 but the boss never died: it was cleared or never spawned
        console.warn('[waves] boss wave ended without a boss kill (boss cleared or failed to spawn); not declaring victory');
        this.state = 'error';
        this.active = false;
        return;
      }
      const done = this.current;
      this.active = false;
      this.state = 'countdown';
      this.countdown = COUNTDOWN;
      this._cdShown = -1;
      if (window.HUD && HUD.setEnemiesLeft) HUD.setEnemiesLeft(0);
      if (window.Game && Game.heal) Game.heal(done === TOTAL - 1 ? 100 : Difficulty.get().heal);
      saveBest(done);
    },

    _countdownBanner(sec) {
      if (!window.HUD || !HUD.banner) return;
      const done = this.current, next = done + 1;
      const sub = (next === TOTAL ? 'The boss arrives in ' : 'Wave ' + next + ' begins in ') + sec;
      // 1.6 s > the 1 s refresh period: HUD extends the same banner (no re-fade) before its fade-out begins
      HUD.banner('Wave ' + done + ' cleared', sub, 1600, { kind: 'clear' });
    },

    _beginVictory() {
      this.state = 'victory-wait';
      this.active = false;
      this._victoryTimer = VICTORY_DELAY;
      // the boss's minions fall with it, so nobody hurts the player over the victory screen
      if (window.Enemies && Enemies.list) {
        for (const e of Enemies.list.slice()) { if (e !== this.boss && !isDead(e)) killEnemy(e); }
      }
      if (window.HUD && HUD.setEnemiesLeft) HUD.setEnemiesLeft(0);
    },

    _victory() {
      this.state = 'victory';
      this.active = false;
      saveBest(TOTAL);
      if (window.HUD && HUD.bossBar) HUD.bossBar(false);
      if (window.Sfx && Sfx.victory) Sfx.victory();
      if (window.HUD && HUD.victory) HUD.victory(this.stats());
      try { document.exitPointerLock(); } catch (e) { /* ignore */ }
    },
  };

  window.Waves = Waves;
})();
