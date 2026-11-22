import "server-only";
/**
 * Keeps the agent's SOL from being drained through requests that are each valid: a daily allowance per wallet and
 * per estate. The balance reserve (agent-wallet.ts) is the backstop that holds across server instances.
 */
import { HttpError } from "../api/http";
import type { AgentAction } from "../access/messages";

const DAY_MS = 86_400_000;

export const AGENT_DAILY: Record<Exclude<AgentAction, "starter">, { wallet: number; estate: number }> = {
  review: { wallet: 20, estate: 40 },
  "list-asset": { wallet: 6, estate: 10 },
  "accept-offer": { wallet: 6, estate: 10 },
};

const hits = new Map<string, number[]>();

export function spendAgentAllowance(action: keyof typeof AGENT_DAILY, wallet: string, estate: string, now = Date.now()): void {
  const limit = AGENT_DAILY[action];
  const checks = [
    { key: `${action}:w:${wallet}`, max: limit.wallet },
    { key: `${action}:e:${estate}`, max: limit.estate },
  ].map((c) => ({ ...c, recent: (hits.get(c.key) ?? []).filter((t) => now - t < DAY_MS) }));
  if (checks.some((c) => c.recent.length >= c.max)) {
    throw new HttpError(429, "The agent reached today's limit for this. Please try again tomorrow.", "agent_limit");
  }
  if (hits.size > 50_000) hits.clear();
  for (const c of checks) hits.set(c.key, [...c.recent, now]);
}
