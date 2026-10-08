// Mobile device matrix: the built game in emulated iPhone / Android / iPad profiles (screen size, pixel ratio, user agent, mobile viewport,
// touch screen), started the way a player does it (a real touch on START, no ?touch=1).
//   node tools/qa/mobile-check.mjs [--file=knights_out_final.html] [--only=iphone13]            (npm run mobile)
// Per device: touch mode is on; the page is as wide as the device; every on-screen control is inside the screen, at least 44 px, and
// overlaps neither another control nor the HUD (boss bar included); stick + FIRE work; the frame is not black; no console errors.
// Also: on a slow device the render resolution steps down by itself (adaptive resolution), and the portrait "turn your device" screen.
// LIMITS: this is Chromium emulating phones. It cannot run Safari / WebKit, a real GPU, a notch (safe-area insets) or the iOS silent switch,
// so it proves layout, input and logic on those screen sizes, not iPhone Safari itself. Test on real devices as well.
import { launch, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const file = args.file || 'knights_out_final.html';
const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_AND = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_AND_LOW = 'Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Mobile Safari/537.36';
const DEVICES = [
  { id: 'iphone13', name: 'iPhone 13 (landscape)', w: 844, h: 390, dpr: 3, ua: UA_IOS },
  { id: 'iphonese', name: 'iPhone SE (landscape)', w: 667, h: 375, dpr: 2, ua: UA_IOS },
  { id: 'iphone15pm', name: 'iPhone 15 Pro Max (landscape)', w: 932, h: 430, dpr: 3, ua: UA_IOS },
  { id: 'pixel7', name: 'Pixel 7 (landscape)', w: 915, h: 412, dpr: 2.625, ua: UA_AND },
  { id: 'galaxys9', name: 'Galaxy S9 (landscape)', w: 740, h: 360, dpr: 4, ua: UA_AND_LOW },
  { id: 'lowend', name: 'Low-end Android 640x360', w: 640, h: 360, dpr: 2, ua: UA_AND_LOW },
  { id: 'ipad', name: 'iPad mini (landscape)', w: 1024, h: 768, dpr: 2, ua: UA_IPAD },
];
let failed = 0;
const row = (ok, name, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${detail}`); };
const overlap = (a, b, tol = 1) => a.x < b.x + b.w - tol && b.x < a.x + a.w - tol && a.y < b.y + b.h - tol && b.y < a.y + a.h - tol;

function ctxFor(d) { return { userAgent: d.ua, isMobile: true, hasTouch: true, deviceScaleFactor: d.dpr }; }

async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const down = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...down].map(([id, p]) => ({ id, x: p.x, y: p.y })) });
  return {
    async down(id, x, y) { down.set(id, { x, y }); await send('touchStart'); },
    async move(id, x, y) { down.set(id, { x, y }); await send('touchMove'); },
    async up(id) { down.delete(id); await send('touchEnd'); },
    async tap(x, y) { down.set(99, { x, y }); await send('touchStart'); down.delete(99); await send('touchEnd'); },
  };
}
const rectOf = (page, sel) => page.evaluate((q) => {
  const el = document.querySelector(q);
  if (!el) return null;
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  return cs.display === 'none' || cs.visibility === 'hidden' ? null : { x: r.x, y: r.y, w: r.width, h: r.height };
}, sel);

for (const d of DEVICES) {
  if (args.only && args.only !== d.id) continue;
  console.log(`\n${d.name}  ${d.w}x${d.h} @${d.dpr}x`);
  const s = await launch({ scenario: 'mobile-' + d.id, file, query: 'debug=1', viewport: { width: d.w, height: d.h }, contextOptions: ctxFor(d) });
  const { page, h, errors } = s;
  try {
    await h.boot();
    const pre = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, coarse: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(hover: none)').matches, touch: TouchInput.active, ua: navigator.userAgent.slice(0, 40) }));
    row(pre.w === d.w && pre.h === d.h, 'page is as wide as the device (mobile viewport)', `${pre.w}x${pre.h} dpr ${pre.dpr}`);
    row(pre.touch, 'touch mode auto-detected at load (coarse pointer)', `pointer:coarse ${pre.coarse}, hover:none ${pre.hover}`);
    const f = await fingers(page);
    const sb = await rectOf(page, '#startBtn');
    row(sb && sb.w >= 44 && sb.h >= 36, 'START is a comfortable touch target', sb ? `${Math.round(sb.w)}x${Math.round(sb.h)} px` : 'missing');
    const lockOk = await page.evaluate(() => { const l = document.getElementById('lock'); return l.scrollHeight <= l.clientHeight + 1; });
    row(true, 'title screen' + (lockOk ? ' fits without scrolling' : ' scrolls (allowed)'), '');
    await f.tap(sb.x + sb.w / 2, sb.y + sb.h / 2);
    await page.waitForFunction(() => window.__gameStarted === true, null, { timeout: 15000 });
    await h.frames(3);
    await h.clean(); await h.godMode(true); await h.resetView(); await h.pause();
    await h.advance(300, 33);
    const touchNow = await page.evaluate(() => TouchInput.active);
    row(touchNow, 'touch mode on after a touch START', '');

    // ---- layout: controls vs screen vs each other vs HUD (boss bar shown for the check)
    await page.evaluate(() => { HUD.bossBar(true, 0.6, 'The Iron Warlord'); __dbg.grenade.give(4); Grenade.streak = 3; Grenade._streakT = 6; Grenade._hud(); });
    await page.evaluate(() => { const m = document.getElementById('muteHint'); m.classList.remove('hidden'); });
    await h.advance(100, 33);
    const controls = ['#tFire', '#tReload', '#tSprint', '#tGrenade', '#tPause', '#tMute', '#stickBase'];
    const hud = ['#hpBox', '#killBox', '#ammoBox', '#waveInfo', '#bossBar', '#muteHint', '#streakBox'];
    const C = {}, H = {};
    for (const c of controls) C[c] = await rectOf(page, c);
    for (const x of hud) H[x] = await rectOf(page, x);
    const inside = (r) => r && r.x >= -1 && r.y >= -1 && r.x + r.w <= d.w + 1 && r.y + r.h <= d.h + 1;
    const bad = [];
    for (const [k, r] of Object.entries(C)) if (!inside(r)) bad.push(k + ' off screen');
    for (const [k, r] of Object.entries(H)) if (r && !inside(r)) bad.push(k + ' off screen');
    row(bad.length === 0, 'every control and HUD element is on the screen', bad.join(', ') || 'ok');
    const small = ['#tFire', '#tReload', '#tSprint', '#tGrenade', '#tPause', '#tMute'].filter((k) => !C[k] || Math.min(C[k].w, C[k].h) < 43.5).map((k) => k + ' ' + (C[k] ? Math.round(Math.min(C[k].w, C[k].h)) : '?') + 'px');
    row(small.length === 0, 'touch targets are at least 44 px', small.join(', ') || 'ok');
    const clash = [];
    const ck = Object.keys(C);
    for (let i = 0; i < ck.length; i++) {
      for (let j = i + 1; j < ck.length; j++) if (C[ck[i]] && C[ck[j]] && overlap(C[ck[i]], C[ck[j]])) clash.push(ck[i] + ' x ' + ck[j]);
      for (const hk of Object.keys(H)) if (C[ck[i]] && H[hk] && overlap(C[ck[i]], H[hk])) clash.push(ck[i] + ' x ' + hk);
    }
    row(clash.length === 0, 'no control overlaps another control or the HUD', clash.join(', ') || 'ok');
    await page.evaluate(() => { HUD.bossBar(false); Grenade.reset(); });
    if (d.id === 'iphone13' || d.id === 'lowend') await h.shot('hud-' + d.id);

    // ---- stick + FIRE
    const p0 = await page.evaluate(() => ({ z: Game.playerObj.position.z, ammo: Game.ammo }));
    await f.down(1, d.w * 0.14, d.h * 0.72);
    await f.move(1, d.w * 0.14, d.h * 0.72 - 70);
    await h.advance(500, 33);
    await f.up(1);
    const fr = C['#tFire'];
    await f.tap(fr.x + fr.w / 2, fr.y + fr.h / 2);
    await h.advance(200, 33);
    const p1 = await page.evaluate(() => ({ z: Game.playerObj.position.z, ammo: Game.ammo, focus: document.hasFocus() }));
    row(p1.z < p0.z - 0.5 && p1.ammo === p0.ammo - 1, 'stick walks the player, FIRE shoots', `z ${p0.z.toFixed(1)} -> ${p1.z.toFixed(1)}, ammo ${p0.ammo} -> ${p1.ammo}`);
    const stats = await h.imageStats(await page.screenshot());
    row(stats.meanLum > 12 && stats.litFraction > 0.25 && stats.colors > 8, 'the frame is rendered (not black)', `meanLum ${stats.meanLum.toFixed(0)} lit ${(stats.litFraction * 100).toFixed(0)}%`);
    row(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
  } catch (e) {
    failed++;
    console.log('  FAIL  harness: ' + (e.stack || e).toString().split('\n').slice(0, 3).join(' | '));
  } finally { await s.close(); }
}

// ---- portrait phone: "turn your device" screen, then the game is paused
if (!args.only) {
  const d = DEVICES[0];
  console.log('\niPhone 13 portrait + adaptive resolution');
  const s = await launch({ scenario: 'mobile-portrait', file, query: 'debug=1', viewport: { width: d.h, height: d.w }, contextOptions: ctxFor(d) });
  try {
    await s.h.boot();
    const f = await fingers(s.page);
    const sb = await rectOf(s.page, '#startBtn');
    row(!!sb && sb.x >= 0 && sb.x + sb.w <= d.h, 'portrait title screen fits the width', sb ? `START at ${Math.round(sb.x)}..${Math.round(sb.x + sb.w)} of ${d.h}` : 'missing');
    await f.tap(sb.x + sb.w / 2, sb.y + sb.h / 2);
    await s.page.waitForFunction(() => window.__gameStarted === true, null, { timeout: 15000 });
    await s.h.frames(3);
    const r = await s.page.evaluate(() => ({ rotate: getComputedStyle(document.getElementById('rotateHint')).display }));
    row(r.rotate === 'flex', 'portrait while playing: "turn your device" screen', JSON.stringify(r));
  } catch (e) { failed++; console.log('  FAIL  harness: ' + String(e.stack || e).split('\n').slice(0, 3).join(' | ')); } finally { await s.close(); }

  // adaptive resolution: no ?debug=1, real clock; headless software rendering is slow, so the ratio must step down by itself
  const a = await launch({ scenario: 'mobile-adaptive', file, query: '', viewport: { width: d.w, height: d.h }, virtualClock: false, seed: null, contextOptions: ctxFor(d) });
  try {
    await a.h.boot();
    const f = await fingers(a.page);
    const r0 = await a.page.evaluate(() => ({ touch: TouchInput.active, ratio: Main.pixelRatio(), dpr: devicePixelRatio, debug: !!window.__dbg }));
    row(r0.touch && !r0.debug && Math.abs(r0.ratio - Math.min(r0.dpr, 1.75)) < 0.01, 'touch device starts at a capped pixel ratio', `ratio ${r0.ratio} (device ${r0.dpr}x, cap 1.75)`);
    const sb = await rectOf(a.page, '#startBtn');
    await f.tap(sb.x + sb.w / 2, sb.y + sb.h / 2);
    await a.page.waitForFunction(() => window.__gameStarted === true, null, { timeout: 15000 });
    let r1 = r0.ratio;
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      r1 = await a.page.evaluate(() => Main.pixelRatio());
      if (r1 < r0.ratio - 0.05) break;
      await a.page.waitForTimeout(2000);
    }
    row(r1 < r0.ratio - 0.05, 'slow device: resolution steps down by itself', `ratio ${r0.ratio} -> ${r1.toFixed(2)} after ${Math.round((Date.now() - t0) / 1000)} s`);
    const st = await a.h.imageStats(await a.page.screenshot());
    row(st.meanLum > 12 && st.litFraction > 0.25, 'still rendering after the step down', `meanLum ${st.meanLum.toFixed(0)}`);
    row(a.errors.length === 0, 'no console errors', a.errors.slice(0, 2).join(' | '));
  } catch (e) { failed++; console.log('  FAIL  harness: ' + String(e.stack || e).split('\n').slice(0, 3).join(' | ')); } finally { await a.close(); }
}

console.log(`\nMOBILE CHECK ${failed ? 'FAIL' : 'PASS'}  (${failed} failure(s)). Emulated in Chromium: not run on real iPhones / Android phones.`);
process.exit(failed ? 1 : 0);
