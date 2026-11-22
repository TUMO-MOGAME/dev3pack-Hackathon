/**
 * The fee sponsor's limits: per-wallet sliding windows (per minute, per day), sponsored-rent creations per wallet
 * per day, and a daily lamport budget for the whole sponsor. `SponsorLimiter` holds them on this instance;
 * `sharedTakes` are the same across instances when the shared store is there.
 */
import type { Take } from "../server/shared-store";
import { TOKEN_ACCOUNT_RENT } from "./policy";
export interface SponsorLimits { perMinute: number; perDay: number; rentPerDay: number; dailyBudgetLamports: number }

/** Sized for a room of judges behind one address (room.test.ts has the arithmetic). */
export const DEFAULT_SPONSOR_LIMITS: SponsorLimits = { perMinute: 20, perDay: 100, rentPerDay: 3, dailyBudgetLamports: 300_000_000 };
/** /api/sponsor, for each IP address: one Wi-Fi is one address. */
export const SPONSOR_PER_IP_MINUTE = 90;

const MIN = 60_000, DAY = 86_400_000;

const MINUTE_SECS = 60, DAY_SECS = 86_400;
/** The shared store counts, it can't add up lamports: this much of the day's budget is for rent, the rest for fees. */
const RENT_SHARE = 0.7;

/**
 * The shared allowances for one sponsored transaction. Their worst case stays within the daily budget: a fee is at
 * most `maxFeeLamports`, and the policy sponsors rent for one account at most (a token account is the dearer).
 */
export function sharedTakes(wallet: string, rent: boolean, limits: SponsorLimits, maxFeeLamports: number): Take[] {
  const forRent = Math.floor(limits.dailyBudgetLamports * RENT_SHARE);
  const atLeastOne = (n: number) => Math.max(1, Math.floor(n)); // the store refuses a limit of 0
  const takes: Take[] = [
    { key: `sponsor:minute:${wallet}`, max: atLeastOne(limits.perMinute), windowSecs: MINUTE_SECS },
    { key: `sponsor:day:${wallet}`, max: atLeastOne(limits.perDay), windowSecs: DAY_SECS },
    { key: "sponsor:fees", max: atLeastOne((limits.dailyBudgetLamports - forRent) / Math.max(1, maxFeeLamports)), windowSecs: DAY_SECS },
  ];
  if (rent) {
    takes.push(
      { key: `sponsor:rent:${wallet}`, max: atLeastOne(limits.rentPerDay), windowSecs: DAY_SECS },
      { key: "sponsor:rent", max: atLeastOne(forRent / TOKEN_ACCOUNT_RENT), windowSecs: DAY_SECS },
    );
  }
  return takes;
}

export class SponsorLimiter {
  private hits = new Map<string, number[]>();
  private rent = new Map<string, number[]>();
  private spent: { at: number; lamports: number }[] = [];
  constructor(private limits: SponsorLimits = DEFAULT_SPONSOR_LIMITS) {}

  private recent(m: Map<string, number[]>, key: string, now: number, window: number): number[] {
    const xs = (m.get(key) ?? []).filter((t) => now - t < window);
    m.set(key, xs);
    return xs;
  }

  /** Returns a reason string when the request must be refused; null when it may proceed. Does not record. */
  check(wallet: string, lamports: number, rent: boolean, now = Date.now()): string | null {
    const day = this.recent(this.hits, wallet, now, DAY);
    if (day.filter((t) => now - t < MIN).length >= this.limits.perMinute) return "Too many sponsored transactions from this wallet. Please wait a minute.";
    if (day.length >= this.limits.perDay) return "This wallet reached today's limit of sponsored transactions.";
    if (rent && this.recent(this.rent, wallet, now, DAY).length >= this.limits.rentPerDay) return "This wallet reached today's limit of sponsored new accounts.";
    this.spent = this.spent.filter((s) => now - s.at < DAY);
    const used = this.spent.reduce((a, s) => a + s.lamports, 0);
    if (used + lamports > this.limits.dailyBudgetLamports) return "The fee sponsor's daily budget is used up.";
    return null;
  }

  /** Gives back what `record` took at `now`: nothing was signed after all. */
  refund(wallet: string, lamports: number, rent: boolean, now: number): void {
    const drop = (list: number[] | undefined) => {
      const at = list?.lastIndexOf(now) ?? -1;
      if (at >= 0) list!.splice(at, 1);
    };
    drop(this.hits.get(wallet));
    if (rent) drop(this.rent.get(wallet));
    const at = this.spent.findIndex((s) => s.at === now && s.lamports === lamports);
    if (at >= 0) this.spent.splice(at, 1);
  }

  record(wallet: string, lamports: number, rent: boolean, now = Date.now()): void {
    this.recent(this.hits, wallet, now, DAY).push(now);
    if (rent) this.recent(this.rent, wallet, now, DAY).push(now);
    this.spent.push({ at: now, lamports });
    if (this.hits.size > 50_000) this.hits.clear();
    if (this.rent.size > 50_000) this.rent.clear();
  }
}
