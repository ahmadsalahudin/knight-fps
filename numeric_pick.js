/**
 * NUMERIC HUNT: use the physics spec (position: X~0.5, Y~-0.4, Z~0.35; rotation: pitch-8°, yaw+2°)
 * + hardcoded GLB rest-orientation uncertainty, and via gemma-4-31b-I pixel-measure the
 * MUZZLE position (x,y) per candidate, match against the reference image's muzzle.
 *
 * KEY BREAKTHROUGH: 2-image comparison is PLAYBACK-LIMITED by qualitative text output
 * turnaround. DELETE textual question, ask coordinate picking per image, COMPUTE DIFF ourselves:
 * purely geometry, deterministic, threshold-excite-free.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://backend.sovereigneg.com/v1';
const KEY = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';
const VL = 'gemma-4-31b-it';

// geometric primitives
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

async function landmarks(b64, tag) {
  const prompt = `Screenshot 1280x800. Find these 3 point features of the GUN VIEWMODEL in the
LOWER-QUADRANT (assume right-side of screen unless art defies it). Give EXACT
pixel coordinates as "x,y" (x=col from left, y=row from top). Don't reason about
pose, just return the 3 points in order:
1. MUZZLE_TIP  (the far-end of the barrel -- where bullets come out; a dark/rim point)
2. Hilt_indented_GRIP_END  (furthest hinge/building behind the trigger)
3. WHITE_DOT_CENTER  (ceil crosshair superimposed over the center of the frame
     might be white or it might not -- just give the best guess for the dot-sized beacon)
FORMAT strictly:
MUZZLE: (x,y)
GRIP: (x,y)
DOT: (x,y)`;

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VL,
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
        ],
      }],
    }),
  });
  const j = await res.json();
  const raw = (j.choices ? j.choices[0].message.content : '');

  const muzzle = /MUZZLE:\s*\(?([-\d.]+)[,\s]+([-\d.]+)\)?/.exec(raw);
  const grip = /GRIP:\s*\(?([-\d.]+)[,\s]+([-\d.]+)\)?/.exec(raw);
  const dot = /DOT:\s*\(?([-\d.]+)[,\s]+([-\d.]+)\)?/.exec(raw);
  if (!muzzle || !grip || !dot) return { err: 'parse', raw };

  return {
    segment: {
      muzzle: [parseFloat(muzzle[1]), parseFloat(muzzle[2])],
      grip: [parseFloat(grip[1]), parseFloat(grip[2])],
    },
    dot: [parseFloat(dot[1]), parseFloat(dot[2])]
  };
}

function v2sub(a, b) { return [a[0]-b[0], a[1]-b[1]]; }
function v2mul(a, k) { return [a[0]*k, a[1]*k]; }
function v2len(a) { return Math.hypot(a[0], a[1]); }
function v2unit(a) { const l = v2len(a) || 1; return [a[0]/l, a[1]/l]; }
function v2dot(a, b) { return a[0]*b[0] + a[1]*b[1]; }

// ---- scoring: exact numeric diff between ref & candidate landmarks ----
function score(ref, cand) {
  // 1-3 is bullet/next. We compare: muzzleXY against muzzleXY for SIZE-agnostic ref.
  // Handle matches via transfer vectors
  const refM_refD = v2sub(ref.segment.muzzle, ref.dot);
  const candM_candD = v2sub(cand.segment.muzzle, cand.dot);
  const refG_refD = v2sub(ref.segment.grip, ref.dot);
  const candG_candD = v2sub(cand.segment.grip, cand.dot);

  const posErrM = v2sub(refM_refD, candM_candD);
  const posErrG = v2sub(refG_refD, candG_candD);
  const magRatio = v2len(refM_refD) / (v2len(candM_candD) || 1);
  const dirM = v2unit(refM_refD);
  const dirG = v2unit(refG_refD);
  const angleErrBarrel = Math.acos(clamp(v2dot(dirM, v2unit(candM_candD)), -1, 1));
  const angleErrGrip = Math.acos(clamp(v2dot(dirG, v2unit(candG_candD)), -1, 1));

  // Composite scalar: smaller is better
  const total = v2len(posErrM) + v2len(posErrG)
    + Math.abs(Math.log10(magRatio)) * 300   // penalty if musketealth of differing length
    + (angleErrBarrel + angleErrGrip) * 180 / Math.PI * 1.2;
  return { total, muzzleOffset: v2len(posErrM), gripOffset: v2len(posErrG),
           magRatio, angleErrBarrelDeg: angleErrBarrel * 180 / Math.PI,
           angleErrGripDeg: angleErrGrip * 180 / Math.PI };
}

(async () => {
  // 1. landmarks from the user-confirmed golden reference
  const referenceShot = fs.readFileSync('gunsearch_90_0_0.png').toString('base64');
  const ref = await landmarks(referenceShot);
  if (ref.err) { console.log('reference landmark parse failed', ref); process.exit(1); }
  console.log('REFERENCE landmarks:', JSON.stringify(ref));

  // 2. browser boot once
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:8877/knights_out_final.html', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.click('#startBtn');
  await page.waitForTimeout(2500);

  // 3. nested grid around the PHYSICS SPEC's coordinates
  // Position: X≈0.45-0.6, Y≈-0.45, Z≈-0.35 (three.js --Z is forward-from-camera)
  // Rotation: pitch-X≈-8°, Yaw-Y≈+2°, Roll-Z≈0°
  const positions = [
    [0.5, -0.4, -0.35],
    [0.55, -0.45, -0.35],
    [0.45, -0.35, -0.5],
    [0.55, -0.55, -0.4],
  ];
  const rotations = [
    [-8 * Math.PI/180, 2 * Math.PI/180, 0],    // spec-native
    [-8 * Math.PI/180, 0, 0],                   // spec minus yaw
    [0, 2 * Math.PI/180, 0],                    // spec minus pitch
    [0, 0, 0],                                  // neutral
    [-16 * Math.PI/180, 2 * Math.PI/180, 0],    // more aggressive up-pitch
  ];
  // also experiment with the RAW GLB's own sub-rotation as a fourth dial
  const gunRests = [[0,0,0], [Math.PI/2, 0, 0], [0, Math.PI/2, 0], [Math.PI/2, Math.PI/2, 0]];

  const tried = [];
  outer:
  for (const rot of rotations) {
    for (const pos of positions) {
      for (const gunRest of gunRests) {
        // enforce clutch of values, then snapshot confirming (via city-list)
        await page.evaluate((p, r, g) => {
          const fetchGun = window.Game.gun, fetchRig = window.Game.gunRig;
          if (fetchGun) fetchGun.rotation.set(g[0], g[1], g[2]);
          fetchRig.rotation.set(r[0], r[1], r[2]);
          fetchRig.position.set(p[0], p[1], p[2]);
        }, pos, rot, gunRest);
        await page.waitForTimeout(200);
        // force-eft exact after — kill death-reset lerp spillover (reticleResetPull every deci)
        await page.evaluate((p, r, g) => {
          const C = window.Game.gun, D = window.Game.gunRig;
          if (C)
            C.rotation.set(g[0], g[1], g[2]);
          D.rotation.set(r[0], r[1], r[2]);
          D.position.set(p[0], p[1], p[2]);
        }, pos, rot, gunRest);
        await page.waitForTimeout(100);

        const shot = await page.screenshot();
        const b64 = shot.toString('base64');
        const tag = `P${pos.map(x => x.toFixed(2))}_R${rot.map(x => (x*57.3).toFixed(0))}_G${gunRest.map(x => (x*57.3).toFixed(0))}`;
        fs.writeFileSync(`hunt_${tag}.png`, shot);

        const cand = await landmarks(b64, tag);
        if (cand.err) { console.log(`${tag} -> ERR ${cand.raw}`); continue; }
        const sc = score(ref, cand);
        tried.push({ tag, pos, rot, gunRest, sc, cand });
        console.log(`${tag} -> dM=${sc.muzzleOffset.toFixed(0)}px dG=${sc.gripOffset.toFixed(0)}px aMB=${sc.angleErrBarrelDeg.toFixed(0)}° aMG=${sc.angleErrGripDeg.toFixed(0)}° TOT=${sc.total.toFixed(0)}`);

        if (sc.total < 400) {
          console.log(`   >>> CANDIDATE ACCEPTED (total = ${sc.total.toFixed(1)})`);
        }
      }
    }
  }
  console.log('\n<<< GRID COMPLETE. Best N + LOWEST PER SCORE TOT:');
  tried.sort((a, b) => a.sc.total - b.sc.total);
  for (const e of tried.slice(0, 5))
    console.log(`score=${e.sc.total.toFixed(0)}  ${e.tag} | dM=${e.sc.muzzleOffset.toFixed(0)}px dG=${e.sc.gripOffset.toFixed(0)}px`);

  console.log('\nWINNER:', JSON.stringify(tried[0], null, 2));
  fs.writeFileSync('grid_win.json', JSON.stringify(tried, null, 1));

  await browser.close();
})();