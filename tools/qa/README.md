# tools/qa - Playwright harness

Headless Chromium (swiftshader WebGL) against the built `knights_out_final.html`.
Everything runs offline: a local static server serves the repo root, and requests to
`https://cdn.jsdelivr.net/npm/three@0.147.0/**` are answered from `node_modules/three/**`
(any other external request is blocked and reported as a warning).

Setup (once): `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i` - uses the pre-installed
Chromium in `/opt/pw-browsers`. Never run `playwright install`.

```
npm run build                    # node tools/build.mjs  -> knights_out_final.html
npm run qa                       # smoke test, exit 1 on failure
npm run shots -- --list          # list scenarios
npm run shots -- gun-fire knight-close   # PNGs -> tools/qa/out/<scenario>[-label].png
npm run shots -- --all
node tools/qa/serve.mjs 8080     # just serve the repo (CDN not routed)
```

Flags (smoke and shoot): `--file=knights_out_final.html`, `--query=debug=1`, `--viewport=1280x720`
(smoke defaults to 960x540), `--seed=N|off` (seeded `Math.random`, default 1337, so the world is
identical every run), `--headed`; shoot also has `--strict` (exit 1 if the page logged errors).

**Always open the PNGs** (Read tool) - a passing run only proves nothing threw.

## Smoke test (`smoke.mjs`)
boot, no console/page errors, WebGL canvas, START click (pointer lock is granted headless, but
failure is tolerated), wave spawns, frame is not black, then (needs `?debug=1` `__dbg`) spawn a
knight 4 m ahead, aim, fire, assert it lost HP / died / left the list, `__dbg.state()`, and no
console errors for the whole run. `__dbg` checks degrade to SKIP with a warning when missing.
Prints `SMOKE PASS|FAIL`.

## Adding a screenshot scenario
Edit `scenarios.mjs`; the doc comment at its top lists the helper API:

```js
'knight-side': {
  desc: 'Knight seen from 3 m to the right',
  run: async (page, h) => {
    await h.clean();                       // stop waves, remove enemies, freeze AI
    const k = await h.spawn('knight', 3, 90);
    await h.aimAt(k, 1.1);
    await h.pause(); await h.advance(500); // settle animations deterministically
    await h.shot();                        // -> out/knight-side.png (h.shot('x') -> out/knight-side-x.png)
    return k;                              // printed as JSON
  },
},
```
A scenario may also be a bare `async (page, h) => {}`. Options: `start:false` (title screen),
`god:false`, `viewport`, `query`.

## Timing notes
- Swiftshader renders only ~5-10 fps, so real-time waits are useless for animation frames.
  `lib.mjs` injects a virtual `performance.now` (THREE.Clock and dt-based game code follow it):
  `h.pause()`, `h.advance(ms)` (one game frame per rendered frame while paused), `h.resume()`,
  `h.timeScale(s)`. `setTimeout`-driven game logic is NOT virtualised.
- `h.fire()` dispatches a synthetic `mousedown` on the canvas (a real Playwright click while
  pointer-locked spins the camera), then falls back to `__dbg.fire` / `Game.tryFire`.
- Console errors, page errors, failed or 4xx/5xx local requests are collected in `session.errors`.

## Audio check (`audio-check.mjs`, `npm run audio`)
Headless runs cannot be listened to, so every `Sfx` sound is rendered into an `OfflineAudioContext` (through `Sfx._useContext`) and measured:
not silent, peak below 1.0, a 60-sound pile-up that does not clip, distance falloff, HRTF left/right placement, mute, volume + `localStorage`,
and that nothing throws when `AudioContext` does not exist. Prints a PASS/FAIL table and exits 1 on any failure. It proves the sounds are
present and bounded, not that they sound good.
