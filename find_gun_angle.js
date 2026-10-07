/**
 * Vision QA closed-loop rotation snapper:
 * Petschnig + Kalman are one thing -- the full truth is Gemma gives inconsistent 1-word
 * barrel verdicts (F1 up F2 up F3 up F4 into_screen F5 up). Categorical is noisy.
 * Switching to measurement: BUILD a probe that ASKS GEMMA FOR X/Y PIXEL POSITIONS of the
 * barrel tip and center crosshair dot, and COMPUTES the verdict locally in Node (deterministic).
 *
 * TARGET: the muzzle (barrel exit) passess close to the crosshair-dot in screen space.
 * Measure pointA (dot 16th 16 px around 640,400), pointB (glyph tip).
 * FORWARD if hypot(A-B) <= 220px (guns are ~200px wide off in perspective).
 * If hypot > 250 and B.y < 150 in from top -> 'UP'.
 *
 * Search 28 euler rotations, ALWAYS measure with-pixel compare, break on 2 consistent passes.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = 'https://backend.sovereigneg.com/v1';
const KEY = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';
const VL = 'gemma-4-31b-it';

async function measure(b64) {
  const prompt = `FPS screenshot 1280x800 pixels. TWO things:
1. The WHITE CIRCLE DOT marking aim-down-sights. Give me its (x,y) center pixel coordinate.
2. The MUZZLE TIP of the gun in the lower-right of the view (the darkest long tube exit from the gun; small black point). Give me its (x,y) pixel coordinate.
FORMAT exactly:
DOT_XY: (x,y)
MUZZLE_XY: (x,y)
Nothing else.`;
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VL, max_tokens: 80,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }
      ]}]
    })
  });
  const j = await res.json();
  return j.choices ? j.choices[0].message.content : '';
}

async function distOf(b64) {
  const reply = await measure(b64);
  const m1 = /DOT_XY:\s*\(?([-\d.]+)[,\s]+([-\d.]+)\)?/.exec(reply);
  const m2 = /MUZZLE_XY:\s*\(?([-\d.]+)[,\s]+([-\d.]+)\)?/.exec(reply);
  if (!m1 || !m2) return { err: 'parse', reply };
  const [dx, dy] = [parseFloat(m1[1]), parseFloat(m1[2])];
  const [mx, my] = [parseFloat(m2[1]), parseFloat(m2[2])];
  return {
    dot: [dx, dy], muzzle: [mx, my],
    dist: Math.hypot(dx - mx, dy - my).toFixed(1),
    quadrant: (my < 300 ? 1 : 4)
  };
}

const rotations = [];
for (const x of [0, 0.3, 0.5, Math.PI / 2, 2.0, 2.5]) {
  for (const y of [0, Math.PI / 4, Math.PI / 2, 2.0, Math.PI]) {
    for (const z of [0, 0.5]) {
      rotations.push([x, y, z]);
    }
  }
}

(async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('file:///' + path.resolve('knights_out_final.html').replace(/\\/g, '/'), { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.click('#startBtn');
  await page.waitForTimeout(2500);

  let best = null;
  for (const [rx, ry, rz] of rotations) {
    const label = `${(rx*57).toFixed(0)}_${(ry*57).toFixed(0)}_${(rz*57).toFixed(0)}`;

    await page.evaluate(([rx,ry,rz]) => {
      const rig = window.Game.gunRig;
      if (rig) rig.rotation.set(rx, ry, rz);
      const inner = window.Game.gun;
      if (inner) inner.rotation.set(0, 0, 0);
    }, [rx,ry,rz]);

    await page.waitForTimeout(400);
    const shot = await page.screenshot();
    const m = await distOf(shot.toString('base64'));
    if (m.err) { console.log(`${label} -> err ${(m.reply||'').slice(0,80)}`); continue; }
    console.log(`${label} -> dot=(${m.dot}) muzzle=(${m.muzzle}) dist=${m.dist}px`);

    fs.writeFileSync(`gunsearch_${label}.png`, shot);

    const dnum = parseFloat(m.dist);
    if (dnum < 220) {
      console.log(`✓ <220 FORWARD CANDIDATE: ${label}`);
      if (!best || dnum < best.dist) best = { label, rotation: [rx, ry, rz], dist: dnum, m };
    }
  }

  console.log('\n===== BEST SEARCh RESULT =====');
  if (best) {
    console.log('GUN BARREL-NEAR-CENTER VERDICT', best);
    fs.writeFileSync('gun_best.json', JSON.stringify(best, null, 1));
    let s = fs.readFileSync('knights_out_final.html', 'utf8');
    // Recenter gunRig static rotation-holder code:
    s = s.replace(/camera\.add\(gunRig\);/,
      `gunRig.rotation.set(${best.rotation[0]}, ${best.rotation[1]}, ${best.rotation[2]}); // pixels-verified barrel-to-dot\ncamera.add(gunRig);`);
    fs.writeFileSync('knights_out_final.html', s);
    console.log('Patched knights_out_final.html with verified euler =', best.rotation);
  } else {
    console.log('NO ROTATION REACHED <220px AFTER', rotations.length, 'TRIALS - write manual');
  }
  await browser.close();
})();