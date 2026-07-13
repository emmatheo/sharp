// One EventEmitter interface, two sources:
//   LiveScoreStream   — GET /api/scores/stream (SSE) with reconnect + backoff,
//                       and it RECORDS every event to a JSONL file.
//   ReplayScoreStream — replays a recorded JSONL at 1x/Nx speed.
// Everything downstream (keeper, API server, frontend) listens to the same
// events and cannot tell live from replay. That is the demo-video insurance
// the judges explicitly asked for ("matches will end before review").
//
// Record every remaining knockout match from today. Storage is trivial;
// regret is not.

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import readline from "readline";
import { CFG } from "../config.js";
import { TxlineClient } from "./client.js";

export interface ScoreEvent {
  event: string;        // SSE event name (or "message")
  data: any;            // parsed JSON payload
  receivedAt: number;   // ms epoch when we saw it
}

export declare interface ScoreStream {
  on(ev: "score", cb: (e: ScoreEvent) => void): this;
  on(ev: "status", cb: (s: string) => void): this;
}
export class ScoreStream extends EventEmitter {}

// ---------- live ----------

export class LiveScoreStream extends ScoreStream {
  private stopped = false;
  private recordFile: fs.WriteStream | null = null;

  constructor(private client: TxlineClient, private record = true) { super(); }

  async start(): Promise<void> {
    if (this.record) {
      const dir = path.join(CFG.dataDir, "recordings");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `scores-${new Date().toISOString().slice(0, 10)}.jsonl`);
      this.recordFile = fs.createWriteStream(file, { flags: "a" });
      console.log(`[stream] recording to ${file}`);
    }
    void this.loop();
  }

  stop() { this.stopped = true; this.recordFile?.end(); }

  private async loop() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        this.emit("status", "connecting");
        const res = await fetch(`${CFG.txline.apiOrigin}/api/scores/stream`, {
          headers: {
            ...this.client.headers(),
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
        this.emit("status", "connected");
        backoff = 1000; // reset after a good connection

        for await (const msg of readSseMessages(res.body)) {
          const evt: ScoreEvent = {
            event: msg.event ?? "message",
            data: safeJson(msg.data),
            receivedAt: Date.now(),
          };
          this.recordFile?.write(JSON.stringify(evt) + "\n");
          this.emit("score", evt);
        }
        throw new Error("stream ended");
      } catch (e: any) {
        if (this.stopped) return;
        this.emit("status", `disconnected: ${e.message}; retry in ${backoff}ms`);
        console.warn(`[stream] ${e.message}; reconnecting in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
}

// ---------- replay ----------

export class ReplayScoreStream extends ScoreStream {
  constructor(private file: string, private speed = 1) { super(); }

  async start(): Promise<void> {
    const rl = readline.createInterface({ input: fs.createReadStream(this.file) });
    let prevTs: number | null = null;
    this.emit("status", `replaying ${path.basename(this.file)} at ${this.speed}x`);
    for await (const line of rl) {
      if (!line.trim()) continue;
      const evt: ScoreEvent = JSON.parse(line);
      if (prevTs !== null) {
        const gap = Math.max(0, (evt.receivedAt - prevTs) / this.speed);
        await sleep(Math.min(gap, 15_000)); // cap dead air so demos stay tight
      }
      prevTs = evt.receivedAt;
      evt.receivedAt = Date.now(); // downstream sees "now"
      this.emit("score", evt);
    }
    this.emit("status", "replay finished");
  }
}

export function makeStream(client: TxlineClient): ScoreStream & { start(): Promise<void> } {
  if (CFG.replayFile) return new ReplayScoreStream(CFG.replayFile, CFG.replaySpeed);
  return new LiveScoreStream(client);
}

// ---------- SSE parsing (docs reference these helpers by name) ----------

export async function* readSseMessages(body: ReadableStream<Uint8Array> | NodeJS.ReadableStream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const msg: { event?: string; data: string } = { data: "" };
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) msg.event = line.slice(6).trim();
        else if (line.startsWith("data:")) msg.data += line.slice(5).trim();
      }
      if (msg.data) yield msg;
    }
  }
}

function safeJson(s: string): any { try { return JSON.parse(s); } catch { return s; } }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
