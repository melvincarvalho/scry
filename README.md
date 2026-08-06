# scry — prediction markets on the news

**Scry the news.** Play-money prediction markets in the spirit of
[Hubdub](https://en.wikipedia.org/wiki/Hubdub) (2008): bet paper credits on
news questions, watch the odds move, climb the leaderboard, submit your own
questions — with a modern brain: Hanson's **LMSR** automated market maker, a
journalled ledger whose conservation is asserted after every settlement, and
a dispute-safe settlement state machine.

## Quickstart

```bash
git clone https://github.com/melvincarvalho/scry
cd scry && npm install
node server.js          # → http://localhost:3490
node tools/seed.js      # a newsdesk account + a front page of questions
npm test                # 13 site tests
node tools/soak.js      # parallel trades, then prove conservation
```

The seed prints a generated **newsdesk password** into
`<data>/newsdesk-password` (that account is the oracle for the seeded
questions — keep it, or set `NEWSDESK_PASSWORD` yourself).

Behind a proxy:

```bash
PUBLIC_URL=https://scry.example TRUST_PROXY=1 HOST=127.0.0.1 \
  ADMINS=https://scry.example/u/you#me node server.js
```

New accounts get **1,000 paper credits**. Anyone can create a question — the
creator escrows the market maker's worst-case loss (`b·ln n`), so every book
is provably solvent and junk questions cost their author.

## How it settles (the part that matters)

The question's **oracle** (creator by default) resolves it — but a
unilateral instant oracle is a credit-theft primitive, so resolution is a
state machine: oracles may not trade their own markets; their settlement
claim is capped at their own escrow; any holder can lodge a **bonded
dispute** that parks the market for an operator (uphold / re-resolve /
void); and a market whose oracle disappears **auto-voids at TWAP** — funds
are never stuck. The leaderboard is signed-in-only and pseudonymized
("show a rival, not a dossier").

## Operating it

Accounts are throttled (registration per IP, sign-in per IP *and* per
account), passwords are scrypt-hashed off the event loop, and
`POST /api/password` rotates a password and **revokes every existing
token**. The data directory is the whole state: the engine's journal +
snapshot, the account file, and an `origin` marker — that last one pins
ledger identity, because agent URIs embed the origin and a changed port
would otherwise orphan every balance. Back up the data directory; that is
the ledger.

## Architecture

`server.js` is a small host: accounts (scrypt passwords, stateless HMAC
bearers, throttled registration), agent URIs that dereference
(`/u/name#me`), and a fabricated plugin api. The entire engine —
`markets/` (LMSR math, journal + reducer, lifecycle, guard, trading UI) —
is **vendored verbatim** from
[jss-plugins/markets](https://github.com/JavaScriptSolidServer/plugins),
where it was built and carries its 75-test suite; `tools/sync.sh`
re-vendors. The same engine runs unchanged as a [JavaScript Solid
Server](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer)
plugin — one engine, two hosts (the ripple → solidpay pattern).

## License

MIT (engine vendored from the AGPL-3.0 jss-plugins repository by its
author, relicensed here — the markets engine is original work with no
JSS-derived code).
