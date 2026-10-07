const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto('file:///' + require('path').resolve('knights_out_final.html').replace(/\\/g, '/'), { waitUntil: 'networkidle', timeout: 90000 });
  await p.click('#startBtn');
  await p.waitForTimeout(2500);

  // DEFECT 2: Player.fire + Smite wiring
  const fire = await p.evaluate(() => ({
    fireExists: !!(window.Player && window.Player.fire),
    fireType: typeof (window.Player && window.Player.fire),
    smiteArm: !!(window.Smite && window.Smite.arm),
    smiteMaybeApply: !!(window.Smite && window.Smite.maybeApply),
    positionGetter: !!(window.Player && window.Player.position)
  }));

  // DEFECT 1: swing damage — knight at melee range over 4s of simulated updates
  const swing = await p.evaluate(() => {
    const e = window.Enemies.list.find(x => !x.mesh.userData.dying);
    window.Game.playerObj.position.set(e.mesh.position.x + 1.5, 1.7, e.mesh.position.z);
    let swings = 0, dmg = 0;
    const origHurt = window.Player.hurt;
    window.Player.hurt = function (d) { dmg += d; };
    const origSwing = e.swing.bind(e);
    e.swing = function () { swings++; return origSwing(); };
    for (let i = 0; i < 240; i++) e.update(1 / 60, window.Game.playerObj.position.clone(), 1);
    window.Player.hurt = origHurt;
    return { swings, dmg, hp: window.Game.playerHP, expected: '~1 swing per 1.6s attack cycle + 15dmg' };
  });

  // DEFECT 3: DOM duplicates
  const dom = await p.evaluate(() => {
    const c = s => document.querySelectorAll(s).length;
    return {
      crosshair: c('#crosshair'), waveInfo: c('#waveInfo'),
      gameOver: c('#gameOverScreen'), victory: c('#victoryScreen'),
      hpFill: c('#hpFill'), healthFill: c('#healthFill'),
      pips: c('.ammo-pip'), vignette: c('#vignette'), spinner: c('#reloadSpinner'),
      hitMarker: c('#hitMarker')
    };
  });

  console.log('D2 fire/smite:', JSON.stringify(fire));
  console.log('D1 swing/damage:', JSON.stringify(swing));
  console.log('D3 DOM counts:', JSON.stringify(dom));
  await b.close();
})();