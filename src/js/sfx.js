/* sfx.js - window.Sfx (B4 rewrite, then positional audio / ambience / mute + volume): procedural WebAudio sounds, no audio files.

   Graph:  voice -> [PannerNode (HRTF) when the sound has a position] -> master gain -> compressor -> soft clip -> destination
           voice -> send -> reverb (ConvolverNode, generated 1.2 s decaying-noise impulse) -> master gain      (the "outdoors" tail)
           ambience (wind + birds) -> its own gain -> master gain
   - one shared noise buffer, one generated impulse response: nothing is allocated per sound except the nodes
   - the AudioContext is created lazily on the first user gesture (pointerdown/keydown), or on the first Sfx call
   - every entry point is a silent no-op when WebAudio is missing or the context is not running (autoplay policy),
     and never throws. All timing uses the audio clock (no setTimeout), so sequences like reload() are exact.
   - the soft clip after the compressor keeps the output below 0.75 however many sounds overlap

   Positional sound: every sound function takes an optional position ({x, y, z}: a Vector3, a mesh.position, ...) as its LAST
   argument, or use Sfx.at(pos).clang(). Sfx.update(dt, camera) (main.js, every frame) moves the AudioContext listener to the camera.
   Sounds more than ~70 m away are not even started.

   API (docs/FIX_PLAN.md "HUD and Sfx"):
     shoot, dryFire, reload, cock, swing(heavy?), clang, armorHit, headshot, fleshHit, hurt, kill (= death), bossRoar,
     footstep(kind?), waveStart, victory
     daggers: throwWhoosh(pos), whirr(pos, maxSeconds) -> {move(pos), stop()} | null, dagger('ground'|'clang'|'hit', pos)
     kick: kickWhoosh() (the player's foot through empty air, not positional), kickThud(pos) (a boot into plate armour)
   Ambience: ambient(on) (meadow wind + occasional birds; main.js starts it on START), duck(on) (quieter during the boss fight), bird(pos?)
   Controls: init() (call from a gesture), volume(v 0..1, remembered in localStorage 'kf_volume'), mute(on?) (M key; shows #muteHint),
     isMuted(). The title screen slider #volSlider is wired here.
   Test hook: Sfx._useContext(ctx) swaps in e.g. an OfflineAudioContext so a sound can be rendered and measured (tools/qa/audio-check.mjs). */
(function () {
  'use strict';

  const Ctor = window.AudioContext || window.webkitAudioContext;
  const REF = 2.5, ROLL = 1.3, MAXD = 150;       // PannerNode: full volume inside REF metres, inverse-distance falloff after it
  const AMB_LEVEL = 0.16, AMB_DUCK = 0.45;       // ambience gain, and its factor during the boss fight
  const S = {
    c: null,            // AudioContext
    out: null,          // master gain
    dest: null,         // where the voices being built connect to: the master gain, or a PannerNode for a positional sound
    sendScale: 1,       // reverb send scale of the sound being built (distance attenuation of a positional sound)
    verb: null,         // reverb send bus
    noise: null,        // shared white-noise AudioBuffer
    vol: 0.8,
    muted: false,
    force: false,       // test hook: play even though ctx.state !== 'running' (OfflineAudioContext)
    trim: 1,            // per-sound level trim, applied by envelope() while a sound is being built
    pos: null,          // position set by Sfx.at(pos) for the next sound
    lis: { x: 0, y: 1.7, z: 0 },   // listener position (last Sfx.update)
    amb: null,          // running ambience { gain, ... }
    ambWanted: false, ducked: false, birdT: 3, retryT: 0,
    last: Object.create(null),
  };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const masterGain = (v) => v * v * 1.25;        // slider curve: 0.8 -> 0.8, 0.5 -> 0.31

  const store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  (function () {
    const v = parseInt(store.get('kf_volume'), 10);
    if (isFinite(v) && v >= 0 && v <= 100) S.vol = v / 100;
  })();

  // ---------------------------------------------------------------- context
  function build(c) {
    S.c = c;
    S.out = c.createGain();
    S.out.gain.value = S.muted ? 0 : masterGain(S.vol);
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 24; comp.ratio.value = 5;
    comp.attack.value = 0.003; comp.release.value = 0.2;
    // soft clip: whatever the compressor lets through is rounded off, so overlapping sounds never reach 1.0
    const clip = c.createWaveShaper();
    const curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) curve[i] = 0.9 * Math.tanh(1.1 * (i / 512 - 1));
    clip.curve = curve;
    S.out.connect(comp); comp.connect(clip); clip.connect(c.destination);
    S.dest = S.out; S.sendScale = 1;

    // shared noise (2 s, looped by every noise voice)
    const n = Math.floor(c.sampleRate * 2);
    S.noise = c.createBuffer(1, n, c.sampleRate);
    const d = S.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    // reverb: decaying stereo noise impulse (1.2 s), darkened on the way in
    const len = Math.floor(c.sampleRate * 1.2);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const a = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) a[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    const conv = c.createConvolver(); conv.buffer = ir;
    const verbIn = c.createGain(); verbIn.gain.value = 1;
    const dark = c.createBiquadFilter(); dark.type = 'lowpass'; dark.frequency.value = 3200;
    const verbOut = c.createGain(); verbOut.gain.value = 0.55;
    verbIn.connect(dark); dark.connect(conv); conv.connect(verbOut); verbOut.connect(S.out);
    S.verb = verbIn;

    S.amb = null; S.birdT = 2; S.retryT = 0;
    setListener(S.lis.x, S.lis.y, S.lis.z, 0, 0, -1, 0, 1, 0);
  }

  function ctx() {
    if (S.c) return S.c;
    if (!Ctor) return null;
    try { build(new Ctor()); } catch (e) { S.c = null; return null; }
    return S.c;
  }

  // Returns the running context, or null when sound cannot play right now.
  function ready() {
    const c = ctx();
    if (!c) return null;
    if (S.force) return c;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) { /* ignore */ } return null; }
    return c.state === 'running' ? c : null;
  }

  // Cooldown per sound name (seconds of audio clock), so spamming events cannot stack hundreds of voices.
  function gate(name, minGap) {
    const c = S.c;
    const t = c.currentTime;
    if (S.last[name] !== undefined && t - S.last[name] < minGap) return false;
    S.last[name] = t;
    return true;
  }

  function unlock() {
    const c = ctx();
    if (c && c.state === 'suspended') { try { c.resume(); } catch (e) { /* ignore */ } }
  }
  ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'touchend', 'click'].forEach((ev) => {   // iOS only unlocks audio on touchend / click
    try { document.addEventListener(ev, unlock, { capture: true, passive: true }); } catch (e) { /* ignore */ }
  });

  // ---------------------------------------------------------------- 3D positioning
  function setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    const L = S.c && S.c.listener;
    if (!L) return;
    S.lis.x = px; S.lis.y = py; S.lis.z = pz;
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition(px, py, pz); L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  function placePanner(pn, x, y, z) {
    if (pn.positionX) { pn.positionX.value = x; pn.positionY.value = y; pn.positionZ.value = z; } else pn.setPosition(x, y, z);
  }

  function newPanner(c, x, y, z, ref) {
    const pn = c.createPanner();
    pn.panningModel = 'HRTF'; pn.distanceModel = 'inverse';
    pn.refDistance = ref || REF; pn.rolloffFactor = ROLL; pn.maxDistance = MAXD;
    placePanner(pn, x, y, z);
    pn.connect(S.out);
    return pn;
  }

  // HRTF panner for a one-shot sound at p, with `_g` = its distance gain; null when it would be inaudible (not worth the nodes)
  // `ref` = how far (m) the sound carries at full volume: bigger for the boss than for a knight's boot
  function panner(c, p, ref) {
    ref = ref || REF;
    const y = typeof p.y === 'number' ? p.y : 1;
    const dist = Math.hypot(p.x - S.lis.x, y - S.lis.y, p.z - S.lis.z);
    const g = ref / (ref + ROLL * (Math.max(dist, ref) - ref));
    if (!(g >= 0.025)) return null;
    const pn = newPanner(c, p.x, y, p.z, ref);
    pn._g = g;
    return pn;
  }

  // ---------------------------------------------------------------- voice builders
  function envelope(node, o) {
    const c = S.c, t = o.t;
    const a = o.attack || 0.002;
    const dur = Math.max(o.dur, a + 0.01);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    const peak = Math.max(0.0002, o.gain * S.trim);
    g.gain.linearRampToValueAtTime(peak, t + a);
    if (o.hold) g.gain.setValueAtTime(peak, t + a + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g);
    g.connect(S.dest);
    if (o.send) { const s = c.createGain(); s.gain.value = o.send * S.sendScale; g.connect(s); s.connect(S.verb); }
    return dur;
  }

  // Filtered noise burst.  o: t, dur, gain, type, f0, f1, q, attack, hold, send
  function N(o) {
    const c = S.c;
    const src = c.createBufferSource();
    src.buffer = S.noise; src.loop = true;
    const f = c.createBiquadFilter();
    f.type = o.type || 'lowpass';
    f.frequency.setValueAtTime(o.f0, o.t);
    if (o.f1 && o.f1 !== o.f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), o.t + o.dur);
    f.Q.value = o.q || 0.7;
    src.connect(f);
    const dur = envelope(f, o);
    src.start(o.t, Math.random() * 1.5);
    src.stop(o.t + dur + 0.05);
  }

  // Oscillator voice.  o: t, dur, gain, type, f0, f1, attack, hold, send, lp:[f0,f1,q], detune
  function T(o) {
    const c = S.c;
    const osc = c.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, o.t);
    if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(Math.max(10, o.f1), o.t + o.dur);
    if (o.detune) osc.detune.value = o.detune;
    let node = osc;
    if (o.lp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(o.lp[0], o.t);
      f.frequency.exponentialRampToValueAtTime(Math.max(40, o.lp[1]), o.t + o.dur);
      f.Q.value = o.lp[2] || 0.8;
      osc.connect(f); node = f;
    }
    const dur = envelope(node, o);
    osc.start(o.t);
    osc.stop(o.t + dur + 0.05);
  }

  // Struck metal: inharmonic partials with individual decays + a short noise transient.
  const METAL = [[1, 0.50, 1.0], [2.76, 0.34, 0.68], [5.40, 0.20, 0.45], [8.93, 0.10, 0.28]];
  function metal(t, base, gain, decay, send) {
    for (const p of METAL) {
      T({ t, type: 'sine', f0: base * p[0], f1: base * p[0] * 0.994, dur: decay * p[2], gain: gain * p[1], attack: 0.0008, send });
    }
    N({ t, dur: 0.035, gain: gain * 0.9, type: 'highpass', f0: 2600, f1: 2600, attack: 0.0005 });
  }

  // Run fn(t0, c) when the context is running; swallow any error so game code is never affected.
  // pos (or the position set by Sfx.at) makes the sound 3D: its voices go through an HRTF PannerNode.
  function play(trim, fn, pos, ref) {
    const c = ready();
    if (!c) return;
    const p = pos || S.pos;
    S.trim = trim;
    try {
      if (p && typeof p.x === 'number') {
        const pn = panner(c, p, ref);
        if (!pn) return;
        S.dest = pn; S.sendScale = pn._g;
      }
      fn(c.currentTime + 0.004, c);
    } catch (e) { /* audio must never break the game */ }
    finally { S.trim = 1; S.dest = S.out; S.sendScale = 1; }
  }

  // ---------------------------------------------------------------- master, ambience, controls
  const POSITIONAL = ['shoot', 'swing', 'clang', 'armorHit', 'headshot', 'fleshHit', 'kill', 'death', 'bossRoar', 'footstep',
    'throwWhoosh', 'dagger', 'bird', 'rushCry', 'grenadeBounce', 'grenadeBeep', 'explosion', 'kickThud'];

  function applyMaster() {
    if (!S.out) return;
    try { S.out.gain.setTargetAtTime(S.muted ? 0 : masterGain(S.vol), S.c.currentTime, 0.015); } catch (e) { /* ignore */ }
  }

  // the HUD "MUTED" hint and the title screen volume readout
  function refreshUi() {
    try {
      const pct = Math.round(S.vol * 100);
      const hint = document.getElementById('muteHint'); if (hint) hint.classList.toggle('hidden', !S.muted);
      const sl = document.getElementById('volSlider'); if (sl && String(sl.value) !== String(pct)) sl.value = String(pct);
      const out = document.getElementById('volVal'); if (out) out.textContent = S.muted ? 'MUTED' : pct + '%';
    } catch (e) { /* ignore */ }
  }
  function bindUi() {
    try {
      const sl = document.getElementById('volSlider');
      if (sl) {
        sl.addEventListener('input', function () { Sfx.volume(Number(sl.value) / 100); });
        sl.addEventListener('change', function () { Sfx.init(); Sfx.clang(); });     // a sample at the new level
        sl.addEventListener('click', function (e) { e.stopPropagation(); });
      }
      refreshUi();
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUi); else bindUi();
  try {
    document.addEventListener('keydown', function (e) {
      if (e.code === 'KeyM' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) Sfx.mute();
    });
  } catch (e) { /* ignore */ }

  // Wind: two layers of filtered noise whose levels and cutoffs drift on slow LFOs (gusts).
  function startAmbient() {
    if (S.amb) return true;
    const c = ready();
    if (!c) return false;
    const A = { nodes: [] };
    A.gain = c.createGain();
    A.gain.gain.value = 0.0001;
    A.gain.connect(S.out);
    const layer = function (type, f, q, level) {
      const src = c.createBufferSource(); src.buffer = S.noise; src.loop = true;
      const flt = c.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
      const gn = c.createGain(); gn.gain.value = level;
      src.connect(flt); flt.connect(gn); gn.connect(A.gain);
      src.start(0, Math.random() * 1.5);
      A.nodes.push(src);
      return { flt, gn };
    };
    const lfo = function (param, rate, depth) {
      const o = c.createOscillator(); o.frequency.value = rate;
      const g = c.createGain(); g.gain.value = depth;
      o.connect(g); g.connect(param); o.start();
      A.nodes.push(o);
    };
    const low = layer('lowpass', 420, 0.4, 0.55), mid = layer('bandpass', 900, 0.7, 0.22);
    lfo(low.gn.gain, 0.11, 0.3); lfo(mid.gn.gain, 0.17, 0.14); lfo(mid.flt.frequency, 0.07, 350); lfo(low.flt.frequency, 0.05, 120);
    A.gain.gain.setTargetAtTime(AMB_LEVEL * (S.ducked ? AMB_DUCK : 1), c.currentTime, 1.5);
    S.amb = A;
    return true;
  }
  function stopAmbient() {
    S.ambWanted = false;
    const A = S.amb;
    if (!A) return;
    S.amb = null;
    const c = S.c, now = c.currentTime;
    A.gain.gain.setTargetAtTime(0.0001, now, 0.3);
    A.nodes.forEach(function (n) { try { n.stop(now + 2); } catch (e) { /* ignore */ } });
  }

  // ---------------------------------------------------------------- the sounds
  const Sfx = {
    init: function () { unlock(); return !!ctx(); },

    // master volume 0..1 (remembered). Moving the slider while muted unmutes.
    volume: function (v) {
      v = Number(v);
      S.vol = isFinite(v) ? clamp(v, 0, 1) : S.vol;
      store.set('kf_volume', String(Math.round(S.vol * 100)));
      if (S.muted && S.vol > 0) S.muted = false;
      applyMaster();
      refreshUi();
      return S.vol;
    },
    mute: function (on) {
      S.muted = on === undefined ? !S.muted : !!on;
      applyMaster();
      refreshUi();
      return S.muted;
    },
    isMuted: function () { return S.muted; },

    // Sfx.at(pos).clang(): the same sounds, played from a point in the world
    at: function (pos) {
      const o = {};
      POSITIONAL.forEach(function (name) {
        o[name] = function () {
          S.pos = pos;
          try { return Sfx[name].apply(Sfx, arguments); } finally { S.pos = null; }
        };
      });
      return o;
    },

    // called by main.js every frame: the listener follows the camera, and the ambience (birds) is timed
    update: function (dt, cam) {
      if (!S.c) return;
      try {
        if (cam && cam.matrixWorld) {
          cam.updateWorldMatrix(true, false);
          const e = cam.matrixWorld.elements;
          setListener(e[12], e[13], e[14], -e[8], -e[9], -e[10], e[4], e[5], e[6]);
        }
        if (S.ambWanted) {
          if (!S.amb) {
            S.retryT -= dt;
            if (S.retryT <= 0) { S.retryT = 0.5; startAmbient(); }       // the context may still be waking up
          } else if (!S.muted) {
            S.birdT -= dt;
            if (S.birdT <= 0) { S.birdT = rnd(2.5, 7.5) * (S.ducked ? 2 : 1); Sfx.bird(); }
          }
        }
      } catch (e) { /* ignore */ }
    },

    // meadow ambience: wind that swells and fades, plus an occasional bird (timed by update())
    ambient: function (on) {
      S.ambWanted = on !== false;
      try {
        if (S.ambWanted) { ctx(); startAmbient(); } else stopAmbient();
      } catch (e) { /* ignore */ }
    },
    // quieter ambience while the boss fights
    duck: function (on) {
      S.ducked = !!on;
      try {
        if (S.amb) S.amb.gain.gain.setTargetAtTime(AMB_LEVEL * (S.ducked ? AMB_DUCK : 1), S.c.currentTime, 0.8);
      } catch (e) { /* ignore */ }
    },
    // a few quick rising chirps from somewhere up in the trees (pos optional: random around the listener)
    bird: function (pos) {
      let p = pos || S.pos;
      if (!p) { const a = Math.random() * Math.PI * 2, r = rnd(10, 30); p = { x: S.lis.x + Math.sin(a) * r, y: rnd(5, 12), z: S.lis.z + Math.cos(a) * r }; }
      play(0.6, function (t) {
        const n = 2 + Math.floor(Math.random() * 4), base = rnd(2400, 4200);
        let ti = t;
        for (let i = 0; i < n; i++) {
          const f = base * rnd(0.94, 1.06);
          T({ t: ti, dur: 0.09, type: 'sine', f0: f * 0.85, f1: f * 1.3, gain: 0.32, attack: 0.012, send: 0.5 });
          T({ t: ti, dur: 0.06, type: 'sine', f0: f * 1.7, f1: f * 2.4, gain: 0.07, attack: 0.01 });
          ti += rnd(0.09, 0.17);
        }
      }, p);
    },

    // revolver: sharp crack (filtered noise burst) + low boom (sine dropping ~120 -> 40 Hz) + a short reverb tail.
    // Pitch, filter and level vary a little with every shot, so repeats do not sound identical.
    shoot: function (pos) {
      play(1.5 * rnd(0.9, 1.06), function (t) {
        const k = rnd(0.93, 1.07), cr = rnd(0.85, 1.2);
        N({ t, dur: 0.04, gain: 1.35, type: 'highpass', f0: 2200 * cr, f1: 1500, attack: 0.0006 });                         // crack
        N({ t, dur: 0.13, gain: 0.85, type: 'bandpass', f0: 3200 * cr, f1: 420, q: 0.9, attack: 0.001 });                   // crack body
        T({ t, dur: 0.3, type: 'sine', f0: 120 * k, f1: 40, gain: 1.45, attack: 0.002 });                                   // boom
        T({ t, dur: 0.09, type: 'triangle', f0: 400 * k, f1: 100, gain: 0.45, attack: 0.001 });                             // chest punch
        N({ t, dur: 0.16, gain: 0.5, type: 'lowpass', f0: 1500 * k, f1: 200, attack: 0.002 });                              // powder blast
        N({ t: t + 0.012, dur: 0.55, gain: 0.4, type: 'lowpass', f0: 2600, f1: 260, attack: 0.012, send: 1.0 });            // tail
        N({ t: t + 0.1, dur: 0.3, gain: 0.12, type: 'bandpass', f0: 1200, f1: 300, q: 0.6, attack: 0.006, send: 0.7 });     // slap-back
      }, pos);
    },

    dryFire: function () {
      play(2.0, function (t, c) {
        if (!gate('dry', 0.08)) return;
        N({ t, dur: 0.02, gain: 0.9, type: 'highpass', f0: 3000, f1: 3000, attack: 0.0005 });
        T({ t, dur: 0.045, type: 'square', f0: 1900, f1: 1100, gain: 0.22, attack: 0.0005 });
        T({ t: t + 0.05, dur: 0.035, type: 'triangle', f0: 700, f1: 480, gain: 0.25, attack: 0.001 });
      });
    },

    // hammer being thumbed back: ratchet ticks then a firm lock
    cock: function () {
      play(1.2, function (t) {
        for (let i = 0; i < 3; i++) {
          const ti = t + i * 0.055;
          N({ t: ti, dur: 0.014, gain: 0.4, type: 'highpass', f0: 2500, f1: 2500, attack: 0.0005 });
          T({ t: ti, dur: 0.03, type: 'square', f0: 1300 + i * 230, f1: 900 + i * 150, gain: 0.09, attack: 0.0005 });
        }
        T({ t: t + 0.17, dur: 0.08, type: 'triangle', f0: 520, f1: 290, gain: 0.26, attack: 0.001 });
        N({ t: t + 0.17, dur: 0.03, gain: 0.35, type: 'bandpass', f0: 1800, f1: 1800, q: 1.2, attack: 0.0005 });
      });
    },

    // ~1.5 s sequence: latch, cylinder out, casings drop, rounds loaded, cylinder snaps shut, spin
    reload: function () {
      play(0.75, function (t) {
        N({ t, dur: 0.02, gain: 0.4, type: 'highpass', f0: 2000, f1: 2000, attack: 0.0005 });
        T({ t, dur: 0.05, type: 'square', f0: 900, f1: 600, gain: 0.1, attack: 0.0005 });
        N({ t: t + 0.18, dur: 0.12, gain: 0.12, type: 'bandpass', f0: 900, f1: 500, q: 1.2, attack: 0.02 });
        T({ t: t + 0.2, dur: 0.07, type: 'triangle', f0: 400, f1: 240, gain: 0.25, attack: 0.001 });
        [0.45, 0.52, 0.6].forEach(function (d) {
          T({ t: t + d, dur: 0.14, type: 'sine', f0: rnd(2300, 2900), f1: rnd(2200, 2600), gain: 0.14, attack: 0.0008, send: 0.2 });
          T({ t: t + d, dur: 0.05, type: 'triangle', f0: 760, f1: 480, gain: 0.1, attack: 0.001 });
        });
        [0.82, 0.9, 0.98, 1.06, 1.14, 1.22].forEach(function (d) {
          const j = rnd(-0.008, 0.008);
          T({ t: t + d + j, dur: 0.07, type: 'sine', f0: rnd(3000, 3300), f1: 2800, gain: 0.1, attack: 0.0006 });
          T({ t: t + d + j, dur: 0.05, type: 'triangle', f0: rnd(780, 900), f1: 500, gain: 0.12, attack: 0.001 });
        });
        T({ t: t + 1.34, dur: 0.1, type: 'triangle', f0: 310, f1: 170, gain: 0.36, attack: 0.001 });
        N({ t: t + 1.34, dur: 0.035, gain: 0.45, type: 'highpass', f0: 1500, f1: 1500, attack: 0.0005 });
        N({ t: t + 1.45, dur: 0.13, gain: 0.08, type: 'bandpass', f0: 3000, f1: 2000, q: 2, attack: 0.01 });
      });
    },

    // sword whoosh: band-passed noise that sweeps up then down
    swing: function (heavy, pos) {
      play(1.8, function (t) {
        const dur = heavy ? 0.58 : 0.34;
        N({ t, dur, gain: 0.5, type: 'bandpass', f0: heavy ? 240 : 480, f1: heavy ? 1100 : 2200, q: 1.1, attack: dur * 0.45 });
        N({ t: t + dur * 0.35, dur: dur * 0.65, gain: 0.25, type: 'bandpass', f0: heavy ? 900 : 1800, f1: heavy ? 200 : 480, q: 1.5, attack: 0.02 });
        if (heavy) T({ t, dur: dur, type: 'sine', f0: 90, f1: 55, gain: 0.2, attack: dur * 0.4 });
      }, pos, heavy ? 7 : 0);
    },

    // blade on armour or shield
    clang: function (pos) {
      play(1.5, function (t) {
        if (!gate('clang', 0.05)) return;
        metal(t, rnd(360, 540), 0.62, 0.7, 0.4);
        T({ t, dur: 0.07, type: 'sine', f0: 150, f1: 90, gain: 0.3, attack: 0.001 });
      }, pos);
    },

    // bullet on a steel plate: a short, low "clank" (clustered inharmonic partials, gone in ~0.15 s) over a dull thud
    armorHit: function (pos) {
      play(1.3, function (t) {
        if (!gate('armor', 0.03)) return;
        const base = rnd(520, 760);
        N({ t, dur: 0.05, gain: 0.7, type: 'bandpass', f0: 1800, f1: 900, q: 0.8, attack: 0.0005 });
        [[1, 0.42, 0.16], [1.53, 0.3, 0.12], [2.63, 0.22, 0.09], [4.2, 0.1, 0.06]].forEach(function (p) {
          T({ t, dur: p[2], type: 'sine', f0: base * p[0], f1: base * p[0] * 0.985, gain: p[1], attack: 0.0007, send: 0.2 });
        });
        T({ t, dur: 0.1, type: 'sine', f0: 150, f1: 78, gain: 0.5, attack: 0.001 });
      }, pos);
    },

    // head shot: a sharp, high metallic ping that rings on (helmet), clearly apart from the body clank
    headshot: function (pos) {
      play(1.3, function (t) {
        if (!gate('head', 0.04)) return;
        const base = rnd(1500, 1900);
        N({ t, dur: 0.02, gain: 0.7, type: 'highpass', f0: 4500, f1: 4500, attack: 0.0005 });
        [[1, 0.5, 0.6], [2.32, 0.32, 0.38], [3.9, 0.2, 0.24], [6.1, 0.1, 0.14]].forEach(function (p) {
          T({ t, dur: p[2], type: 'sine', f0: base * p[0], f1: base * p[0] * 0.998, gain: p[1], attack: 0.0006, send: 0.5 });
        });
        T({ t, dur: 0.08, type: 'sine', f0: 170, f1: 90, gain: 0.3, attack: 0.001 });
      }, pos);
    },

    // wet thud
    fleshHit: function (pos) {
      play(1.7, function (t) {
        if (!gate('flesh', 0.03)) return;
        N({ t, dur: 0.11, gain: 0.7, type: 'lowpass', f0: 950, f1: 200, attack: 0.002 });
        T({ t, dur: 0.15, type: 'sine', f0: 125, f1: 52, gain: 0.7, attack: 0.002 });
        N({ t: t + 0.01, dur: 0.07, gain: 0.25, type: 'bandpass', f0: 650, f1: 250, q: 2, attack: 0.004 });
      }, pos);
    },

    // the player takes a hit: body impact + a short pained grunt
    hurt: function () {
      play(1.8, function (t) {
        if (!gate('hurt', 0.12)) return;
        T({ t, dur: 0.24, type: 'sine', f0: 95, f1: 42, gain: 1.1, attack: 0.002 });
        N({ t, dur: 0.2, gain: 0.8, type: 'lowpass', f0: 1300, f1: 280, attack: 0.002 });
        T({ t: t + 0.02, dur: 0.3, type: 'sawtooth', f0: 195, f1: 118, gain: 0.3, attack: 0.025, lp: [800, 300, 1.5] });
      });
    },

    // a kill: a heavy crunch, then the armour coming down piece by piece and the body hitting the ground
    kill: function (pos) {
      play(0.7, function (t) {
        if (!gate('death', 0.1)) return;
        for (let i = 0; i < 5; i++) {
          N({ t: t + i * rnd(0.012, 0.03), dur: 0.05, gain: 0.5, type: 'bandpass', f0: rnd(700, 2200), f1: 300, q: 1.5, attack: 0.001 });
        }
        N({ t, dur: 0.2, gain: 0.8, type: 'lowpass', f0: 1800, f1: 160, attack: 0.002 });
        T({ t, dur: 0.3, type: 'sine', f0: 110, f1: 36, gain: 1.2, attack: 0.002 });
        T({ t: t + 0.04, dur: 0.5, type: 'sawtooth', f0: 170, f1: 62, gain: 0.12, attack: 0.03, lp: [700, 220, 1.2] });
        [[0.1, 0.2], [0.2, 0.16], [0.33, 0.13], [0.5, 0.1], [0.66, 0.07]].forEach(function (p) {
          metal(t + p[0], rnd(280, 640), p[1], 0.38, 0.25);
        });
        T({ t: t + 0.4, dur: 0.38, type: 'sine', f0: 92, f1: 34, gain: 0.9, attack: 0.004 });
        N({ t: t + 0.4, dur: 0.4, gain: 0.4, type: 'lowpass', f0: 650, f1: 130, attack: 0.004, send: 0.3 });
      }, pos, 4);
    },
    death: function (pos) { Sfx.kill(pos); },

    // ~1.9 s: sub boom + distorted vibrato growl + amplitude-modulated noise
    bossRoar: function (pos) {
      play(1.0, function (t, c) {
        const dur = 1.9;
        T({ t, dur: 1.7, type: 'sine', f0: 72, f1: 34, gain: 0.95, attack: 0.06, send: 0.5 });

        const curve = new Float32Array(257);
        for (let i = 0; i < 257; i++) { const x = (i / 128) - 1; curve[i] = Math.tanh(x * 4.5); }
        const vib = c.createOscillator(); vib.frequency.value = 6.5;
        const vibDepth = c.createGain(); vibDepth.gain.value = 5;
        [[64, 46, 0.38], [95, 66, 0.26]].forEach(function (p) {
          const osc = c.createOscillator();
          const shaper = c.createWaveShaper(); shaper.curve = curve;
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(p[0], t);
          osc.frequency.exponentialRampToValueAtTime(p[1], t + dur - 0.2);
          vib.connect(vibDepth); vibDepth.connect(osc.frequency);
          const form = c.createBiquadFilter(); form.type = 'bandpass'; form.Q.value = 2.2;
          form.frequency.setValueAtTime(380, t);
          form.frequency.exponentialRampToValueAtTime(950, t + 0.5);
          form.frequency.exponentialRampToValueAtTime(320, t + dur - 0.1);
          osc.connect(shaper); shaper.connect(form);
          const used = envelope(form, { t, dur, gain: p[2], attack: 0.1, hold: 0.9, send: 0.6 });
          osc.start(t); osc.stop(t + used + 0.05);
        });
        vib.start(t); vib.stop(t + dur + 0.1);

        // rasp: noise whose level is chopped by a 28 Hz LFO
        const src = c.createBufferSource(); src.buffer = S.noise; src.loop = true;
        const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
        bp.frequency.setValueAtTime(520, t); bp.frequency.exponentialRampToValueAtTime(220, t + dur);
        const chop = c.createGain(); chop.gain.value = 0.5;
        const lfo = c.createOscillator(); lfo.frequency.value = 28;
        const lfoAmt = c.createGain(); lfoAmt.gain.value = 0.5;
        lfo.connect(lfoAmt); lfoAmt.connect(chop.gain);
        src.connect(bp); bp.connect(chop);
        const used = envelope(chop, { t, dur: dur - 0.1, gain: 0.55, attack: 0.15, hold: 0.7, send: 0.5 });
        src.start(t, Math.random()); src.stop(t + used + 0.05);
        lfo.start(t); lfo.stop(t + used + 0.05);
      }, pos, 16);
    },

    // kind: undefined = walking player; true / 'run' = sprinting player (game.js passes Game.sprinting);
    //       'knight' = armoured knight (quieter boot + a metallic jingle of plates and chain, randomised); 'heavy' / 'boss' = the boss's stomp.
    footstep: function (kind, pos) {
      const heavy = kind === 'heavy' || kind === 'boss';
      play(1.7, function (t) {
        const knight = kind === 'knight';
        const run = kind === true || kind === 'run';
        if (!gate('step' + (heavy ? 'H' : knight ? 'K' : 'P'), heavy ? 0.12 : knight ? 0.02 : 0.07)) return;
        const k = rnd(0.9, 1.12);
        const lvl = heavy ? 1.3 : knight ? 1.5 : run ? 1.25 : 1.0;
        N({ t, dur: heavy ? 0.14 : 0.09, gain: 0.8 * lvl, type: 'lowpass', f0: (heavy ? 330 : 420) * k, f1: 110, attack: 0.002 });
        T({ t, dur: heavy ? 0.18 : 0.09, type: 'sine', f0: (heavy ? 70 : 88) * k, f1: 42, gain: (heavy ? 0.75 : 0.5) * lvl, attack: 0.002 });
        if (heavy) N({ t, dur: 0.07, gain: 0.2, type: 'highpass', f0: 3800, f1: 3800, attack: 0.0008 });      // plate rattle
        if (knight) {
          // armour jingle: a few small, bright metal ticks a few ms apart
          const n = 2 + Math.floor(Math.random() * 3);
          for (let i = 0; i < n; i++) {
            const ti = t + 0.008 + i * rnd(0.012, 0.035), f = rnd(1900, 3800);
            T({ t: ti, dur: rnd(0.08, 0.16), type: 'sine', f0: f, f1: f * 0.985, gain: rnd(0.06, 0.1), attack: 0.0008, send: 0.3 });
            T({ t: ti, dur: 0.05, type: 'sine', f0: f * 2.7, f1: f * 2.65, gain: 0.03, attack: 0.0008 });
          }
          N({ t, dur: 0.06, gain: 0.12, type: 'bandpass', f0: rnd(3500, 6000), f1: 3000, q: 1.5, attack: 0.001 });
        }
      }, pos, heavy ? 9 : 0);
    },

    // war horn + drum
    waveStart: function () {
      play(0.8, function (t) {
        [[146.8, 0.3, 0], [220.5, 0.2, 0], [147.5, 0.18, 7]].forEach(function (p) {
          T({ t, dur: 1.0, type: 'sawtooth', f0: p[0], f1: p[0], gain: p[1], attack: 0.09, hold: 0.45, detune: p[2],
              lp: [450, 1700, 0.9], send: 0.5 });
        });
        [0, 0.46].forEach(function (d, i) {
          T({ t: t + d, dur: 0.38, type: 'sine', f0: 105, f1: 48, gain: i ? 0.7 : 0.85, attack: 0.003 });
          N({ t: t + d, dur: 0.14, gain: 0.3, type: 'lowpass', f0: 1200, f1: 300, attack: 0.002 });
        });
      });
    },

    // brass arpeggio into a held chord, with a shimmer on top
    victory: function () {
      play(0.9, function (t) {
        [261.6, 329.6, 392, 523.3].forEach(function (f, i) {
          T({ t: t + i * 0.18, dur: 0.5, type: 'sawtooth', f0: f, f1: f, gain: 0.2, attack: 0.02, lp: [900, 2600, 0.8], send: 0.5 });
          T({ t: t + i * 0.18, dur: 0.5, type: 'triangle', f0: f * 2, f1: f * 2, gain: 0.1, attack: 0.02 });
        });
        T({ t, dur: 0.3, type: 'sine', f0: 110, f1: 50, gain: 0.8, attack: 0.003 });
        [261.6, 329.6, 392, 523.3, 659.3].forEach(function (f, i) {
          T({ t: t + 0.85, dur: 2.0, type: 'sawtooth', f0: f, f1: f, gain: 0.13, attack: 0.08, hold: 0.9, detune: (i - 2) * 4,
              lp: [700, 2200, 0.7], send: 0.7 });
        });
        T({ t: t + 0.85, dur: 2.2, type: 'sine', f0: 1046.5, f1: 1046.5, gain: 0.06, attack: 0.2, hold: 0.8, send: 0.9 });
        T({ t: t + 0.85, dur: 0.4, type: 'sine', f0: 100, f1: 50, gain: 0.7, attack: 0.003 });
      });
    },

    // grenade: the pin and spoon, then a short underarm whoosh (the player's own hands: not positional)
    grenadeThrow: function () {
      play(1.2, function (t) {
        N({ t, dur: 0.02, gain: 0.5, type: 'highpass', f0: 2600, f1: 2600, attack: 0.0005 });
        metal(t + 0.02, rnd(1700, 2100), 0.08, 0.12, 0.1);
        N({ t: t + 0.09, dur: 0.3, gain: 0.45, type: 'bandpass', f0: 350, f1: 1500, q: 1.1, attack: 0.1 });
        T({ t: t + 0.09, dur: 0.2, type: 'sine', f0: 150, f1: 90, gain: 0.2, attack: 0.05 });
      });
    },

    // a grenade bouncing: a dull metal knock
    grenadeBounce: function (pos) {
      play(1.1, function (t) {
        if (!gate('nadeBounce', 0.06)) return;
        metal(t, rnd(900, 1300), 0.16, 0.14, 0.2);
        T({ t, dur: 0.07, type: 'sine', f0: 200, f1: 100, gain: 0.3, attack: 0.001 });
      }, pos);
    },

    // the fuse tick / blink of a live grenade
    grenadeBeep: function (pos) {
      play(1.0, function (t) {
        if (!gate('nadeBeep', 0.05)) return;
        T({ t, dur: 0.05, type: 'square', f0: 2100, f1: 2100, gain: 0.07, attack: 0.001 });
      }, pos);
    },

    // a grenade goes off: a sub boom, a bright crack, a burst of debris and a long tail
    explosion: function (pos) {
      play(1.35, function (t) {
        if (!gate('boom', 0.05)) return;
        T({ t, dur: 1.0, type: 'sine', f0: 105, f1: 26, gain: 1.5, attack: 0.002 });
        T({ t, dur: 0.3, type: 'triangle', f0: 260, f1: 50, gain: 0.6, attack: 0.001 });
        N({ t, dur: 0.7, gain: 1.1, type: 'lowpass', f0: 4200, f1: 140, attack: 0.003, send: 0.9 });
        N({ t, dur: 0.12, gain: 0.9, type: 'highpass', f0: 2000, f1: 1400, attack: 0.0005 });
        N({ t: t + 0.03, dur: 1.2, gain: 0.35, type: 'lowpass', f0: 1800, f1: 120, attack: 0.08, send: 1.0 });
        for (let i = 0; i < 7; i++) {
          N({ t: t + rnd(0.12, 0.9), dur: rnd(0.04, 0.12), gain: rnd(0.12, 0.3), type: 'bandpass', f0: rnd(1200, 4200), f1: rnd(300, 900), q: 1.4, attack: 0.001 });
        }
      }, pos, 16);
    },

    // bonus weapon earned: a bright rising chime
    bonus: function () {
      play(1.0, function (t) {
        [523.3, 659.3, 784, 1046.5].forEach(function (f, i) {
          T({ t: t + i * 0.08, dur: 0.55, type: 'triangle', f0: f, f1: f, gain: 0.16, attack: 0.005, send: 0.5 });
          T({ t: t + i * 0.08, dur: 0.3, type: 'sine', f0: f * 2, f1: f * 2, gain: 0.05, attack: 0.005 });
        });
        N({ t: t + 0.3, dur: 0.12, gain: 0.08, type: 'highpass', f0: 5000, f1: 5000, attack: 0.002 });
      });
    },

    // the player's kick missing: a low, quick "fwoop" of a leg swung through the air with a little cloth snap (your own body: not positional)
    kickWhoosh: function () {
      play(1.3, function (t) {
        if (!gate('kickWhoosh', 0.1)) return;
        N({ t, dur: 0.26, gain: 0.5, type: 'bandpass', f0: 220, f1: 1300, q: 0.9, attack: 0.1 });
        N({ t: t + 0.1, dur: 0.18, gain: 0.2, type: 'bandpass', f0: 1500, f1: 420, q: 1.4, attack: 0.02 });
        T({ t, dur: 0.22, type: 'sine', f0: 135, f1: 70, gain: 0.18, attack: 0.08 });
      });
    },

    // the kick landing: a heavy boot into plate armour. A deep thump, a short dull crack of leather on steel and the plate rattling
    kickThud: function (pos) {
      play(1.35, function (t) {
        if (!gate('kickThud', 0.06)) return;
        T({ t, dur: 0.36, type: 'sine', f0: 120, f1: 34, gain: 1.2, attack: 0.002 });
        T({ t: t + 0.012, dur: 0.2, type: 'triangle', f0: 210, f1: 72, gain: 0.35, attack: 0.002 });
        N({ t, dur: 0.15, gain: 0.8, type: 'lowpass', f0: 1500, f1: 160, attack: 0.002 });
        N({ t, dur: 0.03, gain: 0.5, type: 'bandpass', f0: 2400, f1: 1200, q: 1, attack: 0.0005 });
        metal(t + 0.015, rnd(280, 430), 0.2, 0.32, 0.25);
      }, pos, 4);
    },

    // a knight about to charge: a short hoarse war cry (two detuned saws through a moving formant) with a rattle of plate
    rushCry: function (pos) {
      play(1.1, function (t) {
        T({ t, dur: 0.55, type: 'sawtooth', f0: 135, f1: 190, gain: 0.3, attack: 0.05, hold: 0.2, lp: [900, 1500, 1.4], send: 0.4 });
        T({ t, dur: 0.55, type: 'sawtooth', f0: 141, f1: 198, gain: 0.22, attack: 0.05, hold: 0.2, lp: [800, 1300, 1.4] });
        N({ t, dur: 0.5, gain: 0.25, type: 'bandpass', f0: 700, f1: 1200, q: 1.5, attack: 0.08 });
        metal(t + 0.1, rnd(520, 700), 0.1, 0.25, 0.2);
        metal(t + 0.22, rnd(420, 600), 0.08, 0.25, 0.2);
      }, pos, 9);
    },

    // a dagger leaving the hand: a short bright whoosh and a thin metallic shing
    throwWhoosh: function (pos) {
      play(1.4, function (t) {
        N({ t, dur: 0.3, gain: 0.55, type: 'bandpass', f0: 500, f1: 2600, q: 1.3, attack: 0.1 });
        N({ t: t + 0.1, dur: 0.25, gain: 0.2, type: 'bandpass', f0: 2400, f1: 900, q: 2, attack: 0.02 });
        T({ t, dur: 0.14, type: 'sine', f0: 3100, f1: 2500, gain: 0.05, attack: 0.002, send: 0.3 });
      }, pos);
    },

    // soft whirr of a spinning dagger in flight: a hum pulsed at the spin rate under a thin band of noise.
    // Returns { move(pos), stop() } (the sound follows the dagger and falls off with distance), or null when silent.
    whirr: function (pos, maxSeconds) {
      const c = ready();
      if (!c || !pos) return null;
      try {
        const t = c.currentTime + 0.004, life = Math.max(0.2, Number(maxSeconds) || 4);
        const pn = newPanner(c, pos.x, pos.y, pos.z);
        pn.refDistance = 2; pn.rolloffFactor = 1.6;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.3, t + 0.08);
        g.connect(pn);
        const am = c.createGain(); am.gain.value = 0.55;           // pulsed 6 x a second, like the blade coming round
        const lfo = c.createOscillator(); lfo.frequency.value = 6;
        const lfoAmt = c.createGain(); lfoAmt.gain.value = 0.45;
        lfo.connect(lfoAmt); lfoAmt.connect(am.gain);
        am.connect(g);
        const hum = c.createOscillator(); hum.type = 'triangle'; hum.frequency.value = 340;
        const humG = c.createGain(); humG.gain.value = 0.5;
        hum.connect(humG); humG.connect(am);
        const src = c.createBufferSource(); src.buffer = S.noise; src.loop = true;
        const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 2.5;
        const nG = c.createGain(); nG.gain.value = 0.8;
        src.connect(bp); bp.connect(nG); nG.connect(am);
        const end = t + life;
        [hum, lfo].forEach(function (o) { o.start(t); o.stop(end + 0.1); });
        src.start(t, Math.random() * 1.5); src.stop(end + 0.1);
        g.gain.setValueAtTime(0.3, end - 0.1); g.gain.linearRampToValueAtTime(0.0001, end);
        let stopped = false;
        return {
          move: function (p) { if (!stopped) placePanner(pn, p.x, typeof p.y === 'number' ? p.y : 1, p.z); },
          stop: function () {
            if (stopped) return;
            stopped = true;
            const now = c.currentTime;
            g.gain.cancelScheduledValues(now);
            g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
            g.gain.linearRampToValueAtTime(0.0001, now + 0.06);
          },
        };
      } catch (e) { return null; }
    },

    // a dagger lands: 'ground' = dull thud, 'clang' = metal on a tree / rock or a near miss, 'hit' = it strikes the player
    // (Player.hurt plays the pained hurt() sound on top)
    dagger: function (kind, pos) {
      play(1.4, function (t) {
        if (kind === 'hit') {
          metal(t, rnd(900, 1200), 0.3, 0.18, 0.2);
          N({ t, dur: 0.1, gain: 0.5, type: 'lowpass', f0: 1100, f1: 220, attack: 0.002 });
          T({ t, dur: 0.12, type: 'sine', f0: 140, f1: 60, gain: 0.55, attack: 0.002 });
        } else if (kind === 'clang') {
          metal(t, rnd(700, 950), 0.5, 0.55, 0.35);
          T({ t, dur: 0.08, type: 'sine', f0: 150, f1: 80, gain: 0.35, attack: 0.001 });
        } else {
          N({ t, dur: 0.12, gain: 0.45, type: 'lowpass', f0: 650, f1: 150, attack: 0.002 });
          T({ t, dur: 0.14, type: 'sine', f0: 135, f1: 55, gain: 0.6, attack: 0.002 });
          T({ t: t + 0.02, dur: 0.25, type: 'sine', f0: 1900, f1: 1850, gain: 0.025, attack: 0.001 });
        }
      }, pos);
    },

    _useContext: function (c) { S.force = true; S.last = Object.create(null); build(c); return true; },
  };

  window.Sfx = Sfx;
})();
