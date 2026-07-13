// Odds ingestion for the Sharp-Move Detector.
// TxLINE's scores endpoints are verified; the odds paths follow the same
// pattern but are VERIFY-ON-FIRST-RUN: this client tries the SSE stream,
// falls back to 60s polling (the sponsor's own suggested cadence), and logs
// loudly which mode it landed in. Everything downstream is source-agnostic.

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { CFG } from "../config.js";
import { TxlineClient } from "../txline/client.js";
import { readSseMessages } from "../txline/stream.js";

export interface OddsUpdate {
  fixtureId: number;
  bookmaker?: string;
  superOddsType?: string;   // market type, e.g. match odds
  priceNames: string[];     // outcome labels
  prices: number[];         // prices as sent (scale auto-detected downstream)
  inRunning?: boolean;
  ts: number;               // feed timestamp (ms) if present, else receipt time
  receivedAt: number;
  raw: any;
}

export declare interface OddsSource {
  on(ev: "odds", cb: (o: OddsUpdate) => void): this;
  on(ev: "status", cb: (s: string) => void): this;
}
export class OddsSource extends EventEmitter {
  private stopped = false;
  private rec: fs.WriteStream;

  constructor(private client: TxlineClient) {
    super();
    const dir = path.join(CFG.dataDir, "recordings");
    fs.mkdirSync(dir, { recursive: true });
    this.rec = fs.createWriteStream(
      path.join(dir, `odds-${new Date().toISOString().slice(0, 10)}.jsonl`), { flags: "a" });
  }

  async start() {
    if (process.env.REPLAY_ODDS_FILE) { void this.replayLoop(process.env.REPLAY_ODDS_FILE); return; }
    if (await this.tryStream()) return;
    this.emit("status", "SSE odds stream unavailable — falling back to 60s polling");
    void this.pollLoop();
  }

  /** Replay recorded odds JSONL through the same pipeline (rules allow
   *  "live or simulated TxLINE data feeds" — this is the demo-day mode). */
  private async replayLoop(file: string) {
    const speed = Number(process.env.REPLAY_SPEED ?? 20);
    this.emit("status", `REPLAY mode: ${file} at ${speed}x`);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    let prev: number | null = null;
    for (const line of lines) {
      if (this.stopped) return;
      const o = JSON.parse(line);
      if (prev !== null) {
        const gap = Math.min(Math.max(0, (o.receivedAt - prev) / speed), 8000);
        await new Promise((r) => setTimeout(r, gap));
      }
      prev = o.receivedAt;
      this.seen.delete(`${o.fixtureId}|${o.raw?.messageId ?? o.raw?.message_id ?? o.ts}`);
      this.ingest(o.raw ?? o);
    }
    this.emit("status", "replay finished");
  }
  stop() { this.stopped = true; this.rec.end(); }

  private async tryStream(): Promise<boolean> {
    try {
      const res = await fetch(`${CFG.txline.apiOrigin}/api/odds/stream`, {
        headers: { ...this.client.headers(), Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) return false;
      this.emit("status", "connected to /api/odds/stream (SSE)");
      void (async () => {
        try {
          for await (const msg of readSseMessages(res.body!)) this.ingest(safeJson(msg.data));
        } catch (e: any) {
          this.emit("status", `odds stream dropped (${e.message}); restarting`);
          if (!this.stopped) setTimeout(() => void this.start(), 3000);
        }
      })();
      return true;
    } catch { return false; }
  }

  /** Fallback: poll recent odds updates every 60s (sponsor's suggested cadence). */
  private async pollLoop() {
    while (!this.stopped) {
      try {
        const now = new Date();
        const epochDay = Math.floor(now.getTime() / 86_400_000);
        const hour = now.getUTCHours();
        const interval = Math.floor(now.getUTCMinutes() / 5);
        const r = await fetch(
          `${CFG.txline.apiOrigin}/api/odds/updates/${epochDay}/${hour}/${interval}`,
          { headers: this.client.headers() });
        if (r.ok) {
          const body = await r.json();
          const rows: any[] = Array.isArray(body) ? body : body?.updates ?? [];
          for (const row of rows) this.ingest(row);
          this.emit("status", `polled ${rows.length} odds rows`);
        } else {
          this.emit("status", `odds poll HTTP ${r.status} — check endpoint path against docs`);
        }
      } catch (e: any) {
        this.emit("status", `odds poll error: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }

  private seen = new Set<string>();
  private ingest(d: any) {
    if (!d || typeof d !== "object") return;
    const fixtureId = d.fixtureId ?? d.fixture_id;
    const prices = d.prices ?? d.price ?? [];
    if (!fixtureId || !Array.isArray(prices) || prices.length === 0) return;
    const key = `${fixtureId}|${d.messageId ?? d.message_id ?? d.ts}`;
    if (this.seen.has(key)) return; // dedupe poll overlap
    this.seen.add(key);
    if (this.seen.size > 50_000) this.seen.clear();
    const o: OddsUpdate = {
      fixtureId: Number(fixtureId),
      bookmaker: d.bookmaker,
      superOddsType: d.superOddsType ?? d.super_odds_type,
      priceNames: d.priceNames ?? d.price_names ?? [],
      prices: prices.map(Number),
      inRunning: d.inRunning ?? d.in_running,
      ts: Number(d.ts ?? Date.now()),
      receivedAt: Date.now(),
      raw: d,
    };
    this.rec.write(JSON.stringify(o) + "\n");
    this.emit("odds", o);
  }
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return null; } }
