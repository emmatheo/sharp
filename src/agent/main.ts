import path from "path";
// SHARP — autonomous odds-move detection agent with an on-chain track record.
// Run:  npx tsx src/agent/main.ts        (own process, own port; the prop-vault
// server is untouched — two products, one spine.)
//
// Autonomy: zero human input after launch. Ingests TxLINE odds, fires
// deterministic signals, memo-logs them to Solana, grades itself when
// fixtures finish, retries failures on a sweep. Kill -9 it and restart:
// state reloads from disk, the chain record was never at risk.

import express from "express";
import fs from "fs";
import { CFG } from "../config.js";
import { TxlineClient } from "../txline/client.js";
import { LiveScoreStream } from "../txline/stream.js";
import { OddsSource } from "./odds.js";
import { Detector } from "./detector.js";
import { AuditLog } from "./audit.js";

const PORT = Number(process.env.PORT ?? process.env.PORT ?? process.env.AGENT_PORT ?? 8788);
const TERMINAL = new Set([5, 10, 13]);

async function main() {
  const txline = await new TxlineClient().init();
  const audit = new AuditLog();
  const detector = new Detector();

  // --- odds -> signals -> chain ---
  const odds = new OddsSource(txline);
  let lastOddsAt = 0, oddsSeen = 0, status = "starting";
  const goalWindows = new Map<number, number>(); // fixtureId -> window end (ms)
  // Match cards state: market-implied W/D/L, names, live score, phase
  interface MatchCard { fixtureId: number; name1?: string; name2?: string; probs?: number[]; priceNames?: string[]; h?: number; a?: number; phase?: number; lastSignalAt?: number; updatedAt: number; kickoff?: number; upcoming?: boolean; }
  const matches = new Map<number, MatchCard>();
  // Upcoming fixtures (real schedule you maintain in upcoming.json) so the
  // board is never empty pre-kickoff. Cards flip to live automatically when
  // the feed starts sending odds/scores for that fixtureId.
  try {
    const up = JSON.parse(fs.readFileSync("upcoming.json", "utf8"));
    for (const u of up) {
      const m: MatchCard = { fixtureId: Number(u.fixtureId), name1: u.name1, name2: u.name2,
        kickoff: u.kickoff ? Number(u.kickoff) : undefined, upcoming: true, updatedAt: Date.now() };
      matches.set(m.fixtureId, m);
    }
    console.log(`[agent] loaded ${matches.size} upcoming fixture(s) from upcoming.json`);
  } catch { console.log("[agent] no upcoming.json — matches appear when the feed sends them"); }

  const card = (f: number) => { let m = matches.get(f); if (!m) { m = { fixtureId: f, updatedAt: 0 }; matches.set(f, m); void fetchNames(f); } return m; };
  async function fetchNames(f: number) { // fixtures snapshot: verify-on-first-run path
    try {
      const r = await fetch(`${CFG.txline.apiOrigin}/api/fixtures/snapshot/${f}`, { headers: txline.headers() });
      if (!r.ok) return;
      const d: any = await r.json();
      const m = card(f);
      m.name1 = d.participant1 ?? d.fixture?.participant1; m.name2 = d.participant2 ?? d.fixture?.participant2;
      push("match", m);
    } catch { /* fixture #id fallback in UI */ }
  }
  const sseClients = new Set<import("express").Response>();
  const push = (type: string, data: any) => {
    const p = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(p);
  };
  odds.on("status", (s) => { status = s; console.log(`[odds] ${s}`); push("status", { status: s }); });
  odds.on("odds", async (u) => {
    lastOddsAt = Date.now(); oddsSeen++;
    if (oddsSeen % 5 === 0) push("pulse", { oddsSeen });
    const goalWindow = (goalWindows.get(u.fixtureId) ?? 0) > Date.now();
    if ((u.superOddsType ?? "match_odds").toLowerCase().includes("match") || !u.superOddsType) {
      const { impliedProbs } = await import("./detector.js");
      const p = impliedProbs(u.prices);
      if (p) { const m = card(u.fixtureId); m.probs = p; m.priceNames = u.priceNames; m.upcoming = false; m.updatedAt = Date.now(); push("match", m); }
    }
    for (const sig of detector.update(u, { goalWindow })) {
      card(sig.fixtureId).lastSignalAt = sig.at;
      const logged = await audit.record(sig);
      console.log(`[SIGNAL:${sig.cause}] ${sig.market} fx${sig.fixtureId}: ${sig.direction} ${sig.outcome} ` +
        `${(sig.pFrom * 100).toFixed(1)}%→${(sig.pTo * 100).toFixed(1)}% (z=${sig.zScore})`);
      push("signal", logged);
    }
  });

  // --- scores -> final results -> self-grading ---
  // Reuses the exact stream parser the prop-vault keeper uses. Winner mapping
  // for match_odds: compare final goals P1 vs P2; draw -> null (ungraded).
  const scores = new LiveScoreStream(txline, false);
  const finals = new Map<number, { h?: number; a?: number; phase?: number }>();
  scores.on("score", (e) => {
    const d = e.data ?? {}; const f = d.fixtureId ?? d.fixture_id; if (!f) return;
    const st = finals.get(f) ?? {};
    const h = d.homeScore ?? d.home_score ?? d.score?.home;
    const a = d.awayScore ?? d.away_score ?? d.score?.away;
    const changed = (h != null && st.h !== Number(h)) || (a != null && st.a !== Number(a));
    if (h != null) st.h = Number(h);
    if (a != null) st.a = Number(a);
    { const m = card(f); m.h = st.h; m.a = st.a; const ph2 = d.phase ?? d.gamePhase ?? d.phaseId; if (ph2 != null) m.phase = Number(ph2); m.updatedAt = Date.now(); push("match", m); }
    if (changed && st.h != null) { // goal (or correction): tag the reprice window
      goalWindows.set(f, Date.now() + 90_000);
      push("goal", { fixtureId: f, score: `${st.h}-${st.a}` });
    }
    const ph = d.phase ?? d.gamePhase ?? d.phaseId;
    if (ph != null && TERMINAL.has(Number(ph)) && st.phase === undefined) {
      st.phase = Number(ph);
      const winner = st.h == null || st.a == null ? null
        : st.h > st.a ? "1" : st.a > st.h ? "2" : null; // priceName conventions verified on first live grade
      void audit.grade(f, winner, `${st.h ?? "?"}-${st.a ?? "?"}`)
        .then(() => push("graded", { fixtureId: f, stats: audit.stats() }));
      console.log(`[grade] fixture ${f} finished ${st.h}-${st.a}; graded signals updated`);
    }
    finals.set(f, st);
  });

  // --- status API: what a judge (or a trading desk) hits ---
  const app = express();
  app.use(express.static(path.join(process.cwd(), "src", "agent", "public")));

  // Watchdog: feed silence while anything is in-play is an alert, not a shrug.
  let feedAlert: string | null = null;
  setInterval(() => {
    // Before any odds have arrived, the feed isn't "silent" — it just hasn't
    // started (no live fixture yet). Only flag a genuine outage: seen odds,
    // then went quiet. This avoids the "no odds updates for Infinity min" bug.
    if (oddsSeen === 0) { feedAlert = null; return; }
    const quietMin = (Date.now() - lastOddsAt) / 60_000;
    feedAlert = quietMin > 10 ? `no odds updates for ${Math.round(quietMin)} min` : null;
    if (feedAlert) { console.warn(`[watchdog] ${feedAlert}`); push("alert", { alert: feedAlert }); }
  }, 60_000);

  app.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  app.get("/health", (_q, r) => r.json({
    alert: feedAlert,
    ok: true, agent: "sharp-move-detector", autonomous: true,
    oddsFeed: status, oddsUpdatesSeen: oddsSeen,
    awaitingFirstOdds: oddsSeen === 0,
    secondsSinceLastOdds: lastOddsAt ? Math.round((Date.now() - lastOddsAt) / 1000) : null,
    ...audit.stats(),
  }));
  app.get("/matches", (_q, r) => r.json([...matches.values()].sort((x, y) => y.updatedAt - x.updatedAt)));
  app.get("/signals", (_q, r) => r.json([...audit.signals].reverse().slice(0, 200).map((s) => ({
    ...s,
    explorer: s.memoTx ? `https://explorer.solana.com/tx/${s.memoTx}?cluster=${CFG.network}` : null,
  }))));
  app.listen(PORT, () => console.log(`[agent] status API on :${PORT} — /health /signals`));

  await odds.start();
  await scores.start();
  setInterval(() => void audit.sweep(), 300_000);
  console.log("[agent] running autonomously. Ctrl+C only if you must.");
}

main().catch((e) => { console.error("[agent] fatal:", e.message); process.exit(1); });

