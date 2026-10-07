/* sfx.js - window.Sfx (B4 rewrite): procedural WebAudio sounds, no audio files.

   Graph:  voices -> master gain -> compressor -> destination      (plus a convolution "reverb" send for tails)
   - one shared noise buffer, one generated impulse response: nothing is allocated per sound except the nodes
   - the AudioContext is created lazily on the first user gesture (pointerdown/keydown), or on the first Sfx call
   - every entry point is a silent no-op when WebAudio is missing or the context is not running (autoplay policy),
     and never throws. All timing uses the audio clock (no setTimeout), so sequences like reload() are exact.

   API (docs/FIX_PLAN.md "HUD and Sfx"):
     shoot, dryFire, reload, cock, swing(heavy?), clang, armorHit, fleshHit, hurt, death, bossRoar,
     footstep(kind?), waveStart, victory
   Extras: init() (call from a gesture), volume(v), mute(on), plus the legacy aliases hit -> armorHit, roar -> bossRoar.
   Test hook: Sfx._useContext(ctx) swaps in e.g. an OfflineAudioContext so a sound can be rendered and measured. */
(function () {
  'use strict';

  const Ctor = window.AudioContext || window.webkitAudioContext;
  const S = {
    c: null,            // AudioContext
    out: null,          // master gain
    verb: null,         // reverb send bus
    noise: null,        // shared white-noise AudioBuffer
    vol: 0.8,
    muted: false,
    force: false,       // test hook: play even though ctx.state !== 'running' (OfflineAudioContext)
    trim: 1,            // per-sound level trim, applied by envelope() while a sound is being built
    last: Object.create(null),
  };
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- context
  function build(c) {
    S.c = c;
    S.out = c.createGain();
    S.out.gain.value = S.muted ? 0 : S.vol;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 24; comp.ratio.value = 5;
    comp.attack.value = 0.003; comp.release.value = 0.2;
    S.out.connect(comp); comp.connect(c.destination);

    // shared noise (2 s, looped by every noise voice)
    const n = Math.floor(c.sampleRate * 2);
    S.noise = c.createBuffer(1, n, c.sampleRate);
    const d = S.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    // reverb: decaying stereo noise impulse, darkened on the way in
    const len = Math.floor(c.sampleRate * 1.3);
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
  ['pointerdown', 'mousedown', 'keydown', 'touchstart'].forEach((ev) => {
    try { document.addEventListener(ev, unlock, { capture: true, passive: true }); } catch (e) { /* ignore */ }
  });

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
    g.connect(S.out);
    if (o.send) { const s = c.createGain(); s.gain.value = o.send; g.connect(s); s.connect(S.verb); }
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

  // run fn(t0, c) when the context is running; swallow any error so game code is never affected
  function play(trim, fn) {
    const c = ready();
    if (!c) return;
    S.trim = trim;
    try { fn(c.currentTime + 0.004, c); } catch (e) { /* audio must never break the game */ }
    S.trim = 1;
  }

  // ---------------------------------------------------------------- the sounds
  const Sfx = {
    init: function () { unlock(); return !!ctx(); },

    volume: function (v) {
      S.vol = Math.max(0, Math.min(1, Number(v)));
      if (S.out && !S.muted) S.out.gain.value = S.vol;
    },
    mute: function (on) {
      S.muted = on === undefined ? !S.muted : !!on;
      if (S.out) S.out.gain.value = S.muted ? 0 : S.vol;
      return S.muted;
    },

    // revolver: bright crack + noise body + low thump + long tail with slap-back
    shoot: function () {
      play(1.5, function (t) {
        const k = rnd(0.94, 1.06);
        N({ t, dur: 0.05, gain: 1.3, type: 'highpass', f0: 1800, f1: 1200, attack: 0.0008 });
        N({ t, dur: 0.17, gain: 0.8, type: 'bandpass', f0: 2600, f1: 330, q: 0.9, attack: 0.001 });
        T({ t, dur: 0.2, type: 'sine', f0: 175 * k, f1: 46, gain: 1.3, attack: 0.002 });
        T({ t, dur: 0.08, type: 'triangle', f0: 430 * k, f1: 105, gain: 0.5, attack: 0.001 });
        N({ t: t + 0.015, dur: 0.7, gain: 0.45, type: 'lowpass', f0: 2800, f1: 240, attack: 0.012, send: 0.9 });
        N({ t: t + 0.13, dur: 0.35, gain: 0.16, type: 'bandpass', f0: 1300, f1: 300, q: 0.6, attack: 0.006, send: 0.7 });
      });
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
    swing: function (heavy) {
      play(1.8, function (t) {
        const dur = heavy ? 0.58 : 0.34;
        N({ t, dur, gain: 0.5, type: 'bandpass', f0: heavy ? 240 : 480, f1: heavy ? 1100 : 2200, q: 1.1, attack: dur * 0.45 });
        N({ t: t + dur * 0.35, dur: dur * 0.65, gain: 0.25, type: 'bandpass', f0: heavy ? 900 : 1800, f1: heavy ? 200 : 480, q: 1.5, attack: 0.02 });
        if (heavy) T({ t, dur: dur, type: 'sine', f0: 90, f1: 55, gain: 0.2, attack: dur * 0.4 });
      });
    },

    // blade on armour or shield
    clang: function () {
      play(1.5, function (t) {
        if (!gate('clang', 0.05)) return;
        metal(t, rnd(360, 540), 0.62, 0.7, 0.4);
        T({ t, dur: 0.07, type: 'sine', f0: 150, f1: 90, gain: 0.3, attack: 0.001 });
      });
    },

    // bullet on a steel plate: sharp tink + dull thud
    armorHit: function () {
      play(1.3, function (t) {
        if (!gate('armor', 0.03)) return;
        const base = rnd(900, 1250);
        N({ t, dur: 0.03, gain: 0.6, type: 'highpass', f0: 3000, f1: 3000, attack: 0.0005 });
        [[1, 0.36, 0.15], [2.4, 0.25, 0.1], [4.1, 0.14, 0.07]].forEach(function (p) {
          T({ t, dur: p[2], type: 'sine', f0: base * p[0], f1: base * p[0] * 0.99, gain: p[1], attack: 0.0007, send: 0.25 });
        });
        T({ t, dur: 0.09, type: 'sine', f0: 140, f1: 80, gain: 0.35, attack: 0.001 });
      });
    },

    // wet thud
    fleshHit: function () {
      play(1.7, function (t) {
        if (!gate('flesh', 0.03)) return;
        N({ t, dur: 0.11, gain: 0.7, type: 'lowpass', f0: 950, f1: 200, attack: 0.002 });
        T({ t, dur: 0.15, type: 'sine', f0: 125, f1: 52, gain: 0.7, attack: 0.002 });
        N({ t: t + 0.01, dur: 0.07, gain: 0.25, type: 'bandpass', f0: 650, f1: 250, q: 2, attack: 0.004 });
      });
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

    // an enemy goes down: groan, armour clatter, body fall
    death: function () {
      play(0.6, function (t) {
        if (!gate('death', 0.1)) return;
        T({ t, dur: 0.55, type: 'sawtooth', f0: 170, f1: 62, gain: 0.16, attack: 0.03, lp: [700, 220, 1.2] });
        [[0.05, 0.16], [0.16, 0.13], [0.3, 0.1], [0.47, 0.07]].forEach(function (p) {
          metal(t + p[0], rnd(300, 620), p[1], 0.35, 0.25);
        });
        T({ t: t + 0.34, dur: 0.34, type: 'sine', f0: 100, f1: 38, gain: 0.85, attack: 0.004 });
        N({ t: t + 0.34, dur: 0.4, gain: 0.35, type: 'lowpass', f0: 700, f1: 150, attack: 0.004 });
      });
    },

    // ~1.9 s: sub boom + distorted vibrato growl + amplitude-modulated noise
    bossRoar: function () {
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
      });
    },

    // kind: undefined = walking player; true / 'run' = sprinting player (game.js passes Game.sprinting);
    //       'knight' = armoured knight (adds a plate rattle); 'heavy' / 'boss' = the boss's stomp.
    footstep: function (kind) {
      play(1.7, function (t) {
        const heavy = kind === 'heavy' || kind === 'boss';
        const armor = heavy || kind === 'knight';
        const run = kind === true || kind === 'run';
        if (!gate('step' + (heavy ? 'H' : armor ? 'K' : 'P'), heavy ? 0.12 : 0.07)) return;
        const k = rnd(0.9, 1.12);
        const lvl = heavy ? 1.3 : armor ? 1.0 : run ? 1.25 : 1.0;
        N({ t, dur: heavy ? 0.14 : 0.09, gain: 0.8 * lvl, type: 'lowpass', f0: (heavy ? 330 : 420) * k, f1: 110, attack: 0.002 });
        T({ t, dur: heavy ? 0.18 : 0.09, type: 'sine', f0: (heavy ? 70 : 88) * k, f1: 42, gain: (heavy ? 0.75 : 0.5) * lvl, attack: 0.002 });
        if (armor) N({ t, dur: heavy ? 0.07 : 0.05, gain: heavy ? 0.2 : 0.12, type: 'highpass', f0: 3800, f1: 3800, attack: 0.0008 });   // plate rattle
      });
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

    _useContext: function (c) { S.force = true; S.last = Object.create(null); build(c); return true; },
  };

  Sfx.hit = Sfx.armorHit;     // legacy names
  Sfx.roar = Sfx.bossRoar;

  window.Sfx = Sfx;
})();
