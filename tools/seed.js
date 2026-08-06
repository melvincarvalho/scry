// Seed scry with a newsdesk account and a front page of news markets.
// Idempotent: existing markets (matched by title) are left alone.
//
//   node tools/seed.js [http://localhost:3490]

const base = (process.argv[2] || 'http://localhost:3490').replace(/\/$/, '');
// When seeding over loopback behind a proxy, the engine's CSRF guard checks
// the PUBLIC origin — pass it as the second argument.
const publicOrigin = (process.argv[3] || base).replace(/\/$/, '');
const PASS = 'scry-newsdesk-2026';
const days = (n) => new Date(Date.now() + n * 864e5).toISOString();

const QUESTIONS = [
  { title: 'Will Bitcoin close above $150,000 on 31 December 2026?', category: 'Crypto',
    outcomes: ['Yes', 'No'], closesAt: days(140),
    description: 'Resolves by the BTC/USD daily close on the last day of 2026 (major exchange consensus).' },
  { title: 'Who wins the 2026 FIFA World Cup final?', category: 'Sport',
    outcomes: ['A European side', 'A South American side', 'Anyone else'], closesAt: days(30),
    description: 'Resolves by the confederation of the winning team.' },
  { title: 'Will the ECB cut rates again before December 2026?', category: 'Economy',
    outcomes: ['Yes', 'No'], closesAt: days(120),
    description: 'Any reduction of the main refinancing rate announced before 1 Dec 2026.' },
  { title: 'Will a major AI lab release a public model claiming AGI capability in 2026?', category: 'Tech',
    outcomes: ['Yes', 'No'], closesAt: days(140),
    description: 'Resolves YES if a top-5 lab formally claims AGI-level capability for a released system.' },
  { title: 'Will the James Webb telescope announce a biosignature candidate this year?', category: 'Science',
    outcomes: ['Yes', 'No'], closesAt: days(140),
    description: 'A peer-reviewed candidate biosignature detection announced by the JWST programme in 2026.' },
  { title: 'Will Nostr pass 10M monthly active pubkeys by year end?', category: 'Tech',
    outcomes: ['Yes', 'No'], closesAt: days(140),
    description: 'By the commonly-cited public relay statistics dashboards.' },
  { title: 'Next UK general election: which party forms the government?', category: 'Politics',
    outcomes: ['Labour', 'Conservative', 'Other / coalition'], closesAt: days(300),
    description: 'Resolves when a new government is formed after the next general election.' },
  { title: 'Will EUR/USD trade above 1.20 before November 2026?', category: 'Economy',
    outcomes: ['Yes', 'No'], closesAt: days(85),
    description: 'Any print above 1.2000 on a major venue before 1 Nov 2026.' },
  { title: 'Will SpaceX Starship reach orbit and land both stages in one flight this year?', category: 'Science',
    outcomes: ['Yes', 'No'], closesAt: days(140),
    description: 'Both stages recovered (caught or soft-landed) from a single orbital flight in 2026.' },
  { title: 'Champions League 2026-27: does an English club reach the final?', category: 'Sport',
    outcomes: ['Yes', 'No'], closesAt: days(280),
    description: 'At least one Premier League side in the final.' },
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
