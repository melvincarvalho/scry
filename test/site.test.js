// scry site integration — the standalone host wrapping the markets engine.
//
// The engine's 75-test suite lives with the engine (jss-plugins/markets);
// these tests cover what SCRY adds: accounts (register/login/throttle),
// agent URIs that dereference, the bearer→session exchange against host-
// minted tokens, and a full news-market lifecycle driven through the host
// (create with category → trade → leaderboard → conservation).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSite } from '../server.js';

const jsonH = { 'content-type': 'application/json' };
// Cookie'd (ambient) requests must look like a browser: the engine's CSRF
// guard refuses them without an Origin/Sec-Fetch-Site same-origin signal.
const post = (base, p, body, extra = {}) => fetch(base + p, {
  method: 'POST', headers: { ...jsonH, origin: base, ...extra }, body: JSON.stringify(body),
});
const get = (base, p, extra = {}) => fetch(base + p, { headers: { origin: base, ...extra } });

describe('scry site', () => {
  let site; let base; let dataDir;
  const users = {}; // name → {agent, token, cookie}

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-'));
    // The suite deliberately hammers auth from one address; raise the engine's
    // token bucket so its limiter doesn't mask the behaviour under test.
    site = await createSite({ dataDir, grantCredits: 1000, rateCapacity: 5000, rateRefillPerSec: 500 });
    const { port } = await site.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    if (site) await site.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function signup(name) {
    const reg = await post(base, '/api/register', { username: name, password: 'test-pass-1234' });
    assert.strictEqual(reg.status, 201, await reg.clone().text());
    const { agent, token } = await reg.json();
    const sess = await post(base, '/api/session', {}, { authorization: `Bearer ${token}` });
    assert.strictEqual(sess.status, 200, await sess.clone().text());
    const cookie = (sess.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, 'session sets an HttpOnly cookie');
    users[name] = { agent, token, cookie };
    return users[name];
  }

  it('registers accounts; the agent URI dereferences', async () => {
    const oracle = await signup('oracle');
    assert.strictEqual(oracle.agent, `${base}/u/oracle#me`);
    const prof = await (await fetch(`${base}/u/oracle`)).json();
    assert.strictEqual(prof['@id'], oracle.agent);
    assert.strictEqual((await post(base, '/api/register', { username: 'oracle', password: 'test-pass-1234' })).status, 409);
    assert.strictEqual((await post(base, '/api/login', { username: 'oracle', password: 'wrong-pass-1' })).status, 401);
  });

  it('a session grants the 1,000 paper credits', async () => {
    const me = await (await get(base, '/api/me', { cookie: users.oracle.cookie })).json();
    assert.strictEqual(me.balance, 1000);
  });

  it('creates a categorized news market and trades it', async () => {
    await signup('punter');
    const closesAt = new Date(Date.now() + 7 * 864e5).toISOString();
    const create = await post(base, '/api/markets', {
      title: 'Will it rain on the parade?', category: 'News',
      outcomes: ['Yes', 'No'], closesAt, b: 40,
    }, { cookie: users.oracle.cookie });
    assert.ok([200, 201].includes(create.status), await create.clone().text());
    const market = (await create.json()).market || (await (await fetch(`${base}/api/markets?category=news`)).json()).markets[0];
    assert.ok(market.id, 'market created');
    assert.strictEqual(market.category, 'News');

    // the oracle may NOT trade its own market; the punter may
    const own = await post(base, `/api/markets/${market.id}/trade`,
      { side: 'buy', outcome: 0, spend: 10 }, { cookie: users.oracle.cookie });
    assert.ok(own.status >= 400, 'creator/oracle trading own market is refused');
    const quote = await (await get(base, `/api/markets/${market.id}/quote?side=buy&outcome=0&spend=10`, { cookie: users.punter.cookie })).json();
    assert.ok(quote.shares > 0, `quote works: ${JSON.stringify(quote)}`);
    const trade = await post(base, `/api/markets/${market.id}/trade`,
      { side: 'buy', outcome: 0, spend: 10 }, { cookie: users.punter.cookie });
    assert.strictEqual(trade.status, 200, await trade.clone().text());
    const me = await (await get(base, '/api/me', { cookie: users.punter.cookie })).json();
    assert.ok(me.balance < 1000, 'stake left the balance');
    assert.ok(me.positions.length >= 1, 'position recorded');
  });

  it('leaderboard: signed-in only, pseudonymized rivals, you are you', async () => {
    assert.strictEqual((await fetch(`${base}/api/leaderboard`)).status, 401, 'anonymous refused');
    const board = await (await get(base, '/api/leaderboard', { cookie: users.punter.cookie })).json();
    assert.ok(board.leaderboard.length >= 2);
    const mine = board.leaderboard.find((r) => r.you);
    assert.ok(mine, 'your own row is identified');
    for (const row of board.leaderboard) {
      if (!row.you) assert.match(row.agent, /^anon-/, 'rivals are pseudonyms, not identities');
    }
  });

  it('conservation holds through everything', async () => {
    const stats = await (await fetch(`${base}/api/stats`)).json();
    assert.strictEqual(stats.creditsInSystem, 2000, 'two grants, exactly — nothing minted or lost');
  });

  // ---- round 1: the security review's findings, each pinned ----------------
  it('inherited object keys are not accounts (constructor is a miss, not a hit)', async () => {
    assert.strictEqual((await fetch(`${base}/u/constructor`)).status, 404, 'no phantom profile');
    const reg = await post(base, '/api/register', { username: 'constructor', password: 'test-pass-1234' });
    assert.strictEqual(reg.status, 201, 'a legitimate name is not permanently 409ed by the prototype');
  });

  it('an unknown username costs the same as a known one (no enumeration oracle)', async () => {
    const time = async (username) => {
      const t0 = process.hrtime.bigint();
      await post(base, '/api/login', { username, password: 'definitely-wrong-pass' });
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const known = await time('punter');
    const unknown = await time('nobody-here-at-all');
    // Both run scrypt; the ratio stays well inside noise (a fast-path miss
    // would be ~20x quicker).
    assert.ok(unknown > known / 4, `unknown ${unknown.toFixed(1)}ms vs known ${known.toFixed(1)}ms`);
  });

  it('changing the password revokes every existing token', async () => {
    const u = await signup('rotator');
    const before = await fetch(`${base}/api/whoami`, { headers: { authorization: `Bearer ${u.token}` } })
      .then((r) => r.status).catch(() => 0);
    const chg = await post(base, '/api/password', {
      username: 'rotator', password: 'test-pass-1234', newPassword: 'a-brand-new-pass',
    });
    assert.strictEqual(chg.status, 200, await chg.clone().text());
    const { token: fresh } = await chg.json();
    // The OLD bearer can no longer buy a session; the fresh one can.
    const oldSess = await post(base, '/api/session', {}, { authorization: `Bearer ${u.token}` });
    assert.ok(oldSess.status >= 400, `old token revoked (was ${before})`);
    const newSess = await post(base, '/api/session', {}, { authorization: `Bearer ${fresh}` });
    assert.strictEqual(newSess.status, 200, 'the new token works');
    assert.strictEqual((await post(base, '/api/login', { username: 'rotator', password: 'test-pass-1234' })).status, 401,
      'the old password no longer signs in');
  });

  it('topic browse: facets are published and filter the list', async () => {
    const { categories } = await (await get(base, '/api/categories')).json();
    assert.ok(categories.some((c) => c.name === 'News'), `facets: ${JSON.stringify(categories)}`);
    const hit = await (await get(base, '/api/markets?category=news')).json();
    assert.ok(hit.markets.length >= 1, 'filtering by topic returns that topic');
    const miss = await (await get(base, '/api/markets?category=nonexistent-topic')).json();
    assert.strictEqual(miss.markets.length, 0, 'and only that topic');
  });

  it('serves the trading UI at the site root, account form included', async () => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /do-acct-signin/, 'account-mode sign-in form');
    assert.match(html, /Top predictors/, 'leaderboard rail');
    assert.match(html, /id="cats"/, 'topic chips');
    assert.match(html, /og:image/, 'link unfurls');
  });
  it('survives a restart: accounts, ledger, positions and markets all persist', async () => {
    const before = await (await get(base, '/api/stats')).json();
    const myPos = await (await get(base, '/api/me', { cookie: users.punter.cookie })).json();
    assert.ok(myPos.positions.length >= 1, 'there is a position to lose');

    await site.close();
    site = await createSite({ dataDir, grantCredits: 1000, rateCapacity: 5000, rateRefillPerSec: 500 });
    const { port } = await site.listen(0, '127.0.0.1');
    const base2 = `http://127.0.0.1:${port}`;

    // The account still authenticates (host state) …
    const login = await post(base2, '/api/login', { username: 'punter', password: 'test-pass-1234' });
    assert.strictEqual(login.status, 200, 'accounts persisted');
    // … the ledger is intact (engine journal + snapshot) …
    const after = await (await get(base2, '/api/stats')).json();
    assert.strictEqual(after.creditsInSystem, before.creditsInSystem, 'not a credit minted or lost');
    // … and the positions survived with it.
    const sess = await post(base2, '/api/session', {}, { authorization: `Bearer ${login.body?.token || (await login.json()).token}` });
    const cookie = (sess.headers.get('set-cookie') || '').split(';')[0];
    const mine = await (await get(base2, '/api/me', { cookie })).json();
    assert.strictEqual(mine.positions.length, myPos.positions.length, 'positions survived');
    assert.ok((await (await get(base2, '/api/markets')).json()).markets.length >= 1, 'markets survived');
    base = base2; // subsequent tests run against the restarted node
  });

  // These two exhaust their limiters — they run last for that reason.
  it('login is throttled per account, so guessing is not free', async () => {
    let last;
    for (let i = 0; i < 34; i += 1) {
      last = (await post(base, '/api/login', { username: 'oracle', password: `guess-${i}-wrong` })).status;
    }
    assert.strictEqual(last, 429, 'password grinding hits the limiter');
  });

  // LAST on purpose: this test exhausts the registration limiter.
  it('registration is throttled per IP', async () => {
    let last;
    for (let i = 0; i < 12; i += 1) {
      last = (await post(base, '/api/register', { username: `bulk${i}`, password: 'test-pass-1234' })).status;
    }
    assert.strictEqual(last, 429, 'burst registration hits the throttle');
  });

});
