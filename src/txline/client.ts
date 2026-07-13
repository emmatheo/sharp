// Thin REST client over the TxLINE endpoints we actually use.
// Endpoints verified against docs (examples/fetching-snapshots, onchain-validation):
//   GET /api/scores/snapshot/{fixtureId}?asOf={ms}
//   GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}
//   GET /api/scores/stat-validation?fixtureId&seq&statKey[&statKey2]
// List these three in the submission's "TxLINE endpoints used" section.

import axios, { AxiosInstance } from "axios";
import { CFG } from "../config.js";
import { TxlineCreds, authHeaders, getCredentials } from "./auth.js";

export interface StatValidation {
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: string;
  };
  subTreeProof: ProofNodeJson[];
  mainTreeProof: ProofNodeJson[];
  statToProve: unknown;
  eventStatRoot: string;
  statProof: ProofNodeJson[];
  statToProve2?: unknown;
  statProof2?: ProofNodeJson[];
}
export interface ProofNodeJson { hash: string; isRightSibling: boolean; }

export class TxlineClient {
  private http!: AxiosInstance;
  private creds!: TxlineCreds;

  async init(): Promise<this> {
    this.creds = await getCredentials();
    this.http = axios.create({
      baseURL: CFG.txline.apiOrigin,
      timeout: 30_000,
      headers: { "Content-Type": "application/json", ...authHeaders(this.creds) },
    });
    return this;
  }

  /** Current score state for one fixture. */
  async scoresSnapshot(fixtureId: number): Promise<any> {
    const r = await this.retrying(() =>
      this.http.get(`/api/scores/snapshot/${fixtureId}?asOf=${Date.now()}`));
    return r.data;
  }

  /** Recent updates in a 5-minute interval bucket (docs' epochDay/hour/interval scheme). */
  async scoresUpdatesAt(when: Date): Promise<any> {
    const epochDay = Math.floor(when.getTime() / 86_400_000);
    const hourOfDay = when.getUTCHours();
    const interval = Math.floor(when.getUTCMinutes() / 5);
    const r = await this.retrying(() =>
      this.http.get(`/api/scores/updates/${epochDay}/${hourOfDay}/${interval}`));
    return r.data;
  }

  /**
   * Merkle proof bundle for one or two stats at a specific update seq.
   * This is the raw material the keeper feeds into our settle instruction.
   */
  async statValidation(fixtureId: number, seq: number, statKey: number, statKey2?: number): Promise<StatValidation> {
    const params: Record<string, number> = { fixtureId, seq, statKey };
    if (statKey2 !== undefined) params.statKey2 = statKey2;
    const r = await this.retrying(() => this.http.get(`/api/scores/stat-validation`, { params }));
    return r.data as StatValidation;
  }

  headers() { return authHeaders(this.creds); }

  /** 401 => re-onboard once (JWT expiry); 5xx/network => 3 retries with backoff. */
  private async retrying<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.response?.status === 401 && attempt === 0) {
        console.warn("[txline] 401 — refreshing credentials");
        this.creds = await getCredentials();
        this.http.defaults.headers = { ...this.http.defaults.headers, ...authHeaders(this.creds) } as any;
        return this.retrying(fn, attempt + 1);
      }
      if (attempt < 3) {
        const wait = 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, wait));
        return this.retrying(fn, attempt + 1);
      }
      throw e;
    }
  }
}
