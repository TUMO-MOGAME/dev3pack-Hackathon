import type { WillDraft } from "./types";
import { fullName } from "./names";

type Rule = WillDraft["rules"][number];

/** Same key as the will screen's Now / After toggles: who + what, so a re-ordered draft keeps each choice on its rule. */
export const ruleKey = (r: Rule) => `${r.beneficiaryLabel}|${r.category}|${r.recurring ? "recurring" : "claim"}`;

/** The review copy the summary is written from (content/screens.ts `will.review`). */
export interface SummaryWords {
  summaryNow: string;
  summaryNoneNow: string;
  summaryLater: string;
  summaryNoneLater: string;
  summaryItem: string;
  summaryItemRecurring: string;
  summaryAsset: string;
}


export interface SummaryFormat {
  category: (c: Rule["category"]) => string;
  every: (e: NonNullable<Rule["recurring"]>["every"]) => string;
  usd: (n: number) => string;
  /** How many trusted people must confirm the passing. */
  need: number;
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/**
 * True when the plan the owner will sign no longer matches the agent's summary: a rule was switched between Now and
 * After I'm gone, or a rule was added that the agent never saw (a ready-made bill).
 */
export function timingChanged(agentRules: readonly Rule[], rules: readonly Rule[]): boolean {
  const agent = new Map(agentRules.map((r) => [ruleKey(r), r.startsNow] as const));
  return rules.some((r) => {
    const k = ruleKey(r);
    return !agent.has(k) || agent.get(k) !== r.startsNow;
  });
}

/** A plain summary written from the rules themselves: what starts now, what waits until after the passing, the car. */
export function planSummary(draft: WillDraft, words: SummaryWords, f: SummaryFormat): string {
  const item = (r: Rule) => {
    // "Lerato (daughter)" → "Lerato", so the item doesn't carry two brackets.
    const v = { name: fullName(r.beneficiaryLabel) || r.beneficiaryLabel, category: f.category(r.category).toLowerCase() };
    return r.recurring
      ? fill(words.summaryItemRecurring, { ...v, amount: f.usd(r.recurring.amountUsdt), every: f.every(r.recurring.every) })
      : fill(words.summaryItem, v);
  };
  const now = draft.rules.filter((r) => r.startsNow).map(item);
  const later = draft.rules.filter((r) => !r.startsNow).map(item);
  const parts = [
    now.length ? fill(words.summaryNow, { list: now.join("; ") }) : words.summaryNoneNow,
    later.length ? fill(words.summaryLater, { list: later.join("; "), need: f.need, days: draft.waitingPeriodDays }) : words.summaryNoneLater,
  ];
  const asset = draft.assets[0];
  if (asset) parts.push(fill(words.summaryAsset, { title: asset.title, floor: f.usd(asset.floorPriceUsdt), hardship: f.usd(asset.hardshipFloorUsdt) }));
  return parts.join(" ");
}

/**
 * The draft as it will be signed: the owner's choices win, and when they change the timing the agent's summary (which
 * describes the agent's timing) is replaced by one written from the rules, so the summary and the hashed will agree.
 */
export function withOwnerSummary(agentDraft: WillDraft, rules: Rule[], words: SummaryWords, f: SummaryFormat): { draft: WillDraft; edited: boolean } {
  const draft = { ...agentDraft, rules };
  if (!timingChanged(agentDraft.rules, rules)) return { draft, edited: false };
  return { draft: { ...draft, plainLanguageSummary: planSummary(draft, words, f) }, edited: true };
}
