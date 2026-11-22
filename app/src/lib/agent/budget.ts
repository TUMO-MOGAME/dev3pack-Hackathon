import "server-only";
/**
 * Keeps the agent's SOL from being drained through requests that are each valid (plan §18.3 S3):
 *  1. a daily allowance per wallet and per estate, on this instance;
 *  2. the same allowance across instances, when the shared store is there;
 *  3. without it, a backstop read from the chain: what the agent's balance fell by in the last hour and day. If the
 *     chain can't be read (a 429) the last good reading stands for ten minutes; after that a handful of requests
 *     still go through, so a busy RPC doesn't switch the test site off, and then it waits.
 * The balance reserve (agent-wallet.ts) is the last line under all three.
 */
import { PublicKey } from "@solana/web3.js";
import { HttpError } from "../api/http";
import type { AgentAction } from "../access/messages";
import { agentLedger } from "../server/agent-ledger";
import { takeShared } from "../server/shared-store";
import { getConnection } from "../chain/tx";
import { agentAddress } from "./agent-wallet";

const DAY_MS = 86_400_000;

export const AGENT_DAILY: Record<Exclude<AgentAction, "starter">, { wallet: number; estate: number }> = {
  review: { wallet: 20, estate: 40 },
  "list-asset": { wallet: 6, estate: 10 },
  "accept-offer": { wallet: 6, estate: 10 },
};

/**
 * The chain backstop. Lamports, for everything but starter grants: the sponsor's whole daily budget (0.3 SOL) can be
 * one judging hour, so the hour allows that plus 0.05 SOL of the agent's own signatures, the day that plus 0.1 SOL.
 */
export const AGENT_SPEND = {
  hour: 350_000_000,
  day: 400_000_000,
  /** A reading is used again for this long. */
  freshMs: 20_000,
  /** And, when the chain can't be read, for this long. */
  staleMs: 10 * 60_000,
  /** Requests let through on one instance with no usable reading, per `staleMs`. */
  blind: 10,
} as const;

const hits = new Map<string, number[]>();
let reading: { at: number; hour: number; day: number; complete: boolean } | null = null;
let blind: number[] = [];

const limitReached = (retryAfterSecs: number) =>
  new HttpError(429, "The agent reached today's limit for this. Please try again tomorrow.", "agent_limit", retryAfterSecs);

/** Also the fee sponsor's: the same wallet pays. Throws when the agent spent too much lately. Always await it. */
export async function chainBackstop(now: number): Promise<void> {
  if (!reading || now - reading.at > AGENT_SPEND.freshMs) {
    try {
      const agent = await agentAddress();
      if (!agent) throw new Error("no agent wallet");
      reading = { at: now, ...(await agentLedger(new PublicKey(agent), getConnection()).spend()) };
    } catch (e) {
      console.warn(`[agent-budget] could not read the chain backstop (${e instanceof Error ? e.name : "error"})`);
    }
  }
  const usable = reading && now - reading.at <= AGENT_SPEND.staleMs ? reading : null;
  if (usable && usable.day >= AGENT_SPEND.day) {
    throw new HttpError(429, "The agent reached its spending limit for today. Please try again in a few hours.", "agent_limit", 3 * 3_600);
  }
  if (usable && usable.hour >= AGENT_SPEND.hour) {
    throw new HttpError(429, "The agent reached its spending limit for this hour. Please try again in an hour.", "agent_limit", 3_600);
  }
  if (usable?.complete) return;
  blind = blind.filter((t) => now - t < AGENT_SPEND.staleMs);
  if (blind.length >= AGENT_SPEND.blind) {
    throw new HttpError(503, "The network is busy. Please try again in a minute.", "busy", 60);
  }
  blind.push(now);
}

/** Throws when the agent should not sign this. Always await it. */
export async function spendAgentAllowance(action: keyof typeof AGENT_DAILY, wallet: string, estate: string, now = Date.now()): Promise<void> {
  const limit = AGENT_DAILY[action];
  const checks = [
    { key: `${action}:w:${wallet}`, max: limit.wallet },
    { key: `${action}:e:${estate}`, max: limit.estate },
  ].map((c) => ({ ...c, recent: (hits.get(c.key) ?? []).filter((t) => now - t < DAY_MS) }));
  const full = checks.filter((c) => c.recent.length >= c.max);
  if (full.length) {
    const free = Math.max(...full.map((c) => c.recent[c.recent.length - c.max] + DAY_MS));
    throw limitReached(Math.max(1, Math.ceil((free - now) / 1000)));
  }
  if (hits.size > 50_000) hits.clear();
  // Counted before any await, so requests arriving together can't all pass; given back on a refusal.
  for (const c of checks) hits.set(c.key, [...c.recent, now]);
  try {
    const taken = await takeShared(checks.map((c) => ({ key: `agent:${c.key}`, max: c.max, windowSecs: DAY_MS / 1000 })));
    if (!taken) await chainBackstop(now);
    else if (!taken.ok) throw limitReached(taken.retryAfterSecs);
  } catch (e) {
    for (const c of checks) {
      const list = hits.get(c.key) ?? [];
      const at = list.lastIndexOf(now);
      if (at >= 0) hits.set(c.key, list.toSpliced(at, 1));
    }
    throw e;
  }
}
