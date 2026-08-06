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
const b64u = (b) => Buffer.from(b).toString('base64url');

export async function createSite({
  dataDir = './data',
  publicUrl = null,
  admins = [],
  grantCredits = 1000,
  trustProxy = process.env.TRUST_PROXY === '1',
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
  let accounts;
  try { accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8')); } catch { accounts = {}; }
  const saveAccounts = () => fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
  const hashPassword = (password, salt) => b64u(crypto.scryptSync(password, salt, 32));

  let origin = publicUrl ? String(publicUrl).replace(/\/$/, '') : null;
  const agentUri = (name) => `${origin}/u/${name}#me`;

  function mintToken(agent) {
    const payload = b64u(JSON.stringify({ a: agent, exp: Date.now() + TOKEN_TTL_MS }));
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
      const { a: agent, exp } = JSON.parse(Buffer.from(m[1], 'base64url').toString());
      return exp > Date.now() ? agent : null;
    } catch { return null; }
  }

  const regHits = new Map();
  function registerAllowed(req) {
    const ip = trustProxy
      ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim()
      : String(req.socket.remoteAddress || '?');
    const now = Date.now();
    const hits = (regHits.get(ip) || []).filter((t) => now - t < 3600_000);
    if (hits.length >= REGISTER_PER_HOUR) return false;
    hits.push(now);
    regHits.set(ip, hits);
    return true;
  }

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
    if (accounts[name]) return reply.code(409).send({ error: 'username already taken' });
    const salt = b64u(crypto.randomBytes(16));
    accounts[name] = { salt, hash: hashPassword(password, salt), created: new Date().toISOString() };
    saveAccounts();
    const agent = agentUri(name);
    return reply.code(201).send({ agent, token: mintToken(agent) });
  });

  fastify.post('/api/login', async (request, reply) => {
    const body = request.body || {};
    const name = String(body.username || '').toLowerCase();
    const acct = accounts[name];
    if (!acct || hashPassword(String(body.password || ''), acct.salt) !== acct.hash) {
      return reply.code(401).send({ error: 'wrong username or password' });
    }
    const agent = agentUri(name);
    return reply.send({ agent, token: mintToken(agent) });
  });

  fastify.get('/u/:name', async (request, reply) => {
    const name = String(request.params.name || '');
    if (!accounts[name]) return reply.code(404).send({ error: 'no such agent' });
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
