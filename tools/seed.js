// Seed scry with a newsdesk account and a front page of news markets.
// Idempotent: existing markets (matched by title) are left alone.
//
//   node tools/seed.js [http://localhost:3490]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] || 'http://localhost:3490').replace(/\/$/, '');
// When seeding over loopback behind a proxy, the engine's CSRF guard checks
// the PUBLIC origin — pass it as the second argument.
const publicOrigin = (process.argv[3] || base).replace(/\/$/, '');
// The newsdesk account is the ORACLE for every question it creates — a
// password committed to a public repo would hand any reader the power to
// resolve all of them. Take it from the environment; otherwise generate one
// and persist it beside the data (gitignored), so re-seeding still works and
// the secret never enters git.
const passFile = path.join(process.env.DATA || './data', 'newsdesk-password');
function newsdeskPassword() {
  if (process.env.NEWSDESK_PASSWORD) return process.env.NEWSDESK_PASSWORD;
  try { return fs.readFileSync(passFile, 'utf8').trim(); } catch { /* mint below */ }
  const pw = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(path.dirname(passFile), { recursive: true });
  fs.writeFileSync(passFile, pw + '\n', { mode: 0o600 });
  console.log(`newsdesk password generated → ${passFile} (keep it; it resolves the seeded questions)`);
  return pw;
}
const PASS = newsdeskPassword();

const at = (iso) => new Date(`${iso}T12:00:00Z`).toISOString();

// Ten questions grounded in the news as of 6 August 2026. Each description
// carries the anchor figure it was written against, so a trader can see what
// the market started from and an oracle knows what it promised to resolve.
// Chosen for genuine uncertainty: a question everyone agrees on is a dead
// market.
const QUESTIONS = [
  {
    title: 'Which party controls the US Senate after the November midterms?',
    category: 'Politics',
    outcomes: ['Republicans hold', 'Democrats take control'],
    closesAt: at('2026-11-03'),
    description: 'Midterms are 3 Nov 2026; 35 seats are up, 22 of them Republican-held, so Democrats need a net gain of four. Forecasters disagree: Decision Desk HQ gives Republicans a 57% chance of holding (a 50-50 chamber with the VP breaking ties), while FiftyPlusOne gives Democrats 55% to reach 51+. Resolves on the majority once every race is called; a 50-50 tie counts as Republicans holding.',
  },
  {
    title: 'Do Democrats win the US House in November?',
    category: 'Politics',
    outcomes: ['Yes', 'No'],
    closesAt: at('2026-11-03'),
    description: 'Forecast consensus favours Democrats — Decision Desk HQ has them at 61% (median 226-209), FiftyPlusOne at 85% (median 230 seats). Resolves YES if Democrats hold 218+ seats once every race is called.',
  },
  {
    title: 'What does the Fed do at the 15-16 September FOMC meeting?',
    category: 'Economy',
    outcomes: ['Hike', 'Hold', 'Cut'],
    closesAt: at('2026-09-15'),
    description: 'The target range has been 3.50-3.75% since the July meeting, where the Fed held but THREE FOMC members dissented wanting a hike. Analysts call September finely balanced, hanging on the next two CPI prints and the Middle East. Resolves by the direction of the target range announced on 16 Sep.',
  },
  {
    title: 'Is the Fed funds target range above 3.75% on 31 December 2026?',
    category: 'Economy',
    outcomes: ['Yes', 'No'],
    closesAt: at('2026-12-30'),
    description: 'The upper bound has sat at 3.75% since July 2026, with a hawkish minority pushing for more. Resolves YES if the upper bound of the target range exceeds 3.75% at year end.',
  },
  {
    title: 'Does Bitcoin close above $75,000 on 31 December 2026?',
    category: 'Crypto',
    outcomes: ['Yes', 'No'],
    closesAt: at('2026-12-30'),
    description: 'BTC was about $64,137 on 5 Aug 2026, entering August below its major moving averages after a difficult first half. Analysts put $65-70k as the resistance zone to reclaim, with year-end scenarios spanning roughly $57k to $75k. Resolves by the BTC/USD daily close on 31 Dec (major-exchange consensus).',
  },
  {
    title: 'Is OpenAI\'s Astra publicly available before 2027?',
    category: 'Tech',
    outcomes: ['Yes', 'No'],
    closesAt: at('2026-12-30'),
    description: 'OpenAI named Astra on 1 Aug 2026 — announced not with a launch but with ten solved open problems in mathematics and theoretical computer science, and with no date, no pricing, no model card and no ChatGPT availability. Since June 2026 frontier models also face up to 30 days of federal evaluation before release. Resolves YES if any member of the public can use Astra (ChatGPT or API) before 1 Jan 2027.',
  },
  {
    title: 'Does OpenAI ship a model publicly named "GPT-6" in 2026?',
    category: 'Tech',
    outcomes: ['Yes', 'No'],
    closesAt: at('2026-12-30'),
    description: 'As of early August 2026 the flagship is GPT-5.6 (released 9 Jul 2026 in the Sol, Terra and Luna tiers) and OpenAI has not said whether its next family ships as GPT-6, as another GPT-5 point release, or as Astra alone. Resolves YES only if a model is publicly released under the name GPT-6 during 2026.',
  },
  {
    title: 'Does Starship deploy payloads into orbit before 30 September?',
    category: 'Science',
    outcomes: ['Yes', 'No'],
    closesAt: at('2026-09-29'),
    description: 'Flight 13 splashed down softly in the Indian Ocean on 24 Jul 2026 after a scrubbed first attempt. Flight 14 is tentatively set for late August and is meant to deploy viable payloads into orbit — something Starship has never done. Resolves YES if a Starship flight successfully deploys payloads into orbit before 30 Sep 2026.',
  },
  {
    title: 'Who wins the 2026-27 Premier League?',
    category: 'Sport',
    outcomes: ['Arsenal', 'Manchester City', 'Liverpool', 'Another club'],
    closesAt: at('2027-05-23'),
    description: 'The season starts 21 Aug 2026. Arsenal defend the title as 6/4 favourites under Arteta; Manchester City are 5/2 in their first post-Guardiola season; Liverpool are around +550 and Manchester United +600. Squawka\'s model: Arsenal 30.7%, City 27.2%. Resolves on the final table.',
  },
  {
    title: 'Does Manchester United finish in the top four in 2026-27?',
    category: 'Sport',
    outcomes: ['Yes', 'No'],
    closesAt: at('2027-05-23'),
    description: 'United are fourth favourites for the title at around +600 going into the 2026-27 season. Resolves YES if they finish 1st-4th in the final Premier League table.',
  },
];

const post = (p, body, extra = {}) => fetch(base + p, {
  method: 'POST',
  // origin header: the engine's CSRF guard wants a same-origin signal on
  // any cookie-authenticated write.
  headers: { 'content-type': 'application/json', origin: publicOrigin, ...extra },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) }));

// newsdesk account (register or login)
let r = await post('/api/register', { username: 'newsdesk', password: PASS });
if (r.status === 409) r = await post('/api/login', { username: 'newsdesk', password: PASS });
if (!r.body.token) { console.error('newsdesk auth failed:', r.body); process.exit(1); }
console.log('newsdesk:', r.body.agent);

// bearer → engine session cookie
const s = await post('/api/session', {}, { authorization: `Bearer ${r.body.token}` });
const cookie = (s.headers.get('set-cookie') || '').split(';')[0];
if (!cookie) { console.error('session failed:', s.status, s.body); process.exit(1); }

const listed = await (await fetch(`${base}/api/markets?limit=100`)).json();
const have = new Set((listed.markets || []).map((m) => m.title));

let created = 0;
for (const q of QUESTIONS) {
  if (have.has(q.title)) continue;
  // b=40 keeps the creator escrow (b·ln n) affordable inside one 1000 grant.
  const res = await post('/api/markets', { ...q, b: 40 }, { cookie });
  if (res.status === 200 || res.status === 201) { created += 1; console.log(`  + ${q.title}`); }
  else console.error(`  ! ${q.title}: ${res.status} ${res.body.error || ''}`);
}
const stats = await (await fetch(`${base}/api/stats`)).json();
console.log(`created ${created} market(s); credits in system: ${stats.creditsInSystem}`);
