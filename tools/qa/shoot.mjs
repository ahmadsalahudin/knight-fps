// Screenshot runner.  node tools/qa/shoot.mjs <scenario> [...scenario] [--all] [--list]
//   [--file=knights_out_final.html] [--query=debug=1] [--viewport=1280x720] [--seed=1337|off] [--headed] [--strict]
// PNGs land in tools/qa/out/ (gitignored). Scenarios live in tools/qa/scenarios.mjs.
// Exit code 1 if any scenario throws (or, with --strict, if the page logged console/page errors).
import path from 'node:path';
import { launch, parseArgs, parseViewport, parseSeed, reportErrors, REPO_ROOT } from './lib.mjs';
import { startServer } from './serve.mjs';
import { scenarios } from './scenarios.mjs';

const args = parseArgs(process.argv.slice(2));
const normalize = (name, def) => (typeof def === 'function' ? { desc: '', run: def } : def);

if (args.list || (!args._.length && !args.all)) {
  console.log('usage: node tools/qa/shoot.mjs <scenario> [...] [--all] [--viewport=WxH] [--file=...] [--query=...] [--headed] [--strict]\n');
  console.log('scenarios:');
  for (const [name, def] of Object.entries(scenarios)) console.log(`  ${name.padEnd(14)} ${normalize(name, def).desc || ''}`);
  process.exit(args.list ? 0 : 2);
}

const names = args.all ? Object.keys(scenarios) : args._;
const unknown = names.filter((n) => !scenarios[n]);
if (unknown.length) { console.error(`unknown scenario(s): ${unknown.join(', ')}  (try --list)`); process.exit(2); }

const server = await startServer();
let failed = 0, errorCount = 0;
for (const name of names) {
  const def = normalize(name, scenarios[name]);
  console.log(`\n== ${name}${def.desc ? ' - ' + def.desc : ''}`);
  const s = await launch({
    scenario: name,
    server,
    file: args.file || 'knights_out_final.html',
    query: def.query ?? (args.query === undefined ? 'debug=1' : args.query === true ? '' : args.query),
    viewport: def.viewport || parseViewport(args.viewport),
    headless: !args.headed,
    seed: parseSeed(args.seed),
  });
  const timer = setTimeout(() => { console.error(`   scenario ${name} timed out (180 s)`); s.close().finally(() => process.exit(1)); }, 180000);
  try {
    await s.h.boot();
    if (def.start !== false) {
      await s.h.start();
      if (def.god !== false) await s.h.godMode(true);
    }
    const result = await def.run(s.page, s.h);
    if (result !== undefined && result !== null) console.log('   result:', JSON.stringify(result).slice(0, 4000));
  } catch (e) {
    failed++;
    console.error(`   FAILED: ${e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`);
  } finally {
    clearTimeout(timer);
    errorCount += reportErrors(s, { label: '   ' });
    await s.close();
  }
}
await server.close();
console.log(`\n${names.length - failed}/${names.length} scenario(s) ok; PNGs in ${path.relative(REPO_ROOT, path.join('tools', 'qa', 'out'))}/`);
process.exit(failed || (args.strict && errorCount) ? 1 : 0);
