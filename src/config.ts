// All environment wiring in one place. Copy .env.example -> .env and fill in.

import "dotenv/config";
import path from "path";

const network = (process.env.NETWORK ?? "devnet") as "devnet" | "mainnet";

const TXLINE = {
  devnet: {
    apiOrigin: "https://txline-dev.txodds.com",
    programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
    txlMint: "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG",
    rpcUrl: "https://api.devnet.solana.com",
  },
  mainnet: {
    apiOrigin: "https://txline.txodds.com",
    programId: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
    txlMint: "Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL",
    rpcUrl: "https://api.mainnet-beta.solana.com",
  },
}[network];

export const CFG = {
  network,
  port: Number(process.env.PORT ?? 8787),
  dataDir: process.env.DATA_DIR ?? path.resolve("data"),
  keypairPath: process.env.KEYPAIR_PATH ?? path.resolve("keypair.json"),
  adminKey: process.env.ADMIN_KEY ?? "change-me",
  replayFile: process.env.REPLAY_FILE || null,
  replaySpeed: Number(process.env.REPLAY_SPEED ?? 1),
  txline: {
    ...TXLINE,
    // Free World Cup tiers: 1 = 60s delay (devnet+mainnet), 12 = realtime (mainnet).
    serviceLevel: Number(process.env.TXLINE_SERVICE_LEVEL ?? 1),
    idlPath: process.env.TXORACLE_IDL ?? path.resolve("../idls/txoracle.json"),
  },
  solana: {
    rpcUrl: process.env.RPC_URL ?? TXLINE.rpcUrl,
  },
};
