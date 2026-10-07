const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  p.on('pageerror', e => errs.push('PE: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CE: ' + m.text()); });
  await p.goto('file:///' + require('path').resolve('knights_out.html').replace(/\\/g, '/'), { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(1500);

  // probe before start click
  const pre = await p.evaluate(() => ({
    hasFocus: document.hasFocus(),
    lockVisible: getComputedStyle(document.getElementById('lock')).display,
    hud: !!document.getElementById('hud'),
    hudInner: document.getElementById('hud') ? document.getElementById('hud').innerHTML.length : -1,
    gameDead: window.Game ? window.Game.dead : null,
    hp: window.Game ? window.Game.playerHP : null,
    started: typeof started !== 'undefined' ? 'module-scoped' : 'unknown'
  }));
  console.log('PRE:', JSON.stringify(pre, null, 1));

  const btnBox = await p.locator('#startBtn').boundingBox();
  console.log('startBtn box:', JSON.stringify(btnBox));

  // what element is at the button's center point? (occlusion test)
  if (btnBox) {
    const occl = await p.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.id || el.tagName + '.' + (el.className || '') : 'null';
    }, [btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2]);
    console.log('element at button center:', occl);
  }

  // click and check the error-file divs
  await p.click('#startBtn').catch(e => console.log('click err', e.message));
  await p.waitForTimeout(1500);
  const post = await p.evaluate(() => {
    const errDivs = Array.from(document.querySelectorAll('pre')).filter(d => d.textContent.includes(':'));
    return { errorDivs: errDivs.map(e => e.textContent.slice(0, 200)),
      lockVisible: getComputedStyle(document.getElementById('lock')).display,
      hp: window.Game.playerHP, dead: window.Game.dead, hasFocus: document.hasFocus() };
  });
  console.log('POST:', JSON.stringify(post, null, 1));

  // keyboard focus test
  await p.keyboard.down('KeyW');
  await p.waitForTimeout(500);
  await p.keyboard.up('KeyW');
  const k = await p.evaluate(() => {
    // replicate getInput state machine directly
    const posAfter = window.Game.playerObj.position.toArray();
    return { posAfter };
  });
  console.log('after W:', JSON.stringify(k));
  console.log('errs:', errs.slice(0, 6));
  await b.close();
})();
