// deep probe: trace Game.hurt path when playerHP hits 0 — does HUD.gameOver exist?
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('file:///' + require('path').resolve('knights_out_final.html').replace(/\\/g, '/'), { waitUntil: 'networkidle', timeout: 90000 });
  await p.click('#startBtn');
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => {
    return {
      hudExists: !!window.HUD,
      gameOverIsFn: window.HUD ? typeof HUD.gameOver : 'no-HUD',
      hp: window.Game.playerHP, dead: window.Game.dead,
      // get the player to 0 via direct hurt and see what happens
    };
  });
  console.log('pre-death:', JSON.stringify(r));
  // force-death, capture console errors after
  const r2 = await p.evaluate(() => {
    window.Game.hurt(100);
    return { hp: window.Game.playerHP, dead: window.Game.dead };
  });
  await p.waitForTimeout(600);
  const screens = await p.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div')).filter(d => /GAME OVER/i.test(d.textContent) && d.style.display !== 'none');
    return { count: els.length, texts: els.map(e => e.textContent.slice(0, 80)) };
  });
  console.log('post-death:', JSON.stringify(r2), 'screens:', JSON.stringify(screens), 'errs:', errs);
  await b.close();
})();
