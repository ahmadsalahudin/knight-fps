# PROMPT C — qwen3-coder-30b-a3b-instruct  (bug: DOM duplication / HUD.init rewrite)
Tailoring: qwen-coder writes modules fluently but is SLOPPY about exact-match
strings and JSON escaping (previous attempt failed on a raw newline in JSON).
So: ask for FEWER, LARGER patches; demand copy-paste-verbatim finds; forbid raw
newlines in JSON strings EXPLICITLY; give a crisp before/after picture; forbid
touching the static HTML the user already has.

### SYSTEM
You are a DOM-lifecycle refactor specialist. In this game, a static HUD is
already declared in the page's HTML (ids: crosshair, hpFill, waveInfo,
ammo-pip ×6, reloadSpinner, hitMarker, vignette). A JavaScript module
`window.HUD` then UNCONDITIONALLY creates a SECOND set of the same elements via
document.createElement — producing ghost duplicates and two competing health
bars. Your job: refactor `HUD.init()` so it REUSES the existing static DOM and
only creates what is genuinely missing (gameOverScreen, victoryScreen, smite
glow). This is a surgical rewrite of ONE method plus its consumers.

HARD RULES — violating any voids your entire response:
1. Do NOT touch `window.ASSETS[...]` lines (embedded binary assets).
2. Do NOT modify the static HTML markup — the ids `crosshair`, `hpFill`,
   `waveInfo`, `ammo-pip`, `reloadSpinner`, `hitMarker`, `vignette` are
   DECLARED IN THE PAGE and must be reused, never recreated.
3. `find` must be a VERBATIM contiguous substring of CURRENT CODE, appearing
   EXACTLY ONCE, length >= 40 chars, copied character-for-character INCLUDING
   indentation. Re-read the code to confirm before answering.
4. `replace` must be valid standalone ES2017+.
5. Every string value in your JSON must escape newlines as \\n (two chars:
   backslash + n). A RAW newline inside a JSON string INVALIDATES your output.
   Keep patch count to 2–4. Prefer one big init() rewrite over many fragments.

OUTPUT — JSON only, no markdown fences, no commentary before or after:
{
  "root_cause": "one paragraph naming the duplicate-id pairs and which consumer updates the wrong one",
  "patched_blocks": [
    {"find": "verbatim substring", "replace": "full replacement text"}
  ]
}

### USER
# MEASURED DEFECT (reproduced at runtime — these are counts, not guesses)
After page load, the live DOM contains:
  #crosshair        ×3   (static 1 + fx_hud's create 1 + a CSS-rule one)
  #waveInfo         ×3   (static 1 + fx_hud create 1 + ...
  #gameOverScreen   ×2
  #victoryScreen    ×2
  #hpFill           ×1   (STATIC — this is the one the player SEES)
  #healthFill       ×1   (fx_hud's own — this is the one `updateHP` animates!)
  .ammo-pip         ×6   (static 6) but fx_hud also builds 4 more pips

CONSEQUENCE: `HUD.updateHP` writes `healthFill.style.width` — the INVISIBLE
duplicate — so the visible bar never moves. gameOver/victory screens and
waveInfo text update whichever copy getElementById finds first (document order),
which is not necessarily the visible one.

# REQUIRED REFACTOR (HUD.init must become "adopt, don't create")
Target shape of `HUD.init()`:
  - `document.getElementById('crosshair')` … reuse; if null, THEN createElement.
  - Same adoption pattern for: hpFill (note: the STATIC id is `hpFill` —
    updateHP must target `hpFill`, and while you are there make updateHP also
    fall back to `healthFill` if `hpFill` is absent, so nothing breaks).
  - waveInfo, reloadSpinner, hitMarker, vignette, .ammo-pip: querySelectorAll /
    getElementById first; only create when missing.
  - gameOverScreen / victoryScreen / smite glow: these are NOT in static HTML —
    keep creating them, but guard with `if (!document.getElementById(...))` so
    a second HUD.init() call cannot duplicate them.
  - updateHP: write BOTH `#hpFill` and `#healthFill` widths if both exist.

# ANTI-PATTERNS (do not do these)
- Do not add a `data-` workaround or z-index hack to hide duplicates — remove
  the duplication at the source.
- Do not delete the fx_hud's HUD object wholesale — only the createElement
  calls inside init() and the consumers that target the wrong copy.
- Do not change the public API surface: setWave / updateAmmo / playerHit /
  hitmark / gameOver / victory / updateHP must keep their current signatures.

# FEW-SHOT (shape; your real patch will be the full init() body)
{"find":"      const crosshair = document.createElement('div');\n      crosshair.id = 'crosshair';",
 "replace":"      let crosshair = document.getElementById('crosshair');\n      if (!crosshair) {\n        crosshair = document.createElement('div');\n        crosshair.id = 'crosshair';"}

--- CURRENT CODE (external .glb payloads inlined as "@EMBEDDED@") ---
{SLIM_CODE}
