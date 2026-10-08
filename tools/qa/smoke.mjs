// Smoke test: boot -> no console errors -> start -> render is not black -> (needs __dbg) spawn a knight,
// aim at it, fire, assert it took damage -> no console errors at the end.
//   node tools/qa/smoke.mjs [--file=knights_out_final.html] [--query=debug=1] [--viewport=960x540] [--seed=1337|off] [--headed]
// Exit code 0 = PASS, 1 = FAIL. Checks that need __dbg are SKIPped (with a warning) when it is missing.
import fs from 'node:fs';
import { launch, parseArgs, parseViewport, parseSeed } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const results = [];
const record = (status, name, detail = '') => {
  results.push({ status, name, detail });
  console.log(`${status.padEnd(4)}  ${name}${detail ? '  - ' + detail : ''}`);
};
const pass = (n, d) => record('PASS', n, d);
const fail = (n, d) => record('FAIL', n, d);
const skip = (n, d) => record('SKIP', n, d);
const check = (ok, n, d) => (ok ? pass(n, d) : fail(n, d));

const hardTimeout = setTimeout(() => { console.error('FAIL  smoke timed out after 150 s'); process.exit(1); }, 150000);

const s = await launch({
  scenario: 'smoke',
  file: args.file || 'knights_out_final.html',
  query: args.query === undefined ? 'debug=1' : args.query === true ? '' : args.query,
  viewport: parseViewport(args.viewport, { width: 960, height: 540 }),
  headless: !args.headed,
  seed: parseSeed(args.seed),
});
const { page, h, errors } = s;
console.log(`smoke: ${s.url}`);

try {
  // ---- 1. boot
  try {
    await h.boot();
    pass('boot', 'THREE + Game ready, start button enabled');
  } catch (e) {
    fail('boot', e.message.split('\n')[0]);
    e.recorded = true;
    throw e;
  }
  const info = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
    return { hasCanvas: !!c, glLost: gl ? gl.isContextLost() : null, three: window.THREE && THREE.REVISION,
      startBtn: !!document.getElementById('startBtn'), dbg: !!window.__dbg };
  });
  check(info.hasCanvas && info.glLost === false, 'webgl-canvas', `three r${info.three}`);
  check(errors.length === 0, 'no-errors-on-boot', errors.slice(0, 2).join(' | '));

  // ---- 2. start
  const st = await h.start();
  const started = await page.evaluate(() => window.__gameStarted === true || getComputedStyle(document.getElementById('lock')).display === 'none');
  check(started, 'start-click', `menu hidden, pointerLock=${st.pointerLocked}${st.pointerLocked ? '' : ' (not granted; tolerated)'}`);

  // ---- 3. enemies spawn
  let alive = 0;
  try {
    await h.waitFor(() => window.Enemies && Enemies.list && Enemies.list.length > 0, null, 20000);
    alive = (await h.enemies()).length;
    pass('wave-spawns-enemies', `${alive} enemy(ies) in list`);
  } catch {
    fail('wave-spawns-enemies', 'Enemies.list stayed empty for 20 s after start');
  }

  // ---- 4. render is not black
  await h.frames(5);
  const file = await h.shot();
  const stats = await h.imageStats(fs.readFileSync(file));
  check(stats.meanLum > 12 && stats.litFraction > 0.25 && stats.colors > 8, 'renders-not-black',
    `meanLum=${stats.meanLum.toFixed(0)} lit=${(stats.litFraction * 100).toFixed(0)}% colors=${stats.colors}  (${file})`);

  // ---- 5. spawn -> aim -> fire -> damage
  const hasDbg = await h.hasDbg();
  if (!hasDbg) h.warn('window.__dbg missing (is the page loaded with ?debug=1 and built by the new tools/build.mjs?): using fallback aim at the nearest existing enemy');
  await h.pause(); // freezes game time so nothing moves between aim and shot
  let target = null;
  if (hasDbg) {
    await h.godMode(true);
    await h.clean();
    target = await h.spawn('knight', 4, 0);
    if (!target) fail('spawn-knight', '__dbg.spawn did not produce a live enemy in Enemies.list');
    else pass('spawn-knight', `at ${target.dist.toFixed(1)} m  hp=${target.hp}`);
  } else {
    const p = await h.player();
    const list = (await h.enemies()).filter((e) => !e.dead);
    list.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    target = list[0] ? { ...list[0], dist: Math.hypot(list[0].x - p.x, list[0].z - p.z) } : null;
    if (target) skip('spawn-knight', '__dbg missing; targeting nearest wave enemy instead');
    else skip('spawn-knight', '__dbg missing and no enemy alive');
  }
  if (target) {
    await h.mark(target);
    await h.aimAt(target, 1.2);
    const before = await h.marked();
    const f = await h.fire();
    await h.advance(120);
    const after = await h.marked();
    check(f.fired, 'fire', `via ${f.method}`);
    const damaged = after && before && (after.dead || !after.inList || (after.hp !== undefined && after.hp < before.hp));
    check(!!damaged, 'target-takes-damage', `hp ${before && before.hp} -> ${after && after.hp}, dead=${after && after.dead}, inList=${after && after.inList}`);
    await h.shot('after-fire');
  } else if (hasDbg) {
    fail('fire', 'no target');
  } else {
    skip('fire', 'no target');
  }
  await h.resume();

  if (hasDbg) {
    const stt = await h.state();
    if (stt === undefined || stt === null) fail('dbg-state', '__dbg.state() returned nothing');
    else pass('dbg-state', JSON.stringify(stt).slice(0, 160));
  } else {
    skip('dbg-state', '__dbg missing');
  }

  // ---- 6. no errors at all during the run
  await h.wait(300);
  check(errors.length === 0, 'no-console-errors', errors.length ? `${errors.length}: ${errors.slice(0, 3).join(' | ').slice(0, 400)}` : 'clean');
} catch (e) {
  if (!e.recorded) fail('harness', e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  if (errors.length) console.log('page errors so far:\n  ' + errors.slice(0, 8).join('\n  '));
} finally {
  const warns = [...new Set(s.warnings)];
  if (warns.length) { console.log(`\n${warns.length} warning(s):`); warns.slice(0, 8).forEach((w) => console.log('  - ' + w.slice(0, 220))); }
  await s.close();
  clearTimeout(hardTimeout);
}

const nFail = results.filter((r) => r.status === 'FAIL').length;
const nPass = results.filter((r) => r.status === 'PASS').length;
const nSkip = results.filter((r) => r.status === 'SKIP').length;
console.log(`\nSMOKE ${nFail ? 'FAIL' : 'PASS'}  (${nPass} passed, ${nFail} failed, ${nSkip} skipped)`);
process.exit(nFail ? 1 : 0);
