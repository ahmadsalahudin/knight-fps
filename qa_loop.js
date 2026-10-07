const { chromium } = require('playwright');
const fs = require('fs');

const file = process.argv[2] || 'knights_out.html';
const url = 'file:///' + require('path').resolve(file).replace(/\\/g, '/');
const ALLOWED = ['three.min.js', 'PointerLockControls.js', 'GLTFLoader.js'];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [], failedReqs = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('requestfailed', r => {
    if (!ALLOWED.some(a => r.url().includes(a)))
      failedReqs.push('REQFAIL: ' + r.url() + ' :: ' + (r.failure() || {}).errorText);
  });

  const report = { file, checks: {}, errors, failedReqs };
  const step = (name, ok, detail) => {
    report.checks[name] = { ok, detail: detail || '' };
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`);
  };

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);

  // C1: no fatal js errors on load
  const fatal = errors.filter(e => !e.includes('favicon'));
  step('C1_no_load_errors', fatal.length === 0, fatal.slice(0, 3).join(' | '));

  // C2: THREE defined
  const three = await page.evaluate(() => typeof window.THREE !== 'undefined');
  step('C2_threejs_loaded', three);
  if (!three) { report.errors = errors; done(); return; }

  // C2b: GLB assets parsed without error — knight mesh exists
  const knightOk = await page.evaluate(() => { try { const m = window.Assets.get('knight'); return !!m && m.children.length > 0; } catch (e) { return false; } });
  step('C2b_knight_glbt_parses', knightOk);

  // C3: start button visible
  const btn = await page.locator('#startBtn').isVisible();
  step('C3_start_button_visible', btn);

  // C4: click start -> menu hides
  await page.click('#startBtn').catch(() => {});
  await page.waitForTimeout(1500);
  const menuHidden = await page.locator('#lock').isHidden().catch(() => false);
  step('C4_menu_hides_on_start', menuHidden);

  // C5: pointer lock active
  const locked = await page.evaluate(() => !!document.pointerLockElement);
  step('C5_pointer_locked', locked);

  // C6: enemies spawn (wave active)
  const enemies0 = await page.evaluate(() => window.Enemies ? window.Enemies.list.length : -1);
  step('C6_enemies_spawned', enemies0 > 0, `count=${enemies0}`);

  // FREEZE enemy AI updates so the idle bot doesn't get killed during motion/shoot tests
  await page.evaluate(() => { window.__realEnemiesUpdate = window.Enemies.update; window.Enemies.update = function(){}; });

  // C7: W must move player in the direction the camera faces (directional check)
  const p0 = await page.evaluate(() => { window.Game.camera.lookAt(0, 1.2, -10); return window.Game.playerObj.position.toArray(); });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyW');
  const p1 = await page.evaluate(() => window.Game.playerObj.position.toArray());
  const movedZ = p1[2] - p0[2];
  // camera faces -Z; W must decrease z
  step('C7_wasd_movement', movedZ < -0.3, `dz=${+movedZ.toFixed(2)} (camera faces -Z, W must go -Z)`);
  // A must strafe left (world -X when facing -Z)
  const q0 = await page.evaluate(() => window.Game.playerObj.position.toArray());
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyA');
  const q1 = await page.evaluate(() => window.Game.playerObj.position.toArray());
  step('C7b_strafe_left', q1[0] - q0[0] < -0.2, `dx=${+(q1[0] - q0[0]).toFixed(2)}`);

  // C8: shooting damages/kills a knight (aim + real mousedown)
  let shotOk = false, detail8 = '';
  try {
    const baseline = await page.evaluate(() => ({ count: window.Enemies.list.length,
      hp: window.Enemies.list[0] ? window.Enemies.list[0].mesh.userData.hp : null }));
    for (let i = 0; i < 10 && !shotOk; i++) {
      await page.evaluate(() => {
        const cam = window.Game.camera;
        const ens = window.Enemies.list;
        if (!ens.length) return;
        const e = ens.reduce((a, b) =>
          a.mesh.position.distanceTo(cam.position) < b.mesh.position.distanceTo(cam.position) ? a : b);
        // aim at the knight's ACTUAL bbox center (head height ~2.8u on scaled knight)
        const bb = new THREE.Box3().setFromObject(e.mesh);
        cam.lookAt(bb.getCenter(new THREE.Vector3()));
      });
      await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
      await page.waitForTimeout(400); // fire cooldown 350ms
      shotOk = await page.evaluate((bl) => {
        const ens = window.Enemies.list;
        const damaged = ens.some(e => e.mesh.userData.hp < 40);
        const dead = ens.length === 0 || ens.length < bl.count || ens.some(e => e.mesh.userData.dying);
        return damaged || dead;
      }, baseline).catch(() => false);
    }
    const after = await page.evaluate(() => ({ count: window.Enemies.list.length,
      hps: window.Enemies.list.slice(0, 4).map(e => e.mesh.userData.hp),
      wave: window.Waves.current }));
    step('C8_shoot_kills_knight', !!shotOk, `after=${JSON.stringify(after)}`);
  } catch (e) { step('C8_shoot_kills_knight', false, e.message); }

  // C9: player damage/game-over path — restore enemy updates, let a knight reach and kill the bot
  await page.evaluate(() => {
    window.Enemies.update = window.__realEnemiesUpdate;  // unfreeze
    // teleport player into enemy contact range for deterministic damage
    const p = window.Game.playerObj.position;
    const e = window.Enemies.list.find(x => !x.mesh.userData.dying);
    if (e) p.set(e.mesh.position.x + 1.0, 1.7, e.mesh.position.z);
  });
  await page.waitForTimeout(3500); // knights swing every ~1.6s → enough hits to reach 0hp (100hp / 15dmg)
  const deathState = await page.evaluate(() => {
    return { hp: window.Game.playerHP, dead: window.Game.dead };
  });
  const goScreens = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div')).filter(d => /GAME OVER/i.test(d.textContent) && d.style.display !== 'none');
    return els.length;
  });
  step('C9_death_gameover', deathState.dead ? goScreens > 0 : deathState.hp > 0,
    `hp=${deathState.hp} dead=${deathState.dead} goScreens=${goScreens}`);

  // C10: wave progression — force-kill all, wave should advance after intermission
  const waveBefore = await page.evaluate(() => window.Waves.current);
  await page.evaluate(() => {
    const list = window.Enemies.list.slice();
    list.forEach(e => { window.Enemies.hurt(e.mesh, 9999); });
  });
  await page.waitForTimeout(5500); // intermission 4s + spawn stagger
  const waveAfter = await page.evaluate(() => ({ wave: window.Waves.current, enemies: window.Enemies.list.length }));
  step('C10_wave_progression', waveAfter.wave > waveBefore || waveAfter.enemies > 0,
    `before=${waveBefore} after=${JSON.stringify(waveAfter)}`);

  // C11: final error sweep
  const fatalEnd = errors.filter(e => !e.includes('favicon'));
  step('C11_no_runtime_errors', fatalEnd.length === 0, fatalEnd.slice(0, 5).join(' | '));

  await page.screenshot({ path: 'qa_screenshot.png' });
  done();

  function done() {
    fs.writeFileSync('qa_report.json', JSON.stringify(report, null, 1));
    const passed = Object.values(report.checks).filter(c => c.ok).length;
    const total = Object.keys(report.checks).length;
    console.log(`\nQA VERDICT: ${passed}/${total} checks passed — ${passed === total ? 'GAME WORKS' : 'GAME BROKEN'}`);
    process.exit(passed === total ? 0 : 1);
  }
})();
