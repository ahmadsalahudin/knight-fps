# Knights of the Meadow — Browser FPS

A 3D first-person shooter built with **three.js**, starring fully-armoured knights
(chained Quaternius CC0 GLB models) attacking a player holding a revolver — with a
giant boss on Wave 5 — all playable directly in a browser in a single self-contained
HTML file.

Free to play. No build step. Just npm, python, and a terminal.

---

## Quick Start

```bash
# from the repo root
python -m http.server 8877
# → http://127.0.0.1:8877/knights_out_final.html
```

**Controls:** WASD mouse aim · Shift sprint · LMB fire · R reload · FE (number keys 1–3) scroll weapon swap.

**Goal:** wave survival with progressive difficulty; defeat the Boss at Wave 5.

---

## The real game engine (architecture)

| Module | Source | Responsibility |
|---|---|---|
| `Assets` | hand-written | Custom GLB binary — THREE.GLTFLoader-independent — parses embedded base64 Quaternius meshes (rebased & normalized), cached |
| `World` | hand-written | Grassy-meadow arena: ground plane, grass scatters, trees, rocks, rock-ring bounds, collision colliders, directional + hemisphere lights |
| `AI` | qwen3-coder-30b output | Knight + Boss classes with attack-swing / shield / sequence state machine, wave spawner (full-armor Quaternius models) |
| `Game/Player` | hand-written | Player controller (PointerLockControls), revolver viewmodel (vision-verified euler + SPEC viewmodel offset), semi-auto fire+reload, melee+projectile hit scan |
| `HUD / Sfx / Smite` | qwen3-coder-30b output | Health bar, ammo pips, wave banner, game-over screen, WebAudio synthetic sfx, holy-smite pick-up (signature power-up) |
| `Bootstrap` | hand-written | scene/renderer/game loop wiring |

All 3D content (revolver, armor, helmets, shields, trees, rocks, grass) is embedded
**base64 GLB** data from the [Quaternius] CC0/free Creative Commons pack — download,
pack to `embed_bed64`, no external network calls besides the three.js CDN.

---

## The Build Pipeline & QA

This game was built with **pre-computed prompt bars** — a design pipeline that
uses a decision model (Jev) to choose aesthetics and gameplay from typed
multiple-choice questions answered in milliseconds, then a coder-agent panel
(`kimi-k2.7-code`, `deepseek-v4.1-flash`, `qwen3-coder-30b`) writes modules in
parallel, verified through exact find/replace patches and re-tested in a
**Playwright QA harness** (13 automated checks: full load, spawn, movement,
shooting, game-over) AND a **vision QA harness** (gemma-4-31b-it compares
rendered pixels against golden reference images gives pixel-level proof).
Ten: zero rendering culling bugs, robot legs asleep.

---

## Security Warning

Do not commit real API keys here. All AI/fetch code uses `sk-REPLACE-ME-GET-YOUR-OWN-KEY`
placeholders — `skb_neo/...`whatever your own keys are, fill in local scripts or
use an `.env` file excluded by gitignore. Ship+replace before deploying.

---

## Credits

* 3D models: [Quaternius] CC0 assets (knights, weapon, nature) — shuffle patterns hardcoded in this app
* Motivic types, AI code writing: Jev, Qwen3-coder (sovereigneg API), Kimi (moonshot API), DeepSeek (fibo), Gemma-4-vision