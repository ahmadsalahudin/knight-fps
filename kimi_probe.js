// probe kimi-k3 400 reason via direct fetch with requestid resume
async function probe() {
  const base = 'https://backend.sovereigneg.com/v1';
  const key = 'sk-REPLACE-ME-GET-YOUR-OWN-KEY';
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'Reply with just: ok' }], max_tokens: 10 }),
  });
  const status = res.status;
  const body = await res.text();
  console.log.status;
  console.log('resolved: ', status);
  if (!res.ok) return 'fail';
  console.log('all good');
}
probe();
