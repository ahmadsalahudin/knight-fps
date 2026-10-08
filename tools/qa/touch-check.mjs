// Touch check: drives the on-screen controls with real multi-touch input (CDP Input.dispatchTouchEvent -> pointer events with
// pointerType "touch", exactly what a phone produces) in an 844x390 landscape viewport.
//   node tools/qa/touch-check.mjs [--file=knights_out_final.html]            (npm run touch)
// Checks: touch mode shows the touch help and hides the keyboard help; START by tap; the floating stick moves the player (analog speed,
// edge = sprint, release stops); dragging aims (yaw / clamped pitch); FIRE shoots and aims while held; RELOAD; SPRINT latch; pause + tap to
// resume; mute; stick + look + fire at the same time; a desktop (no touch) session shows no touch UI; zero console errors.
// Screenshots: tools/qa/out/touch-title.png, touch-hud.png, touch-active.png (LOOK at them; a pass only proves nothing broke).
import { launch, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const file = args.file || 'knights_out_final.html';
let failed = 0;
const row = (ok, name, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`); };

const s = await launch({ scenario: 'touch', file, query: 'debug=1&touch=1', viewport: { width: 844, height: 390 } });
const { page, h, errors } = s;
try {
  await h.boot();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const down = new Map();                                            // id -> {x, y}: the fingers currently on the glass
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...down].map(([id, p]) => ({ id, x: p.x, y: p.y })) });
  const finger = {
    async down(id, x, y) { down.set(id, { x, y }); await send('touchStart'); },
    async move(id, x, y) { down.set(id, { x, y }); await send('touchMove'); },
    async up(id) { down.delete(id); await send('touchEnd'); },
    async tap(x, y) { await finger.down(99, x, y); await finger.up(99); },
  };
  const centre = (sel) => page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; }, sel);
  const T = () => page.evaluate(() => ({ ax: TouchInput.ax, ay: TouchInput.ay, sprint: TouchInput.sprint, active: TouchInput.active }));
  const pose = () => page.evaluate(() => {
    const e = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(Game.camera.quaternion), p = Game.playerObj.position;
    return { yaw: e.y, pitch: e.x, x: p.x, z: p.z, ammo: Game.ammo, moving: Game.moving, sprinting: Game.sprinting, hasFocus: document.hasFocus() };
  });

  // ---- title screen in touch mode
  const title = await page.evaluate(() => ({
    touch: document.body.classList.contains('touch'),
    touchHelp: getComputedStyle(document.querySelector('.touchHelp')).display, kbHelp: getComputedStyle(document.querySelector('.kbHelp')).display,
    ui: getComputedStyle(document.getElementById('touchUI')).display,
  }));
  row(title.touch && title.touchHelp !== 'none' && title.kbHelp === 'none', 'title: touch help shown, keyboard help hidden', JSON.stringify(title));
  row(title.ui === 'none', 'title: on-screen controls not drawn before START');
  await h.shot('title');

  // ---- START by tap
  const sb = await centre('#startBtn');
  await finger.tap(sb.x, sb.y);
  await page.waitForFunction(() => window.__gameStarted === true, null, { timeout: 15000 });
  await h.frames(3);
  await h.clean(); await h.godMode(true); await h.resetView(); await h.pause();
  row(true, 'START by tap', 'game started');
  const ui = await page.evaluate(() => ({ ui: getComputedStyle(document.getElementById('touchUI')).display, rotate: getComputedStyle(document.getElementById('rotateHint')).display }));
  row(ui.ui === 'block' && ui.rotate === 'none', 'on-screen controls shown in landscape', JSON.stringify(ui));
  await h.advance(300, 33);
  await h.shot('hud');

  const p0 = await pose();
  if (!p0.hasFocus) console.log('WARN  document.hasFocus() is false: the game ignores movement input (headless focus)');

  // ---- stick: half push, full push (sprint), release
  const stickX = 150, stickY = 290;
  await finger.down(1, stickX, stickY);
  await finger.move(1, stickX, stickY - 22);
  await h.advance(400, 33);
  const half = await T(), pHalf = await pose();
  await finger.move(1, stickX, stickY - 90);
  await h.advance(400, 33);
  const full = await T(), pFull = await pose();
  await h.shot('active');
  row(half.ay > 0.2 && half.ay < 0.8 && !half.sprint, 'stick: half push = slow analog forward', `ay ${half.ay.toFixed(2)} sprint ${half.sprint}`);
  row(full.ay > 0.95 && full.sprint, 'stick: full push = full speed + sprint', `ay ${full.ay.toFixed(2)} sprint ${full.sprint}`);
  const dHalf = Math.hypot(pHalf.x - p0.x, pHalf.z - p0.z), dFull = Math.hypot(pFull.x - pHalf.x, pFull.z - pHalf.z);
  row(p0.hasFocus ? (dHalf > 0.3 && dFull > dHalf * 1.5 && pFull.z < p0.z) : true, 'player walks forward, faster when pushed further',
    p0.hasFocus ? `half-push ${dHalf.toFixed(2)} m / 0.4 s, full ${dFull.toFixed(2)} m / 0.4 s` : 'skipped: no focus');
  await finger.move(1, stickX + 80, stickY);                         // strafe right
  await h.advance(300, 33);
  const side = await T();
  row(side.ax > 0.9 && Math.abs(side.ay) < 0.1, 'stick: sideways = strafe', `ax ${side.ax.toFixed(2)} ay ${side.ay.toFixed(2)}`);
  await finger.up(1);
  await h.advance(200, 33);
  const rel = await T(), pRel = await pose();
  await h.advance(300, 33);
  const pRel2 = await pose();
  row(rel.ax === 0 && rel.ay === 0 && !rel.sprint && Math.hypot(pRel2.x - pRel.x, pRel2.z - pRel.z) < 0.01, 'stick: release stops the player', `ax ${rel.ax} ay ${rel.ay}`);

  // ---- look
  const yaw0 = (await pose()).yaw;
  await finger.down(2, 600, 200);
  for (let i = 1; i <= 5; i++) await finger.move(2, 600 + i * 20, 200);
  await finger.up(2);
  const yaw1 = (await pose()).yaw;
  row(Math.abs(yaw1 - yaw0 - -100 * 0.0042) < 0.02, 'look: 100 px drag right turns the view right', `yaw ${yaw0.toFixed(3)} -> ${yaw1.toFixed(3)} (expect ${(-100 * 0.0042).toFixed(3)})`);
  await finger.down(2, 600, 300);
  for (let i = 1; i <= 10; i++) await finger.move(2, 600, 300 - i * 30);   // 300 px up
  await finger.up(2);
  const pitchUp = (await pose()).pitch;
  await finger.down(2, 600, 50);
  for (let i = 1; i <= 14; i++) await finger.move(2, 600, 50 + i * 25);    // 350 px down
  await finger.up(2);
  const pitchDown = (await pose()).pitch;
  row(pitchUp > 0.5 && pitchUp <= 1.5001 && pitchDown < pitchUp && pitchDown >= -1.5001, 'look: pitch follows the drag and is clamped', `up ${pitchUp.toFixed(2)}, then down ${pitchDown.toFixed(2)}`);
  await h.resetView();

  // ---- FIRE (tap), then FIRE + drag = aim while shooting
  const fire = await centre('#tFire');
  const a0 = (await pose()).ammo;
  await finger.tap(fire.x, fire.y);
  await h.advance(200, 33);
  const a1 = (await pose()).ammo;
  row(a1 === a0 - 1, 'FIRE: a tap fires one shot', `ammo ${a0} -> ${a1}`);
  await h.advance(500, 33);                                          // past the 350 ms fire gate
  const yawF0 = (await pose()).yaw;
  await finger.down(3, fire.x, fire.y);
  for (let i = 1; i <= 5; i++) await finger.move(3, fire.x - i * 10, fire.y);
  await finger.up(3);
  const pF = await pose();
  row(pF.ammo === a1 - 1 && pF.yaw > yawF0 + 0.1, 'FIRE: holding it and dragging aims while shooting', `ammo ${pF.ammo}, yaw +${(pF.yaw - yawF0).toFixed(2)}`);

  // ---- RELOAD
  const reload = await centre('#tReload');
  await finger.tap(reload.x, reload.y);
  await h.advance(2000, 33);
  const pR = await pose();
  row(pR.ammo === 6, 'RELOAD: refills the revolver', `ammo ${pR.ammo}`);

  // ---- SPRINT latch
  const spr = await centre('#tSprint');
  await finger.tap(spr.x, spr.y);
  const sOn = (await T()).sprint;
  await finger.tap(spr.x, spr.y);
  const sOff = (await T()).sprint;
  row(sOn === true && sOff === false, 'SPRINT: latch toggles on and off', `on ${sOn}, off ${sOff}`);

  // ---- three fingers at once: stick + look + fire
  const pM0 = await pose();
  await finger.down(1, stickX, stickY);
  await finger.move(1, stickX, stickY - 60);
  await finger.down(2, 600, 200);
  await finger.move(2, 660, 200);
  await finger.down(3, fire.x, fire.y);
  await finger.move(1, stickX, stickY - 70);
  await finger.move(2, 700, 200);
  await h.advance(300, 33);
  const pM1 = await pose(), tM = await T();
  row(tM.ay > 0.8 && pM1.yaw < pM0.yaw - 0.2 && pM1.ammo === pM0.ammo - 1, 'stick + look + fire at the same time', `ay ${tM.ay.toFixed(2)}, yaw ${(pM1.yaw - pM0.yaw).toFixed(2)}, ammo ${pM0.ammo} -> ${pM1.ammo}`);
  await finger.up(3); await finger.up(2); await finger.up(1);
  await h.advance(100, 33);

  // ---- MUTE and PAUSE
  const mute = await centre('#tMute');
  await finger.tap(mute.x, mute.y);
  const m1 = await page.evaluate(() => ({ muted: Sfx.isMuted(), hint: getComputedStyle(document.getElementById('muteHint')).display, on: document.getElementById('tMute').classList.contains('on') }));
  await finger.tap(mute.x, mute.y);
  const m2 = await page.evaluate(() => Sfx.isMuted());
  row(m1.muted && m1.hint !== 'none' && m1.on && !m2, 'MUTE button toggles mute and the hint', JSON.stringify(m1) + ' then ' + m2);
  const pause = await centre('#tPause');
  await finger.tap(pause.x, pause.y);
  const pz = await page.evaluate(() => ({ paused: Main.isPaused(), text: document.querySelector('#pauseScreen p').textContent }));
  await finger.tap(422, 195);                                        // tap the overlay
  await h.advance(100, 33);
  const rs = await page.evaluate(() => Main.isPaused());
  row(pz.paused && pz.text === 'Tap to resume' && rs === false, 'PAUSE button pauses, a tap resumes (no pointer lock needed)', `paused ${pz.paused}, "${pz.text}", resumed ${!rs}`);

  // ---- portrait: the game pauses and a "turn your device" screen covers it
  await page.setViewportSize({ width: 390, height: 844 });
  await h.advance(100, 33);
  const port = await page.evaluate(() => ({ paused: Main.isPaused(), rotate: getComputedStyle(document.getElementById('rotateHint')).display }));
  row(port.rotate === 'flex' && port.paused, 'portrait: paused + "turn your device" screen', JSON.stringify(port));
  await page.setViewportSize({ width: 844, height: 390 });
  await finger.tap(422, 195);
  await h.advance(100, 33);

  row(errors.length === 0, 'no console / page errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  failed++;
  console.log('FAIL  harness: ' + (e.stack || e));
  if (errors.length) console.log('page errors:\n  ' + errors.slice(0, 5).join('\n  '));
} finally {
  await s.close();
}

// ---- desktop: no touch flag, mouse START -> nothing touch-related is shown
try {
  const d = await launch({ scenario: 'touch-desktop', file, query: 'debug=1', viewport: { width: 960, height: 540 } });
  try {
    await d.h.boot();
    await d.h.start();
    const r = await d.page.evaluate(() => ({ touch: document.body.classList.contains('touch'), ui: getComputedStyle(document.getElementById('touchUI')).display,
      help: getComputedStyle(document.querySelector('.touchHelp')).display, active: TouchInput.active }));
    row(!r.touch && r.ui === 'none' && r.help === 'none' && !r.active, 'desktop: no touch UI, touch mode off', JSON.stringify(r));
    row(d.errors.length === 0, 'desktop: no console errors', d.errors.slice(0, 2).join(' | '));
  } finally { await d.close(); }
} catch (e) { failed++; console.log('FAIL  desktop harness: ' + (e.stack || e)); }

console.log(`\nTOUCH CHECK ${failed ? 'FAIL' : 'PASS'}  (${failed} failure(s))`);
process.exit(failed ? 1 : 0);
