// Review sheet for the first-person revolver + hands: one PNG with six panels.
//   node tools/qa/gunshot.mjs [outPrefix]          (default tools/qa/out/gun)  -> <outPrefix>-grid.png (+ the single panels)
// Panels: 1 first-person idle, 2 left profile without hands (compare with a side photo of the gun), 3 right 3/4 close-up with
// the hand, 4 first-person 30 ms after a shot, 5 reload: cylinder out / empties, 6 reload: speedloader at the chambers.
// Needs a fresh `npm run build`. Prints page errors (if any) as JSON on the last line.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, parseSeed, OUT_DIR } from './lib.mjs';

const out = process.argv[2] || path.join(OUT_DIR, 'gun');
const s = await launch({ scenario: 'gunshot', file: 'knights_out_final.html', query: 'debug=1', viewport: { width: 1280, height: 720 }, headless: true, seed: parseSeed('1337') });
const { page, h, errors } = s;
await h.boot(); await h.start(); await h.clean(); await h.resetView(); await h.pause(); await h.advance(400);
const files = [];
const shot = async (name, clip) => { const f = `${out}-${name}.png`; await page.screenshot({ path: f, clip }); files.push(f); };
const FP = { x: 400, y: 200, width: 880, height: 520 };
const VIEW = { x: 160, y: 40, width: 960, height: 640 };
// gun-space point -> world, for the debug camera
const gunPt = (x, y, z) => page.evaluate(([x, y, z]) => { Weapon.gunPivot.updateMatrixWorld(true); return Weapon.gunPivot.localToWorld(new THREE.Vector3(x, y, z)).toArray(); }, [x, y, z]);
const view = async (eye, at) => { await page.evaluate(([e, a]) => __dbg.weapon.view(e[0], e[1], e[2], a[0], a[1], a[2]), [eye, at]); await h.advance(16); };

await shot('1-fp', FP);
// 2: left profile, hands hidden (the reference photo shows the gun's left side, muzzle to the left)
await page.evaluate(() => { Weapon.handR.visible = false; });
const mid = await gunPt(0, 0.0, -0.11);
await view([mid[0] - 0.40, mid[1] + 0.01, mid[2]], mid);
await shot('2-left-profile', VIEW);
await page.evaluate(() => { Weapon.handR.visible = true; });
// 3: right 3/4 close-up with the hand
const grip = await gunPt(0, 0.0, -0.04);
await view([grip[0] + 0.22, grip[1] + 0.08, grip[2] - 0.16], grip);
await shot('3-right-34', VIEW);
await page.evaluate(() => __dbg.weapon.view());
await h.advance(16);
// 4: a shot
await h.fire(); await h.advance(30);
await shot('4-fire', FP);
await h.advance(600);
// 5 / 6: reload
await page.evaluate(() => { Game.ammo = 0; Game.tryReload(); });
await h.advance(600);
await shot('5-reload-eject', FP);
await h.advance(320);
await shot('6-reload-loader', FP);

execFileSync('python3', ['-I', '-c', `
import sys
from PIL import Image
fs = sys.argv[2:]; ims = [Image.open(f).convert('RGB') for f in fs]
w = max(i.width for i in ims); hh = max(i.height for i in ims)
g = Image.new('RGB', (w * 2, hh * 3), (24, 24, 24))
for k, i in enumerate(ims): g.paste(i.resize((w, hh)), ((k % 2) * w, (k // 2) * hh))
g.thumbnail((1500, 1500)); g.save(sys.argv[1])
`, out + '-grid.png', ...files]);
console.log(out + '-grid.png');
console.log(JSON.stringify(errors || []));
process.exit(0);
