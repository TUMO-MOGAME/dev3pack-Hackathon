import "server-only";
/**
 * Scheduled payments ("living plans"): finds recurring rules whose next payment is due and executes them with
 * execute_scheduled, the agent's WDK wallet paying only the network fee. The program re-checks everything
 * (due time, caps, end date, estate status, fixed payee), so a wrong pick here just fails harmlessly.
 */
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { accountDiscriminator, getCoder, getIdl } from "../chain/idl";
import { decodeRule, decodeEstate, type Raw } from "../chain/decoders";
import { getConnection } from "../chain/tx";
import { chainCtx } from "../chain/client";
import { executeScheduled } from "../chain/instructions";
import { agentAddress, agentSignAndSend } from "../agent/agent-wallet";
import type { Rule } from "../types";
import { chainConfig } from "../chain/config";

export interface TickResult { rule: string; estate: string; ok: boolean; signature?: string; explorerUrl?: string; error?: string }

/** Pure: is this rule due for a scheduled payment at `now`? (mirrors the program's checks) */
export function isDue(rule: Rule, estateStatus: string, now: number): boolean {
  if (rule.recurringAmount <= 0n || !rule.fixedPayee || rule.nextDue === null) return false;
  if (rule.nextDue > now || now > rule.validUntil) return false;
  if (rule.spentTotal + rule.recurringAmount > rule.lifetimeCap) return false;
  // Spec #27: Unlocked, or Active if starts_now.
  return estateStatus === "Unlocked" || (rule.startsNow && estateStatus === "Active");
}

/** Below this the instalment is worth less than the rent and fee the agent would pay for it. */
export const MIN_SCHEDULED_BASE = 1_000_000n;
const PER_ESTATE_PER_TICK = 3;

/** Pure: the due payments the agent will pay fees for. Only estates it serves; a few per estate; nothing trivial. */
export function servedPayments<T extends { estate: string; rule: Pick<Rule, "recurringAmount"> }>(
  due: T[], estates: Map<string, { agent: string; usdtMint: string }>, agent: string, mint: string,
): T[] {
  const perEstate = new Map<string, number>();
  return due.filter((d) => {
    const e = estates.get(d.estate);
    if (!e || e.agent !== agent || e.usdtMint !== mint || d.rule.recurringAmount < MIN_SCHEDULED_BASE) return false;
    const n = perEstate.get(d.estate) ?? 0;
    perEstate.set(d.estate, n + 1);
    return n < PER_ESTATE_PER_TICK;
  });
}

export async function runDueSchedules(now = Math.floor(Date.now() / 1000), max = 10): Promise<TickResult[]> {
  if (!getIdl().instructions.some((i) => i.name === "execute_scheduled")) return [];
  const conn = getConnection();
  const programId = new PublicKey(getIdl().address);
  const rules = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Rule")) } }],
  });
  const decoded = rules.map((a) => {
    const raw = getCoder().accounts.decode("Rule", a.account.data) as Raw;
    return { estate: String(raw.estate), rule: decodeRule(a.pubkey.toBase58(), raw) };
  }).filter((x) => x.rule.recurringAmount > 0n && x.rule.nextDue !== null && x.rule.nextDue <= now);
  if (decoded.length === 0) return [];

  const statuses = new Map<string, string>();
  const estates = new Map<string, { agent: string; usdtMint: string }>();
  for (const e of new Set(decoded.map((d) => d.estate))) {
    const info = await conn.getAccountInfo(new PublicKey(e), "confirmed");
    if (!info) continue;
    const estate = decodeEstate(e, getCoder().accounts.decode("Estate", info.data) as Raw, 0n);
    statuses.set(e, estate.status);
    estates.set(e, estate);
  }

  const agent = new PublicKey((await agentAddress())!);
  const ctx = chainCtx();
  const out: TickResult[] = [];
  const due = decoded.filter((x) => isDue(x.rule, statuses.get(x.estate) ?? "", now));
  for (const d of servedPayments(due, estates, agent.toBase58(), chainConfig.usdtMint).slice(0, max)) {
    try {
      const tx = await agentSignAndSend([executeScheduled(ctx, {
        estate: new PublicKey(d.estate), payer: agent, rule: new PublicKey(d.rule.address), payeeWallet: new PublicKey(d.rule.fixedPayee!),
      })]);
      out.push({ rule: d.rule.address, estate: d.estate, ok: true, ...tx });
    } catch (e) {
      out.push({ rule: d.rule.address, estate: d.estate, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
