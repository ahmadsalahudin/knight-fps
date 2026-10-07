// QA harness library: launches Chromium (swiftshader WebGL), serves the repo,
// routes the three.js CDN to node_modules/three, collects errors, and exposes
// the helper object `h` that smoke.mjs / scenarios.mjs use.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, REPO_ROOT } from './serve.mjs';

export { REPO_ROOT };
export const QA_DIR = path.join(REPO_ROOT, 'tools', 'qa');
export const OUT_DIR = path.join(QA_DIR, 'out');
export const THREE_CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.147\.0\/(.*?)(?:\?.*)?$/;

// ---------------------------------------------------------------- playwright
function loadPlaywright() {
  const req = createRequire(path.join(REPO_ROOT, 'package.json'));
  for (const id of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { return req(id); } catch { /* try next */ }
  }
  throw new Error('playwright not found: run `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i` (never `playwright install`)');
}

function findChromiumExecutable() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(base).sort().reverse()) {
      if (!d.startsWith('chromium-')) continue;
      const exe = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* ignore */ }
  return undefined;
}

export const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--autoplay-policy=no-user-gesture-required',
];

// Injected before any page script. Passthrough by default; lets QA freeze or
// slow game time (performance.now drives THREE.Clock and most game timers).
const CLOCK_SCRIPT = `(() => {
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  let mode = 'scaled', scale = 1, baseReal = realNow(), baseVirtual = baseReal, manualT = 0;
  let pending = 0, stepMs = 1000 / 30, waiters = [];
  const now = () => (mode === 'manual' ? manualT : baseVirtual + (realNow() - baseReal) * scale);
  performance.now = now;
  // Registered first, re-registered first every frame => runs before the game's own rAF callbacks,
  // so each rendered frame sees exactly one virtual step while paused.
  const preFrame = () => {
    realRaf(preFrame);
    if (mode === 'manual' && pending > 1e-6) {
      const d = Math.min(stepMs, pending); manualT += d; pending -= d;
      if (pending <= 1e-6) { const w = waiters; waiters = []; w.forEach((f) => f()); }
    }
  };
  realRaf(preFrame);
  const nextFrame = () => new Promise((r) => realRaf(() => realRaf(r)));
  window.__qaClock = {
    now,
    mode: () => mode,
    timeScale(s) { const v = now(); baseReal = realNow(); baseVirtual = v; scale = s; mode = 'scaled'; },
    pause() { if (mode !== 'manual') { manualT = now(); mode = 'manual'; } },
    resume() { if (mode === 'manual') { baseReal = realNow(); baseVirtual = manualT; scale = 1; mode = 'scaled'; pending = 0; } },
    advance(ms, step) {
      this.pause();
      if (step) stepMs = step;
      pending += ms;
      return new Promise((r) => waiters.push(r)).then(nextFrame);
    },
  };
})();`;

// Deterministic Math.random (mulberry32) so the scattered world looks the same on every run.
const seedScript = (seed) => `(() => { let a = ${seed | 0};
  Math.random = function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
})();`;

/** CLI helper: --seed=N (default 1337), --seed=off to keep real randomness. */
export function parseSeed(v) {
  if (v === undefined || v === true) return 1337;
  if (v === 'off' || v === 'false' || v === 'none') return null;
  return Number(v) | 0;
}

// ---------------------------------------------------------------- session
/**
 * Launch a browser session on the built game.
 * opts: { file='knights_out_final.html', query='debug=1', headless=true,
 *         viewport={width:1280,height:720}, virtualClock=true, seed=1337 (null = real Math.random),
 *         scenario='session' }
 * Returns { page, browser, server, url, errors, warnings, close(), h }
 *   errors   : console.error / pageerror / crashed / failed local requests (should be empty)
 *   warnings : console.warn, blocked external requests
 */
export async function launch(opts = {}) {
  const {
    file = 'knights_out_final.html',
    query = 'debug=1',
    headless = true,
    viewport = { width: 1280, height: 720 },
    virtualClock = true,
    seed = 1337,
    scenario = 'session',
    server: sharedServer = null,
  } = opts;

  const pw = loadPlaywright();
  const server = sharedServer || (await startServer());
  let browser;
  const launchOpts = { headless, args: GL_ARGS };
  try {
    browser = await pw.chromium.launch(launchOpts);
  } catch (e) {
    const exe = findChromiumExecutable();
    if (!exe) throw e;
    browser = await pw.chromium.launch({ ...launchOpts, executablePath: exe });
  }
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (seed !== null && seed !== undefined) await context.addInitScript(seedScript(seed));
  if (virtualClock) await context.addInitScript(CLOCK_SCRIPT);
  const page = await context.newPage();

  const errors = [];
  const warnings = [];
  const blocked = new Set();
  const isFavicon = (u = '') => /favicon\.ico/.test(u);

  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''}`));
  page.on('crash', () => errors.push('page crashed'));
  page.on('console', (m) => {
    const t = m.type();
    const loc = m.location() || {};
    if (t === 'error') {
      if (isFavicon(loc.url) || isFavicon(m.text())) return;
      if (/Failed to load resource/.test(m.text()) && blocked.has(loc.url)) return;
      errors.push(`console.error: ${m.text()}${loc.url ? ` (${loc.url.slice(-60)}:${loc.lineNumber})` : ''}`);
    } else if (t === 'warning') {
      warnings.push(`console.warn: ${m.text()}`);
    }
  });
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (isFavicon(u) || blocked.has(u) || u.startsWith('data:') || u.startsWith('blob:')) return;
    errors.push(`requestfailed: ${u.slice(0, 120)} ${r.failure()?.errorText || ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !isFavicon(r.url())) errors.push(`http ${r.status()}: ${r.url().slice(0, 120)}`);
  });

  // CDN three.js -> node_modules/three ; everything else external is blocked.
  const threeRoot = path.join(REPO_ROOT, 'node_modules', 'three');
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, async (route) => {
    const url = route.request().url();
    const m = THREE_CDN.exec(url);
    if (m) {
      const f = path.resolve(threeRoot, m[1]);
      if (f.startsWith(threeRoot + path.sep) && fs.existsSync(f)) {
        return route.fulfill({
          status: 200,
          contentType: f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream',
          headers: { 'access-control-allow-origin': '*' },
          body: fs.readFileSync(f),
        });
      }
      blocked.add(url);
      errors.push(`cdn route miss (not in node_modules/three): ${m[1]}`);
      return route.fulfill({ status: 404, body: 'not found' });
    }
    blocked.add(url);
    warnings.push(`blocked external request: ${url.slice(0, 120)}`);
    return route.abort('blockedbyclient');
  });

  const url = `${server.url}/${file}${query ? '?' + query : ''}`;
  const session = {
    page, browser, context, server, url, errors, warnings, scenario,
    ownsServer: !sharedServer,
    async close() {
      await browser.close().catch(() => {});
      if (!sharedServer) await server.close().catch(() => {});
    },
  };
  session.h = createHelpers(session);
  return session;
}

// ---------------------------------------------------------------- helpers
export function createHelpers(session) {
  const { page, errors, warnings } = session;
  const warned = new Set();
  const warnOnce = (msg) => { if (!warned.has(msg)) { warned.add(msg); warnings.push(msg); (session.printed ||= new Set()).add(msg); console.warn('  [warn] ' + msg); } };
  let shotCounter = 0;

  const h = {
    page, errors, warnings, session,
    get scenario() { return session.scenario; },
    log: (...a) => console.log('  ', ...a),
    warn: warnOnce,
    wait: (ms) => page.waitForTimeout(ms),
    eval: (fn, arg) => page.evaluate(fn, arg),

    /** Navigate and wait until the page reports it is ready to start (assets loaded). */
    async boot({ timeout = 60000 } = {}) {
      const resp = await page.goto(session.url, { waitUntil: 'load', timeout });
      if (!resp || resp.status() >= 400) throw new Error(`boot: ${session.url} -> HTTP ${resp ? resp.status() : 'no response'}`);
      const ready = () => page.evaluate(() => typeof window.THREE !== 'undefined' && !!(window.Game && window.Game.controls) &&
        !!document.getElementById('startBtn') && !/load/i.test(document.getElementById('startBtn').textContent) &&
        !document.getElementById('startBtn').disabled).catch(() => false);
      const t0 = Date.now();
      while (!(await ready())) {
        const waited = Date.now() - t0;
        if (waited > timeout) throw new Error(`boot: game not ready after ${timeout} ms`);
        if (errors.length && waited > 8000) throw new Error(`boot: game never became ready; page errors: ${errors.slice(0, 3).join(' | ').slice(0, 400)}`);
        await page.waitForTimeout(250);
      }
      await h.frames(3);
    },

    /** Click START. Pointer lock may not be granted headless; that is tolerated. */
    async start({ timeout = 15000 } = {}) {
      await page.click('#startBtn', { timeout: 5000 });
      await page.waitForFunction(() => window.__gameStarted === true || getComputedStyle(document.getElementById('lock')).display === 'none',
        null, { timeout });
      await h.frames(3);
      await h.resetView();
      return { pointerLocked: await page.evaluate(() => !!document.pointerLockElement) };
    },

    /** Face -Z, level (the click that grabs pointer lock can leave the camera pitched/yawed). */
    resetView: () => page.evaluate(() => { const g = window.Game; if (g && g.camera) g.camera.rotation.set(0, 0, 0); }),

    /** Wait n animation frames. */
    frames: (n = 2) => page.evaluate((k) => new Promise((res) => { const step = () => (--k <= 0 ? res() : requestAnimationFrame(step)); requestAnimationFrame(step); }), n),

    waitFor: (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }),

    // ---- virtual clock (needs launch({virtualClock:true}), the default)
    pause: () => page.evaluate(() => window.__qaClock && window.__qaClock.pause()),
    resume: () => page.evaluate(() => window.__qaClock && window.__qaClock.resume()),
    timeScale: (s) => page.evaluate((x) => window.__qaClock && window.__qaClock.timeScale(x), s),
    /**
     * Advance game time by `ms` (pauses the clock first), one `step`-ms game frame at a time
     * (default 33 ms; the game caps dt at 100 ms). Deterministic: use before screenshots.
     * Note: setTimeout-driven game logic still runs in real time.
     */
    advance: (ms, step) => page.evaluate(([x, st]) => window.__qaClock && window.__qaClock.advance(x, st), [ms, step]),

    // ---- __dbg access
    hasDbg: () => page.evaluate(() => !!window.__dbg),
    /** Call __dbg[name](...args). Returns undefined (with a one-time warning) if __dbg or the method is missing. */
    async dbg(name, ...args) {
      const r = await page.evaluate(([n, a]) => {
        if (!window.__dbg) return { missing: 'no window.__dbg' };
        if (typeof window.__dbg[n] !== 'function') return { missing: `__dbg.${n} is not a function` };
        const v = window.__dbg[n](...a);
        return { value: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
      }, [name, args]);
      if (r.missing) { warnOnce(`${r.missing}: skipped __dbg.${name}`); return undefined; }
      return r.value;
    },
    godMode: (on = true) => h.dbg('godMode', on),
    freezeAI: (on = true) => h.dbg('freezeAI', on),
    killAll: () => h.dbg('killAll'),
    skipToWave: (n) => h.dbg('skipToWave', n),
    /** Aim the camera at a world point (__dbg.lookAt, or camera.lookAt when __dbg is absent). */
    async lookAt(x, y, z) {
      if (await page.evaluate(() => !!(window.__dbg && window.__dbg.lookAt))) return h.dbg('lookAt', x, y, z);
      await page.evaluate(([a, b, c]) => { const g = window.Game; if (g && g.camera) g.camera.lookAt(a, b, c); }, [x, y, z]);
    },
    state: () => h.dbg('state'),

    /** Compact snapshot of the live enemy list, tolerant of old (mesh.userData.hp) and new (enemy.hp) shapes. */
    enemies: () => page.evaluate(() => {
      const list = (window.Enemies && window.Enemies.list) || [];
      return list.map((e, i) => {
        const m = e.mesh || e;
        const hp = e.hp !== undefined ? e.hp : (m.userData && m.userData.hp);
        const p = m.getWorldPosition ? m.getWorldPosition(new THREE.Vector3()) : m.position;
        return {
          i, type: e.type || (m.userData && m.userData.type) || 'knight', hp,
          maxHp: e.maxHp, dead: !!(e.dead || (m.userData && m.userData.dying)),
          state: e.state, x: p.x, y: p.y, z: p.z,
        };
      });
    }),

    /** Player position + yaw/pitch snapshot. */
    player: () => page.evaluate(() => {
      const g = window.Game; const o = g && g.playerObj; const c = g && g.camera;
      return o ? { x: o.position.x, y: o.position.y, z: o.position.z, hp: g.playerHP, ammo: g.ammo, shots: g.shots,
        yaw: o.rotation.y, pitch: c ? c.rotation.x : null } : null;
    }),

    /**
     * Spawn a knight via __dbg.spawn(type, dist, angleDeg) and return the new enemy's info
     * (the newest entry of Enemies.list). Returns null if __dbg.spawn is unavailable.
     */
    async spawn(type = 'knight', dist = 4, angleDeg = 0) {
      const ret = await h.dbg('spawn', type, dist, angleDeg);
      if (ret === undefined) return null;
      await h.frames(2);
      const p = await h.player();
      const all = (await h.enemies()).filter((e) => !e.dead);
      if (!all.length || !p) return null;
      const d = (e) => Math.hypot(e.x - p.x, e.z - p.z);
      // wave spawns may append other knights; pick the one nearest the requested distance
      all.sort((a, b) => Math.abs(d(a) - dist) - Math.abs(d(b) - dist));
      return { ...all[0], dist: d(all[0]) };
    },

    /** Remember an enemy (from h.enemies/h.spawn) so h.marked() can later read its hp even after the list shifts. */
    mark: (e) => page.evaluate((i) => { window.__qaTarget = window.Enemies && Enemies.list[i]; return !!window.__qaTarget; }, e.i),
    /** { hp, dead, inList } of the enemy remembered by h.mark(). */
    marked: () => page.evaluate(() => {
      const e = window.__qaTarget; if (!e) return null;
      const m = e.mesh || e;
      return {
        hp: e.hp !== undefined ? e.hp : (m.userData && m.userData.hp),
        dead: !!(e.dead || (m.userData && m.userData.dying)),
        inList: !!(window.Enemies && Enemies.list.includes(e)),
        inScene: !!(m.parent),
      };
    }),

    /** Aim the camera at an enemy (from h.spawn/h.enemies) at the given height above its feet. */
    async aimAt(e, height = 1.2) {
      if (!e) return;
      await h.lookAt(e.x, (e.y || 0) + height, e.z);
      await h.frames(2);
    },

    /**
     * Empty the arena and keep it empty: stop the wave spawner (Waves.stop, or the legacy
     * active/respawnPending fields), remove every enemy without going through the kill path
     * (__dbg.clear, else killAll), and freeze AI. Call it before staging a scene.
     */
    async clean() {
      await page.evaluate(() => {
        const W = window.Waves; if (!W) return;
        if (typeof W.stop === 'function') W.stop();
        else { W.active = false; W.respawnPending = 0; if ('pending' in W) W.pending = 0; }
      });
      const cleared = await page.evaluate(() => { if (window.__dbg && typeof __dbg.clear === 'function') { __dbg.clear(); return true; } return false; });
      if (!cleared) await h.dbg('killAll');
      await h.dbg('freezeAI', true);
      await h.frames(2);
    },

    /**
     * Fire the revolver. Tries a synthetic mousedown first (the game only listens while pointer-locked),
     * then falls back to __dbg.fire / Game.tryFire / Player.fire. Returns { fired, method }.
     */
    async fire() {
      const snap = () => page.evaluate(() => ({ ammo: window.Game && Game.ammo, shots: window.Game && Game.shots }));
      const changed = (a, b) => a.ammo !== b.ammo || a.shots !== b.shots;
      const a0 = await snap();
      // Synthetic mousedown/up on the canvas (bubbles to document/window). A real Playwright click while
      // pointer-locked makes Chromium report a huge movementX/Y and spins the camera, so avoid it.
      const dispatched = await page.evaluate(() => {
        const target = document.querySelector('canvas') || document;
        const opts = { button: 0, buttons: 1, bubbles: true, cancelable: true, view: window };
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
        return !!document.pointerLockElement;
      });
      await h.frames(1);
      if (dispatched && changed(a0, await snap())) return { fired: true, method: 'mousedown' };
      const method = await page.evaluate(() => {
        if (window.__dbg && typeof window.__dbg.fire === 'function') { window.__dbg.fire(); return '__dbg.fire'; }
        if (window.Game && typeof Game.tryFire === 'function') { Game.tryFire(); return 'Game.tryFire'; }
        if (window.Game && typeof Game.fire === 'function') { Game.fire(); return 'Game.fire'; }
        if (window.Player && typeof Player.fire === 'function') { Player.fire(); return 'Player.fire'; }
        return null;
      });
      if (!method) return { fired: false, method: null };
      await h.frames(1);
      return { fired: changed(a0, await snap()), method };
    },

    // ---- screenshots
    /**
     * Save tools/qa/out/<scenario>.png (first call), <scenario>-2.png, ... or
     * <scenario>-<label>.png when a label is given. Returns the absolute path.
     */
    async shot(label, opts = {}) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      shotCounter++;
      const base = session.scenario;
      const name = label !== undefined && label !== null && label !== '' ? `${base}-${label}` : shotCounter === 1 ? base : `${base}-${shotCounter}`;
      const file = path.join(OUT_DIR, `${name}.png`);
      await page.screenshot({ path: file, ...opts });
      h.log('saved ' + path.relative(REPO_ROOT, file));
      return file;
    },

    /** Mean luminance (0-255) and the fraction of non-near-black pixels of a PNG/Buffer. Detects "all black" renders. */
    async imageStats(buf) {
      const b64 = Buffer.from(buf).toString('base64');
      return page.evaluate(async (data) => {
        const blob = await (await fetch('data:image/png;base64,' + data)).blob();
        const bmp = await createImageBitmap(blob);
        const w = 160, hh = Math.max(1, Math.round(160 * bmp.height / bmp.width));
        const c = document.createElement('canvas'); c.width = w; c.height = hh;
        const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0, w, hh);
        const px = ctx.getImageData(0, 0, w, hh).data;
        let sum = 0, lit = 0; const buckets = new Set();
        for (let i = 0; i < px.length; i += 4) {
          const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          sum += l; if (l > 24) lit++;
          buckets.add((px[i] >> 4) << 8 | (px[i + 1] >> 4) << 4 | (px[i + 2] >> 4));
        }
        const n = px.length / 4;
        return { meanLum: sum / n, litFraction: lit / n, colors: buckets.size };
      }, b64);
    },
  };
  return h;
}

/** Print collected errors/warnings; returns the error count. */
export function reportErrors(session, { label = '' } = {}) {
  const { errors, warnings } = session;
  const fresh = warnings.filter((w) => !(session.printed && session.printed.has(w)));
  if (fresh.length) {
    const uniq = [...new Set(fresh)];
    console.log(`${label}${uniq.length} warning(s):`);
    uniq.slice(0, 10).forEach((w) => console.log('   - ' + w.slice(0, 200)));
  }
  if (errors.length) {
    console.log(`${label}${errors.length} error(s):`);
    errors.slice(0, 15).forEach((e) => console.log('   ! ' + e.slice(0, 300)));
  }
  return errors.length;
}

/** Tiny arg parser: positional args + --key=value / --flag. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

export function parseViewport(str, fallback = { width: 1280, height: 720 }) {
  const m = /^(\d+)x(\d+)$/.exec(str || '');
  return m ? { width: +m[1], height: +m[2] } : fallback;
}
