// scry — prediction markets on the news. Hubdub's spirit, LMSR's brain.
//
//   node server.js                     # http://localhost:3490, data in ./data
//   PORT=3490 DATA=/var/scry PUBLIC_URL=https://scry.example \
//     TRUST_PROXY=1 HOST=127.0.0.1 ADMINS=https://scry.example/u/melvin#me node server.js
//
// This file is a HOST, not the product: the whole prediction-market engine
// (LMSR market maker, journalled ledger, settlement state machine with
// disputes, the trading UI) lives in markets/ — vendored verbatim from
// jss-plugins/markets, where it was built and carries its 75-test suite.
// scry fabricates the small plugin api that engine expects (fastify,
// getAgent, pluginDir, ws.route, serverInfo) and adds the one thing a
// standalone site needs that a JSS pod host provides for free: accounts.
//
//   POST /api/register {username,password} → {agent, token}   (throttled)
//   POST /api/login    {username,password} → {agent, token}
//   GET  /u/<name>                           the agent's profile document
//   everything else                          markets/plugin.js at site root
//
// Agents are URIs (<origin>/u/name#me — they dereference); passwords are
// scrypt-hashed; bearers are stateless HMAC (the solidpay pattern). The
// bearer is only ever pasted ONCE — the UI exchanges it for the engine's
// HttpOnly session cookie via POST /api/session.

import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import activate from './markets/plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const REGISTER_PER_HOUR = Number(process.env.SCRY_REGISTER_PER_HOUR || 10);
const LOGIN_PER_15MIN = Number(process.env.SCRY_LOGIN_PER_15MIN || 30);
const b64u = (b) => Buffer.from(b).toString('base64url');

export async function createSite({
  dataDir = './data',
  publicUrl = null,
  admins = [],
  grantCredits = 1000,
  trustProxy = process.env.TRUST_PROXY === '1',
  // The engine's own per-IP token bucket. Exposed because a busy node (or a
  // test suite) legitimately needs to raise it.
  rateCapacity = Number(process.env.SCRY_RATE_CAPACITY || 0) || undefined,
  rateRefillPerSec = Number(process.env.SCRY_RATE_REFILL || 0) || undefined,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });

  // ---- accounts (scrypt + stateless HMAC bearers) -------------------------
  const accountsFile = path.join(dataDir, 'accounts.json');
  const secretFile = path.join(dataDir, 'secret');
  let secret;
  try { secret = fs.readFileSync(secretFile); } catch {
    secret = crypto.randomBytes(32);
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
  // Null-prototype: with a plain object, accounts['constructor'] is truthy,
  // which made /u/constructor serve a profile for an account that does not
  // exist and permanently 409'd anyone registering that name.
  let accounts = Object.create(null);
  try { Object.assign(accounts, JSON.parse(fs.readFileSync(accountsFile, 'utf8'))); } catch { /* first run */ }
  const hasAccount = (name) => Object.prototype.hasOwnProperty.call(accounts, name);
  const saveAccounts = () => fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
  // ASYNC scrypt: scryptSync blocks the single thread for ~25ms, so a burst
  // of logins would stall every trade on the node. The engine's atomicity
  // relies on synchronous ledger mutation — but auth must never be part of
  // that critical section.
  const hashPassword = (password, salt) => new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(b64u(key))));
  });

  // ORIGIN IS LEDGER IDENTITY. Agent URIs (and therefore every balance,
  // position and market row keyed by them) embed it, so a changed port or
  // proxy would silently orphan every account: the same person returns as a
  // new agent with a new grant, and their money is unreachable. So the
  // origin is PERSISTED on first use and reused on every later boot; an
  // explicit PUBLIC_URL still wins, but a mismatch is shouted about because
  // it means the existing ledger is about to be addressed by a new name.
  const originFile = path.join(dataDir, 'origin');
  let persistedOrigin = null;
  try { persistedOrigin = fs.readFileSync(originFile, 'utf8').trim() || null; } catch { /* first boot */ }
  let origin = publicUrl ? String(publicUrl).replace(/\/$/, '') : persistedOrigin;
  if (publicUrl && persistedOrigin && persistedOrigin !== origin) {
    console.warn(`[scry] WARNING: this data directory was created under ${persistedOrigin} but PUBLIC_URL is `
      + `${origin}. Existing accounts, balances and positions are keyed by the OLD origin and will look empty. `
      + `Keep the old value, or migrate deliberately.`);
  }
  const rememberOrigin = () => {
    if (!origin || persistedOrigin === origin) return;
    try { fs.writeFileSync(originFile, origin + '\n'); persistedOrigin = origin; } catch { /* read-only fs */ }
  };
  rememberOrigin();
  const agentUri = (name) => `${origin}/u/${name}#me`;

  // Tokens carry the account's EPOCH so a compromised bearer can be revoked
  // without rotating the node secret (which would log everyone out).
  // Bumping accounts[name].epoch invalidates every token issued before it.
  function mintToken(agent, name) {
    const epoch = (hasAccount(name) && accounts[name].epoch) || 0;
    const payload = b64u(JSON.stringify({ a: agent, n: name, e: epoch, exp: Date.now() + TOKEN_TTL_MS }));
    const mac = b64u(crypto.createHmac('sha256', secret).update(payload).digest());
    return `v1.${payload}.${mac}`;
  }
  function verifyToken(token) {
    const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token || '');
    if (!m) return null;
    const mac = b64u(crypto.createHmac('sha256', secret).update(m[1]).digest());
    const a = Buffer.from(mac); const b = Buffer.from(m[2]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const { a: agent, n: name, e: epoch, exp } = JSON.parse(Buffer.from(m[1], 'base64url').toString());
      if (!(exp > Date.now())) return null;
      // Legacy tokens (no name) predate epochs; accept until they expire.
      if (name && (!hasAccount(name) || ((accounts[name].epoch || 0) !== (epoch || 0)))) return null;
      return agent;
    } catch { return null; }
  }

  const clientIp = (req) => (trustProxy
    ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim()
    : String(req.socket.remoteAddress || '?'));

  /** Sliding-window limiter keyed by anything; bounded so it cannot grow
   *  without limit under a rotating-key flood. */
  function makeLimiter(cap, windowMs, maxKeys = 20_000) {
    const hits = new Map();
    return (key) => {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (list.length >= cap) { hits.set(key, list); return false; }
      list.push(now);
      hits.set(key, list);
      if (hits.size > maxKeys) {
        for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k); }
        if (hits.size > maxKeys) hits.clear();
      }
      return true;
    };
  }
  const registerLimit = makeLimiter(REGISTER_PER_HOUR, 3600_000);
  // Password guessing was completely unthrottled: 30 tries/15min per IP AND
  // per account, so neither a single-account grind nor a spray across many
  // accounts from one address is free.
  const loginIpLimit = makeLimiter(LOGIN_PER_15MIN, 900_000);
  const loginUserLimit = makeLimiter(LOGIN_PER_15MIN, 900_000);
  const registerAllowed = (req) => registerLimit(clientIp(req));

  // ---- the host ----------------------------------------------------------
  const fastify = Fastify({ logger: false, trustProxy, forceCloseConnections: true });

  fastify.post('/api/register', async (request, reply) => {
    if (!registerAllowed(request.raw)) {
      return reply.code(429).send({ error: 'too many registrations from your address — try again in an hour' });
    }
    const body = request.body || {};
    const name = String(body.username || '').toLowerCase();
    const password = String(body.password || '');
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'username: 2–31 chars of a-z 0-9 . _ -' });
    if (password.length < 8) return reply.code(400).send({ error: 'password: at least 8 characters' });
    if (hasAccount(name)) return reply.code(409).send({ error: 'username already taken' });
    const salt = b64u(crypto.randomBytes(16));
    accounts[name] = {
      salt, hash: await hashPassword(password, salt), created: new Date().toISOString(), epoch: 0,
    };
    saveAccounts();
    const agent = agentUri(name);
    return reply.code(201).send({ agent, token: mintToken(agent, name) });
  });

  // A dummy salt so a MISSING account costs the same scrypt work as a real
  // one: returning fast for unknown users is a username-enumeration oracle.
  const DUMMY_SALT = b64u(crypto.randomBytes(16));
  fastify.post('/api/login', async (request, reply) => {
    const body = request.body || {};
    const name = String(body.username || '').toLowerCase();
    const tooMany = !loginIpLimit(clientIp(request.raw)) || !loginUserLimit(name);
    if (tooMany) return reply.code(429).send({ error: 'too many sign-in attempts — wait a few minutes' });
    const acct = hasAccount(name) ? accounts[name] : null;
    const attempt = await hashPassword(String(body.password || ''), acct ? acct.salt : DUMMY_SALT);
    const ok = !!acct && crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(acct.hash));
    if (!ok) return reply.code(401).send({ error: 'wrong username or password' });
    const agent = agentUri(name);
    return reply.send({ agent, token: mintToken(agent, name) });
  });

  // Change password. Bumps the account epoch, which invalidates every bearer
  // issued before now — so this doubles as "sign out everywhere" and as the
  // remediation path for a leaked credential.
  fastify.post('/api/password', async (request, reply) => {
    const body = request.body || {};
    const name = String(body.username || '').toLowerCase();
    if (!loginIpLimit(clientIp(request.raw)) || !loginUserLimit(name)) {
      return reply.code(429).send({ error: 'too many attempts — wait a few minutes' });
    }
    const next = String(body.newPassword || '');
    if (next.length < 8) return reply.code(400).send({ error: 'newPassword: at least 8 characters' });
    const acct = hasAccount(name) ? accounts[name] : null;
    const attempt = await hashPassword(String(body.password || ''), acct ? acct.salt : DUMMY_SALT);
    const ok = !!acct && crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(acct.hash));
    if (!ok) return reply.code(401).send({ error: 'wrong username or password' });
    const salt = b64u(crypto.randomBytes(16));
    acct.salt = salt;
    acct.hash = await hashPassword(next, salt);
    acct.epoch = (acct.epoch || 0) + 1; // revokes every existing token
    saveAccounts();
    const agent = agentUri(name);
    return reply.send({ agent, token: mintToken(agent, name), revokedPreviousTokens: true });
  });

  fastify.get('/u/:name', async (request, reply) => {
    const name = String(request.params.name || '');
    if (!hasAccount(name)) return reply.code(404).send({ error: 'no such agent' });
    return reply.send({
      '@context': { scry: 'https://scry.example/ns#' },
      '@id': agentUri(name),
      name,
      'scry:site': origin,
      'scry:since': accounts[name].created,
    });
  });

  fastify.get('/healthz', async () => ({ ok: true }));

  // ---- the fabricated plugin api ------------------------------------------
  const wsRoutes = new Map();
  const wss = new WebSocketServer({ noServer: true });
  const pluginDir = path.join(dataDir, 'markets');
  fs.mkdirSync(pluginDir, { recursive: true });

  const api = {
    fastify,
    prefix: '', // the site root IS the product
    config: {
      grantCredits,
      admins,
      accountsUi: true, // the register/login form instead of pod-bearer paste
      ...(rateCapacity ? { rateCapacity } : {}),
      ...(rateRefillPerSec ? { rateRefillPerSec } : {}),
      brand: 'scry',
      tagline: 'prediction markets on the news',
      ogImage: 'https://melvincarvalho.github.io/scry/assets/og.png',
      // A GETTER, not a value: without PUBLIC_URL the origin is only known
      // once listening, and a plain property captured null — so og:url was
      // silently omitted on exactly the nodes that boot without one.
      get ogUrl() { return origin; },
      favicon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%235348C7'/%3E%3Crect x='12' y='36' width='10' height='18' rx='3' fill='%23fff' opacity='.45'/%3E%3Crect x='27' y='24' width='10' height='30' rx='3' fill='%23fff' opacity='.7'/%3E%3Crect x='42' y='10' width='10' height='44' rx='3' fill='%23fff'/%3E%3C/svg%3E",
      baseUrl: origin,
    },
    log: {
      info: (...a) => console.log('[scry]', ...a),
      warn: (...a) => console.warn('[scry]', ...a),
      error: (...a) => console.error('[scry]', ...a),
      log: (...a) => console.log('[scry]', ...a),
    },
    auth: {
      // The engine's whole auth need: "which agent is this request?"
      async getAgent(request) {
        const h = (request.headers && request.headers.authorization) || '';
        return h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
      },
    },
    storage: { pluginDir: () => pluginDir },
    serverInfo: () => ({ baseUrl: origin }),
    ws: {
      route(p, handler) {
        wsRoutes.set(p, handler);
      },
    },
  };

  const plugin = await activate(api);

  await fastify.ready();
  fastify.server.on('upgrade', (req, sock, head) => {
    const p = new URL(req.url, 'http://x').pathname;
    const handler = wsRoutes.get(p);
    if (!handler) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (socket) => handler(socket, req));
  });

  return {
    fastify,
    async listen(port = 3490, host = process.env.HOST || '0.0.0.0') {
      await fastify.listen({ port, host });
      const actual = fastify.server.address().port;
      // One agent, one spelling (the solidpay lesson): the origin must match
      // how clients actually address the site, or minted agent URIs split.
      if (!origin) origin = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`;
      rememberOrigin(); // pin it before the first account is ever minted
      return { port: actual, origin };
    },
    async close() {
      if (plugin && plugin.deactivate) plugin.deactivate();
      await fastify.close();
    },
  };
}

// ---- CLI ------------------------------------------------------------------
const entry = process.argv[1] && (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  || path.resolve(process.env.pm_exec_path || '') === fileURLToPath(import.meta.url));
if (entry) {
  const site = await createSite({
    dataDir: process.env.DATA || './data',
    publicUrl: process.env.PUBLIC_URL || null,
    admins: (process.env.ADMINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    grantCredits: Number(process.env.GRANT || 1000),
  });
  const { port, origin } = await site.listen(Number(process.env.PORT || 3490));
  console.log(`scry listening on port ${port}`);
  console.log(`  site:  ${origin}/`);
  console.log(`  stats: ${origin}/api/stats`);
}
