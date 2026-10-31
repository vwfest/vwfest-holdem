# VW FEST HOLD'EM

Free multiplayer Texas Hold'em for the **$VWFEST Arcade Room**. **Play chips only: no cash, no prizes, no real money.**

* **Play:** https://vwfest.github.io/vwfest-holdem/ (static client on GitHub Pages, `docs/`)
* **Game server:** Node 20 + Express 5 + `ws` on a Render free web service (`server/`), optional Postgres schema `holdem`.
* **Room:** 25 players max (spectators count), 7 cash tables x 6 seats. Everyone starts with 1,000 play chips (free reload when you bust).
* **No sign-up:** pick a username (3-14 chars, profanity filtered, unique in the room) and a VW avatar or upload a small image (resized to a small JPEG on your device; the server accepts <= 3 KB because avatars are broadcast to the room).
* **Tournaments (opt-in, America/Los_Angeles):** *Daily Cruise* every day 7:00 PM PT, *Weekly Main Event* every Saturday 6:00 PM PT. Register in the lobby; 1,000 chips each; blinds escalate every 5 min (daily) / 8 min (weekly); tables are balanced and merged to a final table; results + winners board. A tournament needs >= 2 registered players in the room; it waits up to 10 min for them, otherwise it is cancelled and the next one opens.
* **Chat** + **live leaderboard** (chips of everyone in the room) in the lobby, chat at the table.

## Rules engine (server/table.js, server/cards.js)
Blinds (heads-up button rule), preflop/flop/turn/river, min-raise + short all-in (doesn't re-open betting), uncalled-bet return, side pots, 7-card evaluation, split pots (odd chip left of the button), run-outs with reveal, 25 s action timer (20 s in tournaments), auto check/fold on timeout, sit-out after 2 timeouts (cash), auto-fold when disconnected, seat released after 45 s offline (cash).

## Security
* Server is authoritative: cards are shuffled with `crypto.randomInt` and dealt on the server. `getView(p)` is the only data clients get: your own hole cards, opponents' as `??`, revealed only at showdown/run-out.
* Identity = random 24-byte token in the browser's localStorage (only its SHA-256 is kept server side); no emails, passwords or wallets.
* CORS and WebSocket `Origin` locked to `https://vwfest.github.io` (`ALLOWED_ORIGINS` adds more for tests only); no wildcard.
* Per-socket token bucket + strike close, per-IP socket cap, 20 KB frame cap, hello timeout, chat limits (5 per 10 s, 140 chars, links/profanity masked), strict JSON validation of every message, uploaded avatars validated (data URL, magic bytes, <= 11.5 KB).
* Helmet + `default-src 'none'` on the server; the client page has a strict CSP (`script-src 'self'`, `style-src 'self'`, no inline script/style), all remote text rendered with `textContent`.

## Run / test
```
npm install
npm start                # http://localhost:3000 (WS at /ws); Origin must be https://vwfest.github.io
npm test                 # engine tests + full Playwright e2e (starts its own server on :3200)
```

| Env | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | listen port |
| `DATABASE_URL` | – | Postgres (tournament registrations/results/winners). Omit → in-memory |
| `DB_SCHEMA` | `holdem` | own schema; nothing else in the DB is touched |
| `ALLOWED_ORIGINS` | – | extra comma-separated origins (tests/dev only) |
| `MAX_PER_IP` | 8 | WebSocket connections per IP |
| `HOLDEM_TEST` | – | `1` = fast timers + `/api/test/start/:kind` (never in production) |

Note: Render's free tier sleeps after ~15 min idle; the client shows a "waking the server" screen and retries. A tournament whose start time passes while the server sleeps starts as soon as >= 2 registered players are in the room (grace 10 min).
