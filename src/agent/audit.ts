// Audit trail + self-grading — the part that makes this agent unfakeable.
//
// Every signal is written two places:
//   1. data/signals.jsonl (full record, local)
//   2. Solana devnet, as a Memo transaction: hash-stamped, timestamped by the
//      chain, publicly verifiable. A tipster can delete a tweet; this agent
//      cannot delete a memo. No custom program needed — Memo ships with Solana.
// When a fixture finishes (phase F/FET/FPE from the scores stream we already
// parse), match-winner signals are GRADED: did the outcome the money moved
// toward actually win? Accuracy stats are public via the status API, and the
// grade is memo-logged too, referencing the original signal tx.

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CFG } from "../config.js";
import { Signal } from "./detector.js";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TySNcWxMyWCqXgDLGmfcHr");

export interface LoggedSignal extends Signal {
  memoTx?: string;
  grade?: { won: boolean; finalScore?: string; gradedAt: number; gradeMemoTx?: string };
}

export class AuditLog {
  private conn: Connection;
  private payer: Keypair;
  private file: string;
  signals: LoggedSignal[] = [];

  constructor() {
    this.conn = new Connection(CFG.solana.rpcUrl, "confirmed");
    this.payer = Keypair.fromSecretKey(Uint8Array.from(
      JSON.parse(process.env.KEYPAIR_JSON ?? fs.readFileSync(CFG.keypairPath, "utf8"))));
    this.file = path.join(CFG.dataDir, "signals.jsonl");
    if (fs.existsSync(this.file)) {
      this.signals = fs.readFileSync(this.file, "utf8").split("\n")
        .filter(Boolean).map((l) => JSON.parse(l));
    }
  }

  // Memo queue: paces RPC writes (1/sec) and batches goal-cascade bursts into
  // a single memo, so a 10-signal minute costs 1-2 txs, not 10, and rate
  // limits can't drop a signal. Signals are visible locally instantly.
  private queue: LoggedSignal[] = [];
  private pumping = false;

  async record(sig: Signal): Promise<LoggedSignal> {
    const logged: LoggedSignal = { ...sig };
    this.signals.push(logged);
    this.persist();
    this.queue.push(logged);
    void this.pump();
    return logged;
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length) {
      const batch = this.queue.splice(0, 4); // burst batching
      try {
        const tx = await this.memo({
          t: batch.length > 1 ? "signal-batch" : "signal",
          s: batch.map((x) => ({ id: x.id, fx: x.fixtureId, out: x.outcome, dir: x.direction,
            from: x.pFrom, to: x.pTo, z: x.zScore, c: x.cause, sha: sha8(x) })),
        });
        for (const x of batch) x.memoTx = tx;
        this.persist();
      } catch (e: any) {
        console.warn(`[audit] memo batch failed (${e.message}); requeued for sweep`);
      }
      await new Promise((r) => setTimeout(r, 1000)); // pace the RPC
    }
    this.pumping = false;
  }

  async grade(fixtureId: number, winnerOutcome: string | null, finalScore?: string) {
    for (const s of this.signals) {
      if (s.fixtureId !== fixtureId || s.grade || s.market !== "match_odds") continue;
      if (winnerOutcome === null) continue; // draws/no-result: leave ungraded rather than guess
      const won = s.direction === "toward"
        ? s.outcome === winnerOutcome
        : s.outcome !== winnerOutcome;
      s.grade = { won, finalScore, gradedAt: Date.now() };
      try {
        s.grade.gradeMemoTx = await this.memo({
          t: "grade", ref: s.memoTx ?? s.id, won, score: finalScore, sha: sha8(s),
        });
      } catch { /* local grade stands; memo retried by sweep */ }
    }
    this.persist();
  }

  /** Retry any signal that never got its memo (RPC hiccups). Call every ~5 min. */
  async sweep() {
    for (const s of this.signals) {
      if (!s.memoTx) {
        try { s.memoTx = await this.memo({ t: "signal-late", id: s.id, sha: sha8(s) }); }
        catch { /* next sweep */ }
      }
    }
    this.persist();
  }

  stats() {
    const graded = this.signals.filter((s) => s.grade);
    const wins = graded.filter((s) => s.grade!.won).length;
    const sharp = graded.filter((s) => (s as any).cause !== "goal-reprice");
    const sharpWins = sharp.filter((s) => s.grade!.won).length;
    return {
      totalSignals: this.signals.length,
      onChain: this.signals.filter((s) => s.memoTx).length,
      graded: graded.length,
      correct: wins,
      accuracy: graded.length ? Math.round((wins / graded.length) * 1000) / 10 : null,
      sharpOnlyGraded: sharp.length,
      sharpOnlyAccuracy: sharp.length ? Math.round((sharpWins / sharp.length) * 1000) / 10 : null,
    };
  }

  private async memo(payload: object): Promise<string> {
    const ix = new TransactionInstruction({
      keys: [{ pubkey: this.payer.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM,
      data: Buffer.from(JSON.stringify(payload).slice(0, 560), "utf8"),
    });
    return sendAndConfirmTransaction(this.conn, new Transaction().add(ix), [this.payer]);
  }

  private persist() {
    fs.mkdirSync(CFG.dataDir, { recursive: true });
    fs.writeFileSync(this.file, this.signals.map((s) => JSON.stringify(s)).join("\n") + "\n");
  }
}

const sha8 = (o: object) =>
  crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
