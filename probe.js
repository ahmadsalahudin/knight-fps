const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('C: ' + m.text()); });
  await p.goto('file:///' + require('path').resolve('knights_out.html').replace(/\\/g, '/'), { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(2000);
  const state = await p.evaluate(() => {
    const ids = ['World', 'Assets', 'Game', 'Enemies', 'Waves', 'HUD', 'Sfx', 'Smite', 'Player'];
    const found = {};
    for (const id of ids) found[id] = typeof window[id];
    const lock = document.getElementById('lock');
    const startBtn = document.getElementById('startBtn');
    const hud = document.getElementById('hud');
    const assetsCount = window.ASSETS ? Object.keys(window.ASSETS).length : 0;
    let assetsProbe = null;
    try { if (window.Assets && window.Assets.get) { const m = window.Assets.get('grass'); assetsProbe = m ? 'mesh-ok' : 'null'; } } catch (e) { assetsProbe = 'err: ' + e.message.slice(0, 80); }
    return { found, lock: lock ? lock.outerHTML.slice(0, 200) : null, startBtn: !!startBtn, hudHtml: hud ? hud.outerHTML.slice(0, 300) : null, assetsCount, assetsProbe };
  });
  console.log(JSON.stringify(state, null, 1));
  console.log('errors:', errs.slice(0, 10));
  await b.close();
})();
