import "server-only";
/**
 * Starter funds for a new devnet wallet, so a person with nothing can create, fund and use a plan: a little SOL for
 * account rent and some test USD₮, both from the agent's wallet. Devnet only.
 *
 * The limits are read from the chain, so they hold across server instances and restarts:
 *  - once per wallet: it must have no test-USD₮ account yet and almost no SOL;
 *  - a daily cap: the grants carry a memo, counted in the agent's recent transactions;
 *  - a reserve: the agent always keeps enough SOL for reviews and sponsored fees.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import { HttpError } from "../api/http";
import { agentAddress, agentCoSign, hasAgentWallet } from "../agent/agent-wallet";
import { chainConfig } from "../chain/config";
import { ata } from "../chain/pda";
import { base64ToBytes, bytesToBase64, confirmOrThrow, getConnection } from "../chain/tx";
import { explorerTx } from "../format";

export const STARTER = {
  lamports: 90_000_000, // rent for an estate, its people, rules, guard, one asset and practice wallets
  usdt: 500_000_000n, // 500 test USD₮
  perDay: 15,
  reserveLamports: 300_000_000,
  alreadyFundedLamports: 20_000_000,
  memo: "heirloom-starter",
} as const;

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export const starterAvailable = () =>
  chainConfig.dataMode === "chain" && chainConfig.cluster === "devnet" && hasAgentWallet() && Boolean(chainConfig.usdtMint);

export type StarterRefusal = "already_funded" | "daily_cap" | "empty";

/** Pure: why this grant must be refused, or null. */
export function starterRefusal(s: {
  walletLamports: number; walletHasUsdtAccount: boolean; grantsToday: number; agentLamports: number; agentUsdt: bigint;
}): StarterRefusal | null {
  if (s.walletHasUsdtAccount || s.walletLamports >= STARTER.alreadyFundedLamports) return "already_funded";
  if (s.grantsToday >= STARTER.perDay) return "daily_cap";
  if (s.agentLamports - STARTER.lamports < STARTER.reserveLamports || s.agentUsdt < STARTER.usdt) return "empty";
  return null;
}

const MESSAGES: Record<StarterRefusal, string> = {
  already_funded: "This wallet already has test money.",
  daily_cap: "Today's starter funds are used up. Please try again tomorrow.",
  empty: "The starter wallet is empty right now.",
};

export async function grantStarter(wallet: string, conn: Connection = getConnection()): Promise<{ signature: string; explorerUrl: string; sol: number; usdt: number }> {
  if (!starterAvailable()) throw new HttpError(503, "Starter funds are only on the test network.", "unavailable");
  const to = new PublicKey(wallet);
  if (!PublicKey.isOnCurve(to.toBytes())) throw new HttpError(400, "Starter funds go only to a person's wallet.", "bad_wallet");
  const from = new PublicKey((await agentAddress())!);
  if (from.equals(to)) throw new HttpError(400, "Starter funds go only to a person's wallet.", "bad_wallet");
  const mint = new PublicKey(chainConfig.usdtMint);
  const [toAta, fromAta] = [ata(mint, to), ata(mint, from)];

  const [walletLamports, account, agentLamports, agentUsdt, recent] = await Promise.all([
    conn.getBalance(to, "confirmed"),
    conn.getAccountInfo(toAta, "confirmed"),
    conn.getBalance(from, "confirmed"),
    conn.getTokenAccountBalance(fromAta, "confirmed").then((b) => BigInt(b.value.amount)).catch(() => 0n),
    conn.getSignaturesForAddress(from, { limit: 1000 }, "confirmed"),
  ]);
  const since = Date.now() / 1000 - 86_400;
  const grantsToday = recent.filter((s) => !s.err && (s.blockTime ?? 0) >= since && s.memo?.includes(STARTER.memo)).length;
  const refused = starterRefusal({ walletLamports, walletHasUsdtAccount: account !== null, grantsToday, agentLamports, agentUsdt });
  if (refused) throw new HttpError(refused === "already_funded" ? 409 : 429, MESSAGES[refused], refused);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: from, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: STARTER.lamports }),
    createAssociatedTokenAccountIdempotentInstruction(from, toAta, to, mint),
    createTransferCheckedInstruction(fromAta, mint, toAta, from, STARTER.usdt, 6),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(STARTER.memo, "utf8") }),
  );
  const { wireBase64, signature } = await agentCoSign(bytesToBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
  await conn.sendRawTransaction(base64ToBytes(wireBase64), { maxRetries: 3 });
  await confirmOrThrow(signature);
  return { signature, explorerUrl: explorerTx(signature), sol: STARTER.lamports / 1e9, usdt: Number(STARTER.usdt / 1_000_000n) };
}
