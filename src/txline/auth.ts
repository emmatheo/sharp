// TxLINE free-tier onboarding, verbatim against their Quickstart/World Cup docs:
//   1. POST {apiOrigin}/auth/guest/start            -> guest JWT
//   2. on-chain subscribe(SERVICE_LEVEL, WEEKS)     -> txSig   (free: no TxL needed)
//   3. sign `${txSig}:${leagues.join(",")}:${jwt}`  (empty leagues => `${txSig}::${jwt}`)
//   4. POST {apiBase}/token/activate                -> apiToken
// Every data call then sends BOTH:  Authorization: Bearer <jwt>  and  X-Api-Token: <apiToken>

import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import axios from "axios";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";
import { CFG } from "../config.js";

const CACHE_FILE = path.join(CFG.dataDir, "txline-credentials.json");
const SERVICE_LEVEL_ID = CFG.txline.serviceLevel; // 1 = WC free 60s-delay, 12 = WC free realtime (mainnet)
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES: number[] = [];

export interface TxlineCreds { jwt: string; apiToken: string; obtainedAt: number; }

export async function getCredentials(): Promise<TxlineCreds> {
  if (fs.existsSync(CACHE_FILE)) {
    const cached: TxlineCreds = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    // JWTs are time-limited; refresh conservatively every 12h.
    if (Date.now() - cached.obtainedAt < 12 * 3600_000) return cached;
  }
  const creds = await onboard();
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(creds, null, 2));
  return creds;
}

async function onboard(): Promise<TxlineCreds> {
  const keypair = loadKeypair(CFG.keypairPath);
  const connection = new Connection(CFG.solana.rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(CFG.txline.idlPath, "utf8"));
  const program = new anchor.Program(idl, provider);
  if (program.programId.toBase58() !== CFG.txline.programId) {
    throw new Error(`IDL program ${program.programId} != configured ${CFG.txline.programId} — network mismatch`);
  }

  // 1) guest JWT — note: /auth is on the ORIGIN, not under /api
  const auth = await axios.post(`${CFG.txline.apiOrigin}/auth/guest/start`);
  const jwt: string = auth.data.token;

  // 2) on-chain free subscribe (idempotent to re-run: cheap devnet tx)
  const txlMint = new PublicKey(CFG.txline.txlMint);
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")], program.programId);
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    txlMint, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")], program.programId);
  const userTokenAccount = getAssociatedTokenAddressSync(
    txlMint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .preInstructions([
      // The subscribe ix requires the user's TxL token account to exist even
      // on the free tier (it holds 0 TxL). Create it if missing — idempotent,
      // so re-runs are safe. TxL is a Token-2022 mint.
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,        // payer
        userTokenAccount,        // ata to create
        wallet.publicKey,        // owner
        txlMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    ])
    .accounts({
      user: wallet.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: txlMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`[txline] subscribed on-chain (level ${SERVICE_LEVEL_ID}): ${txSig}`);

  // 3) sign activation message with the SAME wallet
  const message = new TextEncoder().encode(`${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`);
  const walletSignature = Buffer.from(nacl.sign.detached(message, keypair.secretKey)).toString("base64");

  // 4) activate
  const activation = await axios.post(
    `${CFG.txline.apiOrigin}/api/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  const apiToken: string = activation.data.token || activation.data;
  console.log("[txline] api token activated");
  return { jwt, apiToken, obtainedAt: Date.now() };
}

export function authHeaders(c: TxlineCreds) {
  return { Authorization: `Bearer ${c.jwt}`, "X-Api-Token": c.apiToken };
}

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEYPAIR_JSON ?? fs.readFileSync(p, "utf8"))));
}
