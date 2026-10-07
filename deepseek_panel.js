/**
 * Deepseek fan-out pane: 3 parallel deepseek-v4.1-flash agents, one per defect,
 * each writing a surgical patch; caller reviews verdicts.
 * Usage: node deepseek_panel.js
 */
const fs = require('fs');
const BASE = 'https://backend.sovereigneg.com/v1';
const KEY = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';

const code = fs.readFileSync('knights_out_final.html', 'utf8')
  // keep payload small for the fan-out agents: strip the giant ASSETS values
  .replace(/window\.ASSETS\["[^"]+"\] = "data:model\/gltf-binary;base64,[^"]+"/g,
           'window.ASSETS["<name>"] = "<embedded>";');

const ISSUES = {
  spawn: `DEFECT: The user reports enemies sometimes STOP spawning in real browsers (worked before; broke again after last patch round). In headless QA they do spawn (count=5, wave active). Diagnose race/timing/state bugs in void接下来的 Waves.start / Waves.update / Waves.spawn / respawnPending / setTimeout chains that could suppress spawning in real Chrome/Brave/Firefox. Return JSON only: {"root_cause": str, "patched_blocks": [{"find": "unique exact JS substring from FILE", "replace": "full corrected block"}]}`,
  gun: `DEFECT: The revolver viewmodel currently points UP (barrel visible aiming at the sky) instead of forward. Current base euler on gunRig is rotation.set(Math.PI/2, Math.PI/2 + Math.PI/4, 0) applied to a group whose child is the revolver GLB (Quaternius, model axes unknown). Using only reasoning over the code (no vision), produce the euler you believe makes the muzzle aim along camera forward (-Z), grip toward the bottom-right. Show your axis reasoning in root_cause. Return JSON only: {"root_cause": "axis reasoning", "patched_blocks": [{"find": "unique exact substring", "replace": "block"}]}`,
  stuck: `DEFECT: Player movement occasionally pins/sticks (user reported). Collider clamp currently may fight input. Return JSON only: {"root_cause": str, "patched_blocks": [{"find": "unique substring", "replace": "block"}]} if any fix is warranted.`,
};

async function callAgent(name, issue) {
  const payload = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'You are a precise browser-game repair agent. Return ONLY valid JSON.' },
      { role: 'user', content: issue + '\n\nFILE:\n' + code },
    ],
  };
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  if (!j.choices) return { agent: name, error: JSON.stringify(j).slice(0, 300) };
  let raw = j.choices[0].message.content;
  try {
    const obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return { agent: name, ...obj };
  } catch (e) {
    return { agent: name, error: 'json parse fail: ' + raw.slice(0, 200) };
  }
}

(async () => {
  const results = await Promise.all(Object.entries(ISSUES).map(([k, v]) => callAgent(k, v)));
  fs.writeFileSync('panel_report.json', JSON.stringify(results, null, 1));
  for (const r of results) {
    console.log('=== AGENT:', r.agent, '===');
    console.log('root_cause:', (r.root_cause || r.error || '').toString().slice(0, 400));
    console.log('patches:', (r.patched_blocks || []).length, JSON.stringify(r.patched_blocks || []).slice(0, 300));
    console.log('');
  }
})();
