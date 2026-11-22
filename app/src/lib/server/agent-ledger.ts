import "server-only";
/**
 * What the chain says the agent's wallet did lately (plan §18.3 S2, S3), so limits hold without a shared store.
 *
 * Anyone can mention the agent's address in a transaction, or write any memo, for 5,000 lamports. So:
 *  - a starter grant counts only with a memo carrying an HMAC under a key derived from the agent's seed, and once
 *    per HMAC, so a copied memo adds nothing. The memo holds a time, a cost and a short hash of the recipient's
 *    wallet (which the transfer itself shows), never an IP address or anything made from one;
 *  - spend is measured as the fall in the agent's SOL balance, which nobody else's transaction can cause.
 * A flood of mentions can only make the history longer: it is paged, kept, and continued on the next read.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Connection, PublicKey } from "@solana/web3.js";
import { withDeadline } from "./deadline";

export const HOUR_SECS = 3_600;
export const DAY_SECS = 86_400;
/** getSignaturesForAddress' most per call. */
export const PAGE = 1_000;
/** Calls per read. */
export const MAX_PAGES = 10;

const READ_MS = 8_000;
/** All the pages of one read. A read given up on still finishes, for the next caller. */
const HISTORY_MS = 15_000;
/** A confirmed transaction can appear a little late: this much of what is held is read again. */
const SETTLE_SECS = 90;
const KEEP_SECS = DAY_SECS + HOUR_SECS;

export interface LedgerTx { signature: string; at: number; memo: string | null; failed: boolean }
/** `txs` newest first; complete from `from` (unix seconds) until `readAt`. */
export interface History { txs: LedgerTx[]; from: number; readAt: number }
export interface Grant { at: number; lamports: number; wallet: string; mac: string }

const MEMO = "heirloom-starter";
const MEMO_PATTERN = /heirloom-starter:(\d{1,12}):(\d{1,12}):([0-9a-f]{16}):([0-9a-f]{32})/g;

/** A key of our own from the agent's seed: no new secret to configure, and it can't sign anything. */
function grantKey(): Buffer | null {
  const seed = process.env.AGENT_SEED_PHRASE?.trim().split(/\s+/).join(" ");
  return seed ? createHmac("sha256", seed).update("heirloom starter grant marks v1").digest() : null;
}

export const walletTag = (wallet: string) => createHash("sha256").update(wallet, "utf8").digest("hex").slice(0, 16);
const macOf = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest("hex").slice(0, 32);

/** The memo of a grant the agent makes, and the grant it records. */
export function grantMemo(at: number, lamports: number, wallet: string): { memo: string; grant: Grant } {
  const key = grantKey();
  if (!key) throw new Error("The agent wallet is not configured.");
  const tag = walletTag(wallet);
  const body = `${MEMO}:${at}:${lamports}:${tag}`;
  const mac = macOf(key, body);
  return { memo: `${body}:${mac}`, grant: { at, lamports, wallet: tag, mac } };
}

/** The real grants among these transactions, newest first, each once. */
export function grantsIn(txs: Pick<LedgerTx, "memo" | "failed">[]): Grant[] {
  const key = grantKey();
  if (!key) return [];
  const out = new Map<string, Grant>();
  for (const t of txs) {
    if (t.failed || !t.memo) continue;
    for (const [, at, lamports, wallet, mac] of t.memo.matchAll(MEMO_PATTERN)) {
      const expected = macOf(key, `${MEMO}:${at}:${lamports}:${wallet}`);
      if (timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) {
        out.set(mac, { at: Number(at), lamports: Number(lamports), wallet, mac });
      }
    }
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

const unixNow = () => Math.floor(Date.now() / 1000);

export function createLedger(address: PublicKey, conn: Connection, clock: () => number = unixNow) {
  let held: History | null = null;
  let reading: Promise<History> | null = null;
  /** The agent's balance just before a transaction never changes, so it is read once. */
  const before = new Map<string, number>();

  async function page(opts: { before?: string; until?: string }): Promise<LedgerTx[]> {
    const rows = await withDeadline(
      conn.getSignaturesForAddress(address, { limit: PAGE, ...opts }, "confirmed"), READ_MS, "Reading the agent's history",
    );
    return rows.map((r) => ({ signature: r.signature, at: r.blockTime ?? clock(), memo: r.memo, failed: !!r.err }));
  }

  async function read(): Promise<History> {
    const now = clock();
    const since = now - DAY_SECS;
    let pages = MAX_PAGES;
    let txs: LedgerTx[] = [];
    let from = Infinity;

    // What is new since the last read.
    if (held?.txs.length) {
      const anchor = held.txs.find((t) => t.at <= now - SETTLE_SECS);
      const fresh: LedgerTx[] = [];
      let cursor: string | undefined;
      let joined = false;
      while (pages > 0 && !joined) {
        pages--;
        const got = await page({ before: cursor, until: anchor?.signature });
        fresh.push(...got);
        cursor = got.at(-1)?.signature;
        // Either it reached what is held, or it went past the day and what is held no longer matters.
        joined = got.length < PAGE || got[got.length - 1].at < since;
      }
      if (joined) {
        const known = new Set(fresh.map((t) => t.signature));
        txs = [...fresh, ...held.txs.filter((t) => !known.has(t.signature))];
        from = held.from;
        if (fresh.length >= PAGE && fresh[fresh.length - 1].at < since) from = Math.min(from, since);
      } else {
        // Too much is new to join up: keep the newest part, and carry on back from there.
        txs = fresh;
        from = fresh[fresh.length - 1].at;
      }
    }

    // Further back, until the day is covered.
    while (pages > 0 && from > since) {
      pages--;
      const got = await page({ before: txs.at(-1)?.signature });
      txs.push(...got);
      from = got.length < PAGE ? 0 : got[got.length - 1].at;
    }

    const keep = now - KEEP_SECS;
    held = { txs: txs.filter((t, i) => i === 0 || t.at >= keep), from: Math.max(from, keep), readAt: now };
    return held;
  }

  /** The agent's transactions over the last day. */
  function history(): Promise<History> {
    reading ??= read().finally(() => { reading = null; });
    return withDeadline(reading, HISTORY_MS, "Reading the agent's history");
  }

  async function balanceBefore(signature: string): Promise<number> {
    const known = before.get(signature);
    if (known !== undefined) return known;
    const tx = await withDeadline(
      conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
      READ_MS, "Reading the agent's earlier balance",
    );
    const at = tx?.transaction.message.accountKeys.findIndex((k) => k.pubkey.equals(address)) ?? -1;
    const lamports = at >= 0 ? tx?.meta?.preBalances[at] : undefined;
    if (lamports === undefined) throw new Error("The agent's earlier balance could not be read.");
    if (before.size > 1_000) before.clear();
    before.set(signature, lamports);
    return lamports;
  }

  /**
   * SOL the agent spent in the last hour and day, apart from starter grants (those have their own pacing).
   * `complete` is false when the history didn't reach back a day: then each number is a lower bound.
   */
  async function spend(): Promise<{ hour: number; day: number; complete: boolean }> {
    const h = await history();
    const balance = await withDeadline(conn.getBalance(address, "confirmed"), READ_MS, "Reading the agent's balance");
    const grants = grantsIn(h.txs);
    const spentSince = async (since: number) => {
      const oldest = h.txs.findLast((t) => t.at >= since);
      if (!oldest) return 0;
      const granted = grants.filter((g) => g.at >= since).reduce((sum, g) => sum + g.lamports, 0);
      return (await balanceBefore(oldest.signature)) - balance - granted;
    };
    const hour = await spentSince(h.readAt - HOUR_SECS);
    const day = await spentSince(h.readAt - DAY_SECS);
    return { hour, day, complete: h.from <= h.readAt - DAY_SECS };
  }

  return { history, spend };
}

export type AgentLedger = ReturnType<typeof createLedger>;

let instance: { address: string; ledger: AgentLedger } | null = null;

/** The one ledger of this server instance. */
export function agentLedger(address: PublicKey, conn: Connection): AgentLedger {
  if (instance?.address !== address.toBase58()) instance = { address: address.toBase58(), ledger: createLedger(address, conn) };
  return instance.ledger;
}
