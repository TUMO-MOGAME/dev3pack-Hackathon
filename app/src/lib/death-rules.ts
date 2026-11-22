/**
 * The program's rules for quorums and replaceable reports (docs/program-spec.md "Second security review"), shared by
 * the mock, the chain service and the screens so that all three say the same thing. Pure.
 */
import type { Base58, Verdict } from "./types";

export const MIN_WAIT_SECS = 60;
export const MAX_REPORT_GRACE_SECS = 86_400;
const REFERRED_MIN = 2;
const EMPTY_WALLET = "11111111111111111111111111111111";

/** Seat indexes that may decide: held, and not by whoever would gain. */
export function eligibleSeats(verifiers: readonly (Base58 | null)[], interested?: Base58 | null): number[] {
  return verifiers.flatMap((v, i) => (v && v !== EMPTY_WALLET && v !== interested ? [i] : []));
}

/** Approvals needed and given. `needed` 0: nobody may decide, so it can never be met. */
export function quorum(input: {
  verifiers: readonly (Base58 | null)[]; votes: readonly boolean[]; threshold: number; verdict: Verdict; interested?: Base58 | null;
}): { needed: number; got: number; met: boolean } {
  const eligible = eligibleSeats(input.verifiers, input.interested);
  const wanted = input.verdict === "Referred" ? Math.max(input.threshold, REFERRED_MIN) : input.threshold;
  const needed = Math.min(wanted, eligible.length);
  const got = eligible.filter((i) => input.votes[i]).length;
  return { needed, got, met: needed > 0 && got >= needed };
}

/** Death claim and seat death: how long a reviewed report keeps its place. */
export const reviewedHold = (waitingSecs: number) => 2 * Math.max(waitingSecs, MIN_WAIT_SECS);

/** Fallback death: how long the person reported has to refute before anyone can confirm. */
export const refuteWait = (fallbackWaitSecs: number) => Math.max(fallbackWaitSecs, MIN_WAIT_SECS);

/**
 * From when `who` may replace an unconfirmed report. `hold` is reviewedHold(waiting), or for a fallback death twice
 * refuteWait(fallback wait). Whoever made the report waits one grace longer.
 */
export function replaceableAt(input: {
  verdict: Verdict; reportedAt: number; reporter: Base58 | null; who: Base58; waitingSecs: number; hold: number;
}): number {
  const grace = Math.min(Math.max(input.waitingSecs, MIN_WAIT_SECS), MAX_REPORT_GRACE_SECS);
  const base = input.verdict === "Pending" ? grace : input.hold;
  return input.reportedAt + base + (input.reporter === input.who ? grace : 0);
}

/** False: the claim was made under a rule that held this slot before it was reused. */
export const isCurrentClaim = (claimId: number, ruleClaimCount: number) => claimId >>> 16 === ruleClaimCount >>> 16;
