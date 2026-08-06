// Trading soak — hammer one market from many accounts at once, then prove
// the money. The verdict is not throughput: it is CONSERVATION. Credits in
// the system must equal credits granted, exactly, after every storm.
//
//   node tools/soak.js                 # in-process node, throttles lifted
//   node tools/soak.js <url> --live    # gentle fire at a running node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE = process.argv.includes('--live');
const urlArg = process.argv.slice(2).find((a) => a.startsWith('http'));
const jsonH = { 'content-type': 'application/json' };
const say = (s) => console.log(s);
let failures = 0;
const check = (ok, msg) => { if (!ok) { failures += 1; say(`  ✗ ${msg}`); } return ok; };

const batches = async (n, size, fn) => {
  const out = [];
  for (let i = 0; i < n; i += size) {
    out.push(...await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, j) => fn(i + j))));
  }
  return out;
};

async function run(base, { heavy }) {
  const post = (p, body, extra = {}) => fetch(base + p, {
    method: 'POST', headers: { ...jsonH, origin: base, ...extra }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) }));
  const get = (p, extra = {}) => fetch(base + p, { headers: { origin: base, ...extra } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  async function account(name) {
    let r = await post('/api/register', { username: name, password: 'soak-pass-1234' });
    if (r.status === 409) r = await post('/api/login', { username: name, password: 'soak-pass-1234' });
    if (!r.body.token) throw new Error(`${name}: ${r.body.error}`);
    const s = await post('/api/session', {}, { authorization: `Bearer ${r.body.token}` });
    const cookie = (s.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) throw new Error(`${name}: no session (${s.status})`);
    return { agent: r.body.agent, cookie };
  }

  const N = heavy ? 16 : 4;
  const t0 = Date.now();
  const users = await batches(N, 8, (i) => account(`soaker${i}`));
  say(`  ${N} accounts in ${Date.now() - t0}ms`);

  const granted = (await get('/api/stats')).body.creditsInSystem;

  // One hot market, everybody trading it at once — the contended path.
  const oracle = users[0];
  const created = await post('/api/markets', {
    title: `Soak market ${Date.now()}`, category: 'Soak', outcomes: ['Yes', 'No', 'Maybe'],
    closesAt: new Date(Date.now() + 3 * 864e5).toISOString(), b: 60,
  }, { cookie: oracle.cookie });
  if (!check([200, 201].includes(created.status), `create failed: ${JSON.stringify(created.body)}`)) return;
  const list = await get('/api/markets?category=soak');
  const id = (created.body.market || list.body.markets[0]).id;

  // Traders (not the oracle — the engine forbids self-trading).
  const traders = users.slice(1);
  const ROUNDS = heavy ? 240 : 24;
  const t1 = Date.now();
  const trades = await batches(ROUNDS, heavy ? 24 : 6, (i) => {
    const u = traders[i % traders.length];
    return post(`/api/markets/${id}/trade`,
      { side: 'buy', outcome: i % 3, spend: 1 + (i % 4) }, { cookie: u.cookie });
  });
  const ok = trades.filter((r) => r.status === 200).length;
  say(`  ${ROUNDS} parallel trades: ${ok} filled, ${ROUNDS - ok} refused · ${(ROUNDS * 1000 / (Date.now() - t1)).toFixed(0)} ops/s`);

  // Sells interleaved with buys — the path where rounding could leak.
  const sells = await batches(heavy ? 60 : 8, 8, async (i) => {
    const u = traders[i % traders.length];
    const meRes = await get('/api/me', { cookie: u.cookie });
    const pos = (meRes.body.positions || []).find((p) => p.market === id && (p.shares || []).some((s) => s > 0));
    if (!pos) return null;
    const outcome = pos.shares.findIndex((s) => s > 0);
    return post(`/api/markets/${id}/trade`,
      { side: 'sell', outcome, shares: Math.max(0.5, pos.shares[outcome] / 4) }, { cookie: u.cookie });
  });
  say(`  ${sells.filter(Boolean).length} parallel sells attempted`);

  // Idempotency under concurrency: the same key fired many times must
  // produce exactly one trade.
  const key = `soak-${Date.now()}`;
  const dup = await Promise.all(Array.from({ length: 8 }, () => post(`/api/markets/${id}/trade`,
    { side: 'buy', outcome: 0, spend: 3 }, { cookie: traders[0].cookie, 'idempotency-key': key })));
  const applied = dup.filter((r) => r.status === 200).length;
  check(applied === 8 || applied === 1,
    `idempotency-key replay: ${applied} of 8 succeeded (expect 1 applied, or 8 identical replays)`);
  const bodies = new Set(dup.filter((r) => r.status === 200).map((r) => JSON.stringify(r.body.trade || r.body)));
  check(bodies.size <= 1, `an idempotency key returned ${bodies.size} DIFFERENT results`);
  say(`  idempotent replay x8: ${applied} ok, ${bodies.size} distinct outcome(s)`);

  // The verdict.
  const after = (await get('/api/stats')).body.creditsInSystem;
  const expected = granted + 0; // no grants during trading; grants only on first touch
  check(Math.abs(after - expected) < 1e-9,
    `CONSERVATION BROKEN: ${after} credits in system, expected ${expected}`);
  say(`  conservation: ${after} credits in system (expected ${expected}) ${Math.abs(after - expected) < 1e-9 ? '✓' : '✗'}`);
  return true;
}

if (LIVE) {
  const base = (urlArg || 'http://localhost:3490').replace(/\/$/, '');
  say(`\n— live soak (light): ${base} —`);
  await run(base, { heavy: false });
} else {
  process.env.SCRY_REGISTER_PER_HOUR = '100000';
  process.env.SCRY_LOGIN_PER_15MIN = '100000';
  const { createSite } = await import('../server.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-soak-'));
  const site = await createSite({ dataDir, rateCapacity: 100000, rateRefillPerSec: 10000 });
  const { port } = await site.listen(0, '127.0.0.1');
  say(`\n— heavy soak: local node on ${port} —`);
  await run(`http://127.0.0.1:${port}`, { heavy: true });
  await site.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures) { say('\nSOAK FAILED'); process.exit(1); }
say('\nSOAK PASSED — trades filled concurrently, books conserved exactly');
