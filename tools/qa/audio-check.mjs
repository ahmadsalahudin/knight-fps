// Audio check: headless Chromium cannot be listened to, so every sound is rendered offline instead.
//   node tools/qa/audio-check.mjs [--file=knights_out_final.html]            (npm run audio)
// Each Sfx sound is rendered into an OfflineAudioContext (via Sfx._useContext) and measured: it must not be silent (peak above
// 0.005) and must stay below 1.0 (the master chain soft-clips at ~0.72). Extra checks: a pile-up of 60 overlapping sounds does not
// clip, a far sound is quieter than a near one, a sound to the right is louder in the right ear (HRTF), mute silences everything,
// the ambience is quiet but present, and Sfx never throws without an AudioContext. Prints a table; exit code 1 on any failure.
// This proves the sounds are present and bounded. It says nothing about how they SOUND: that needs ears.
import { launch, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const s = await launch({
  scenario: 'audio',
  file: args.file || 'knights_out_final.html',
  query: '',
  virtualClock: false,
  seed: null,
});
const { page, h, errors } = s;
let failed = 0;
const row = (ok, name, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`); };

try {
  await h.boot();
  await page.waitForFunction(() => !!window.Sfx && !!window.Sfx._useContext, null, { timeout: 30000 });

  const SR = 44100;
  const results = await page.evaluate(async (SR) => {
    const R = { sounds: [], extra: {} };
    const near = { x: 3, y: 1.2, z: -4 }, right = { x: 8, y: 1, z: 0 }, left = { x: -8, y: 1, z: 0 }, far = { x: 0, y: 1, z: -45 };

    // render `fn(Sfx)` for `sec` seconds into a fresh offline context; returns { peak, rms, rmsL, rmsR, nan }
    async function render(fn, sec) {
      const oc = new OfflineAudioContext(2, Math.ceil(SR * sec), SR);
      Sfx._useContext(oc);
      fn(Sfx);
      const buf = await oc.startRendering();
      const L = buf.getChannelData(0), Rr = buf.getChannelData(1);
      let peak = 0, sl = 0, sr = 0, nan = false;
      for (let i = 0; i < L.length; i++) {
        const a = L[i], b = Rr[i];
        if (a !== a || b !== b) { nan = true; continue; }
        peak = Math.max(peak, Math.abs(a), Math.abs(b));
        sl += a * a; sr += b * b;
      }
      const n = L.length;
      return { peak, rms: Math.sqrt((sl + sr) / (2 * n)), rmsL: Math.sqrt(sl / n), rmsR: Math.sqrt(sr / n), nan };
    }

    const list = [
      ['shoot', (S) => S.shoot(), 1.4],
      ['dryFire', (S) => S.dryFire(), 0.5],
      ['reload', (S) => S.reload(), 2.0],
      ['cock', (S) => S.cock(), 0.6],
      ['swing (knight, positional)', (S) => S.swing(false, near), 0.8],
      ['swing (heavy, positional)', (S) => S.swing(true, near), 1.0],
      ['clang (positional)', (S) => S.clang(near), 1.4],
      ['armorHit  = clank', (S) => S.armorHit(near), 0.6],
      ['headshot  = ping', (S) => S.headshot(near), 1.0],
      ['fleshHit', (S) => S.fleshHit(near), 0.5],
      ['hurt (player)', (S) => S.hurt(), 0.8],
      ['kill  = crunch + fall', (S) => S.kill(near), 1.4],
      ['bossRoar (positional)', (S) => S.bossRoar({ x: 0, y: 3, z: -12 }), 2.6],
      ['footstep (player)', (S) => S.footstep(), 0.4],
      ['footstep (player, sprint)', (S) => S.footstep(true), 0.4],
      ['footstep (knight, 6 m)', (S) => S.footstep('knight', { x: 4, y: 0.1, z: -5 }), 0.6],
      ['footstep (boss, 12 m)', (S) => S.footstep('boss', { x: 0, y: 0.1, z: -12 }), 0.6],
      ['throwWhoosh (positional)', (S) => S.throwWhoosh(near), 0.8],
      ['whirr (in flight, 0.8 s)', (S) => { S.whirr(near, 0.8); }, 1.0],
      ['dagger: ground thud', (S) => S.dagger('ground', near), 0.6],
      ['dagger: near-miss clang', (S) => S.dagger('clang', near), 1.2],
      ['dagger: hit', (S) => S.dagger('hit', near), 0.6],
      ['bird', (S) => S.bird({ x: 10, y: 7, z: -15 }), 1.0],
      ['Sfx.at(pos).clang()', (S) => S.at(right).clang(), 1.4],
      ['waveStart', (S) => S.waveStart(), 1.8],
      ['victory', (S) => S.victory(), 4.0],
      ['ambient (3 s of wind)', (S) => S.ambient(true), 3.0],
    ];
    for (const [name, fn, sec] of list) {
      try { R.sounds.push(Object.assign({ name }, await render(fn, sec))); } catch (e) { R.sounds.push({ name, error: String(e) }); }
    }

    // pile-up: 60 sounds in one second, loud ones included
    R.extra.pileup = await render((S) => {
      const mix = [() => S.shoot(), () => S.kill(near), () => S.clang(right), () => S.armorHit(left), () => S.headshot(near),
        () => S.bossRoar(near), () => S.footstep('boss', near), () => S.hurt(), () => S.dagger('clang', near)];
      for (let i = 0; i < 60; i++) mix[i % mix.length]();
    }, 3.0);

    // distance falloff and stereo placement
    const nearR = await render((S) => S.clang(near), 1.4);
    const farR = await render((S) => S.clang(far), 1.4);
    R.extra.falloff = { near: nearR.rms, far: farR.rms };
    const rightR = await render((S) => S.clang(right), 1.4);
    const leftR = await render((S) => S.clang(left), 1.4);
    R.extra.pan = { right: [rightR.rmsL, rightR.rmsR], left: [leftR.rmsL, leftR.rmsR] };

    // volume slider and mute
    Sfx.volume(0.4); Sfx.mute(true);
    R.extra.muted = await render((S) => { S.shoot(); S.kill(near); S.ambient(true); }, 1.0);
    Sfx.mute(false);
    R.extra.vol40 = await render((S) => S.shoot(), 1.0);
    Sfx.volume(1);
    R.extra.vol100 = await render((S) => S.shoot(), 1.0);
    Sfx.volume(0.8);
    R.extra.stored = localStorage.getItem('kf_volume');

    // two shots must differ (pitch / level variation)
    const a = await render((S) => S.shoot(), 0.6), b = await render((S) => S.shoot(), 0.6);
    R.extra.shotVariation = Math.abs(a.rms - b.rms) / Math.max(a.rms, b.rms);
    return R;
  }, SR);

  for (const r of results.sounds) {
    if (r.error) { row(false, r.name, 'threw: ' + r.error); continue; }
    const ok = r.peak > 0.005 && r.peak < 1 && !r.nan;
    row(ok, r.name, `peak ${r.peak.toFixed(3)}  rms ${r.rms.toFixed(4)}${r.peak <= 0.005 ? '  SILENT' : r.peak >= 1 ? '  CLIPS' : ''}`);
  }
  const E = results.extra;
  row(E.pileup.peak < 1 && E.pileup.peak > 0.05 && !E.pileup.nan, '60 overlapping sounds', `peak ${E.pileup.peak.toFixed(3)} (must stay below 1.0)`);
  row(E.falloff.far < E.falloff.near * 0.5, 'distance falloff (45 m vs 5 m)', `rms ${E.falloff.far.toFixed(4)} vs ${E.falloff.near.toFixed(4)}`);
  row(E.pan.right[1] > E.pan.right[0] * 1.3 && E.pan.left[0] > E.pan.left[1] * 1.3, 'HRTF left / right placement',
    `source right: L ${E.pan.right[0].toFixed(4)} R ${E.pan.right[1].toFixed(4)}; source left: L ${E.pan.left[0].toFixed(4)} R ${E.pan.left[1].toFixed(4)}`);
  row(E.muted.peak < 1e-4, 'mute silences everything', `peak ${E.muted.peak.toExponential(1)}`);
  row(E.vol40.rms < E.vol100.rms * 0.6 && E.vol40.rms > 0, 'volume slider scales the output', `rms at 40 %: ${E.vol40.rms.toFixed(4)}, at 100 %: ${E.vol100.rms.toFixed(4)}`);
  row(E.stored === '80', 'volume remembered in localStorage', `kf_volume = ${E.stored}`);
  row(E.shotVariation > 0.01, 'revolver shots vary shot to shot', `rms differs by ${(E.shotVariation * 100).toFixed(1)} %`);
  const amb = results.sounds.find((r) => r.name.startsWith('ambient'));
  row(amb && amb.rms > 0.002 && amb.rms < 0.08, 'ambience is quiet but present', amb ? `rms ${amb.rms.toFixed(4)}` : 'missing');

  // never throws without a usable AudioContext (fresh page, AudioContext removed)
  const s2 = await launch({ scenario: 'audio-none', file: args.file || 'knights_out_final.html', query: '', virtualClock: false, seed: null });
  await s2.page.context().addInitScript(() => { delete window.AudioContext; delete window.webkitAudioContext; });
  await s2.h.boot();
  const p2 = s2.page, errs2 = s2.errors;
  const noAudio = await p2.evaluate(() => {
    const out = [];
    for (const k of Object.keys(Sfx)) {
      if (k[0] === '_' || typeof Sfx[k] !== 'function') continue;
      try { Sfx[k]({ x: 1, y: 1, z: 1 }); } catch (e) { out.push(k + ': ' + e.message); }
    }
    try { Sfx.at({ x: 0, y: 0, z: 0 }).clang(); Sfx.update(0.016, null); Sfx.mute(); Sfx.mute(); } catch (e) { out.push('misc: ' + e.message); }
    return out;
  });
  row(noAudio.length === 0 && errs2.length === 0, 'no AudioContext: nothing throws', noAudio.concat(errs2).join('; ') || 'all calls are silent no-ops');
  await s2.close();

  row(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  failed++;
  console.log('FAIL  harness: ' + (e.stack || e));
} finally {
  await s.close();
}
console.log(`\nAUDIO CHECK ${failed ? 'FAIL' : 'PASS'}  (${failed} failure(s)). Rendered offline, NOT listened to.`);
process.exit(failed ? 1 : 0);
