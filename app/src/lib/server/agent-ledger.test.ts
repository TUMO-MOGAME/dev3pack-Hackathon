/** Plan §18.3 S2/S3: what the agent's own history can be trusted for. Fake RPC, no seed but a stand-in string. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { DAY_SECS, MAX_PAGES, PAGE, createLedger, grantMemo, grantsIn } from "./agent-ledger";

const agent = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const NOW = 1_800_000_000;

interface Tx { signature: string; at: number; memo?: string | null; err?: boolean; pre?: number }
let chain: Tx[]; // newest first
let balance: number;
let calls: { signatures: number; parsed: number };
let now: number;

const conn = {
  getSignaturesForAddress: async (_a: unknown, o: { limit: number; before?: string; until?: string }) => {
    calls.signatures++;
    const start = o.before ? chain.findIndex((t) => t.signature === o.before) + 1 : 0;
    let rows = chain.slice(start, start + o.limit);
    const stop = o.until ? rows.findIndex((t) => t.signature === o.until) : -1;
    if (stop >= 0) rows = rows.slice(0, stop);
    return rows.map((t) => ({ signature: t.signature, blockTime: t.at, memo: t.memo ?? null, err: t.err ? {} : null, slot: t.at }));
  },
  getBalance: async () => balance,
  getParsedTransaction: async (signature: string) => {
    calls.parsed++;
    const t = chain.find((x) => x.signature === signature)!;
    return { transaction: { message: { accountKeys: [{ pubkey: other }, { pubkey: agent }] } }, meta: { preBalances: [1, t.pre ?? balance] } };
  },
} as unknown as Connection;

const ledger = () => createLedger(agent, conn, () => now);
/** The memo field as the RPC returns it. */
const logged = (memo: string) => `[${memo.length}] ${memo}`;

beforeEach(() => {
  vi.stubEnv("AGENT_SEED_PHRASE", "stand-in words for a test only");
  chain = [];
  balance = 1_000_000_000;
  calls = { signatures: 0, parsed: 0 };
  now = NOW;
});
afterEach(() => vi.unstubAllEnvs());

describe("grant marks", () => {
  it("reads back the agent's own", () => {
    const { memo, grant } = grantMemo(NOW, 80_000_000, "wallet");
    expect(grantsIn([{ memo: logged(memo), failed: false }])).toEqual([grant]);
  });

  it("ignores a forged one, a changed one, and the old plain memo", () => {
    const { memo } = grantMemo(NOW, 80_000_000, "wallet");
    const forged = `heirloom-starter:${NOW}:80000000:${"a".repeat(16)}:${"b".repeat(32)}`;
    const changed = memo.replace(String(NOW), String(NOW + 1));
    expect(grantsIn([forged, changed, "heirloom-starter"].map((m) => ({ memo: m, failed: false })))).toEqual([]);
  });

  it("counts a copied one once, and a failed one never", () => {
    const { memo } = grantMemo(NOW, 1, "wallet");
    expect(grantsIn([{ memo, failed: false }, { memo, failed: false }])).toHaveLength(1);
    expect(grantsIn([{ memo, failed: true }])).toHaveLength(0);
  });

  it("means nothing under another agent's seed", () => {
    const { memo } = grantMemo(NOW, 1, "wallet");
    vi.stubEnv("AGENT_SEED_PHRASE", "some other stand-in");
    expect(grantsIn([{ memo, failed: false }])).toEqual([]);
  });

  it("holds no wallet address, only a short hash", () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    expect(grantMemo(NOW, 1, wallet).memo).not.toContain(wallet);
  });
});

describe("history", () => {
  const spam = (n: number, newest = NOW - 1, prefix = "spam") => Array.from({ length: n }, (_, i) => ({ signature: `${prefix}${i}`, at: newest - Math.floor(i / 10) }));

  it("pages back until it covers the day", async () => {
    chain = [...spam(2_500), { signature: "yesterday", at: NOW - DAY_SECS - 5 }];
    const h = await ledger().history();
    expect(h.from).toBeLessThanOrEqual(NOW - DAY_SECS);
    expect(calls.signatures).toBe(3);
  });

  it("an empty history covers the day", async () => {
    expect((await ledger().history()).from).toBeLessThanOrEqual(NOW - DAY_SECS);
  });

  it("after a flood it says it is incomplete, then catches up on the next read", async () => {
    const mine = { signature: "grant", at: NOW - 20_000, memo: grantMemo(NOW - 20_000, 1, "w").memo };
    chain = [...spam(MAX_PAGES * PAGE + 500), mine];
    const l = ledger();
    const first = await l.history();
    expect(first.from).toBeGreaterThan(NOW - DAY_SECS);
    expect(calls.signatures).toBe(MAX_PAGES);
    const second = await l.history();
    expect(second.from).toBeLessThanOrEqual(NOW - DAY_SECS);
    expect(grantsIn(second.txs)).toHaveLength(1);
  });

  it("the next read fetches only what is new, and lists each transaction once", async () => {
    chain = spam(1_500, NOW - 200);
    const l = ledger();
    await l.history();
    calls.signatures = 0;
    chain.unshift({ signature: "new", at: NOW });
    const h = await l.history();
    expect(calls.signatures).toBe(1);
    expect(h.txs[0].signature).toBe("new");
    expect(new Set(h.txs.map((t) => t.signature)).size).toBe(h.txs.length);
  });

  it("drops what left the day", async () => {
    chain = spam(50);
    const l = ledger();
    await l.history();
    now = NOW + 2 * DAY_SECS;
    expect((await l.history()).txs.length).toBeLessThanOrEqual(1);
  });
});

describe("spend", () => {
  it("is the fall in balance over the hour and the day", async () => {
    chain = [{ signature: "a", at: NOW - 100, pre: 1_020_000_000 }, { signature: "b", at: NOW - 50_000, pre: 1_300_000_000 }];
    expect(await ledger().spend()).toEqual({ hour: 20_000_000, day: 300_000_000, complete: true });
  });

  it("leaves out grants, which have their own pacing", async () => {
    chain = [{ signature: "g", at: NOW - 100, pre: 1_081_000_000, memo: logged(grantMemo(NOW - 100, 81_000_000, "w").memo) }];
    expect(await ledger().spend()).toMatchObject({ hour: 0, day: 0 });
  });

  it("someone else's mentions are not spend", async () => {
    chain = Array.from({ length: 300 }, (_, i) => ({ signature: `m${i}`, at: NOW - i }));
    expect(await ledger().spend()).toMatchObject({ hour: 0, day: 0 });
  });

  it("reads each earlier balance once", async () => {
    chain = [{ signature: "a", at: NOW - 100 }];
    const l = ledger();
    await l.spend();
    await l.spend();
    expect(calls.parsed).toBe(1);
  });
});
