# SHARP — Live Match Predictions & Sharp-Move Detection, Proven On-Chain
### Standalone agent — this repo is the complete Track 2 submission.
### Track: Trading Tools & Agents (TxODDS World Cup Hackathon)

An autonomous agent that watches TxLINE's World Cup odds, detects statistically
abnormal moves, and — the part nobody can fake — **stamps every signal onto
Solana the moment it fires**, then grades itself against the final result from
TxLINE's scores feed.

**The problem it kills:** signal/tipster services routinely fake their track
records — delete the misses, screenshot the hits. SHARP structurally cannot:
each signal is a timestamped Memo transaction on-chain *before* the outcome is
known, and each grade references the original tx. The accuracy number at
`/health` is backed by an immutable audit trail anyone can replay on the
explorer. Verifiable data in (TxLINE), verifiable performance out.

## The model (deterministic, three-gate)
Prices → implied probabilities (scale auto-detected, overround stripped by
normalization). Per (fixture, market, outcome) we track per-update probability
changes with an EWMA mean/variance (half-life 12 updates). A signal fires only
when ALL hold:
1. **|z| ≥ 3** — the move is abnormal *for that market's own volatility*
   (in-play markets self-calibrate noisier baselines than pre-match ones);
2. **|Δp| ≥ 2 points** — economically meaningful, kills illiquid-feed jitter;
3. **120s debounce per market** — one repricing cascade = one signal.

No ML, no black box: every threshold is named, defensible, and in config.
Judges' criterion is "mathematically or strategically defensible" — the
defense is: z-gate controls false positives (≈0.3%/update under quiet
conditions), magnitude gate controls economic relevance, debounce controls
duplication. Change any constant and behavior is predictable.

## Autonomy & production readiness
- Zero human input after `npx tsx src/agent/main.ts`
- Odds via SSE with automatic fallback to 60s polling; auto-reconnect
- Memo failures retried by a 5-minute sweep; state survives restarts (JSONL)
- `/health` exposes feed liveness, signal counts, on-chain coverage, accuracy
- Runs alongside (not inside) the Prop Vault server: one spine, two products

## TxLINE endpoints used
- `POST /auth/guest/start`, on-chain `subscribe`, `POST /api/token/activate`
- `GET /api/odds/stream` (SSE; falls back to `GET /api/odds/updates/{day}/{hour}/{interval}`)
- `GET /api/scores/stream` (final results for self-grading)

## Run
```bash
npm install
copy your existing keypair.json into this folder
npm start
# status:   curl localhost:8788/health
# signals:  curl localhost:8788/signals   (each carries its explorer link)
```

## Deploying on Render (free tier) — two things that bite
The agent is a long-running process; the free tier has two sharp edges:

1. **Ephemeral disk wipes state on every redeploy.** `signals.jsonl` (and the
   odds recordings) live under `DATA_DIR`, which defaults to `./data`. Point it
   at a Render **persistent disk** so the on-chain track record survives deploys:
   ```
   DATA_DIR=/var/data     # mount a persistent disk at /var/data in Render
   ```
   Without a persistent disk the JSONL is rebuilt from scratch each deploy — the
   chain record is never at risk (it's on Solana), but the local index resets.

2. **The instance sleeps after ~15 idle minutes** and will nap through matches.
   Keep it warm with an external pinger (e.g. UptimeRobot) hitting `/health`
   every 5 minutes. A self-ping can't help — a sleeping instance runs nothing.

`/health` exposes `awaitingFirstOdds` and `oddsUpdatesSeen` so you can confirm,
during a live fixture, that odds are actually arriving (the free tier serves
match odds on the polling path; the client logs which mode it landed in).

## Demo video script (≤5 min)
1. (40s) The fake-track-record problem; why on-chain stamps fix it.
2. (60s) Model whiteboard: the three gates, in plain words.
3. (90s) Live/replay: odds tick, a signal fires, terminal shows the memo tx —
   open it on the explorer, show the timestamp precedes the result.
4. (60s) A finished match: the grade lands, /health accuracy updates,
   the grade memo references the signal memo.
5. (30s) Kill the process, restart it: state intact, chain record untouched.
   "A trading desk can deploy this today; so can a tipster with nothing to hide."

## First-run verification (honest list)
- Odds endpoint paths follow the scores pattern; the client auto-falls-back and
  logs its mode — confirm which lands on first run.
- Price scale auto-detection: check one logged frame against a known bookmaker
  price. priceName conventions for match winner ("1"/"X"/"2" vs names) —
  confirm on first grade; mapping isolated in main.ts.
- Free-tier (service level 1) odds coverage: verified on first connect; if
  odds require a higher tier, the poll endpoint response will say so — report
  to Claude for a same-day plan B (score-derived probability moves).

## Dashboard (port 8788)
- **Matches**: card per fixture — live score, red LIVE pill, and "Who will win?" W/D/L rings computed from TxLINE odds in real time (market-implied, recalculated every update), plus the agent's consensus read.
- **Signal tape**: full prediction history — every abnormal move, its before/after probabilities, z-score, ✓/✗ grade against the final score, and a "verify on-chain" link to the devnet memo transaction.
