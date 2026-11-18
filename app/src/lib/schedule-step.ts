import type { Rule } from "./types";

/**
 * The demo walk's "schedule" step: a living schedule that has not paid yet and is due within a day. A schedule first
 * due later (Naledi's 500 USD₮ birthday gift in 2029, plan.md §16.5) is not a step of the walk.
 */
export function scheduleStepDue(rules: Rule[], nowS: number): boolean {
  return rules.some((r) => r.startsNow && r.recurringAmount > BigInt(0) && r.spentTotal === BigInt(0) && (r.nextDue === null || r.nextDue <= nowS + 86_400));
}
