/**
 * The chain service's own refusals, shaped like the program's: `code`, and a message that starts with it, which is
 * how the screens find their translated copy. Plus the two things every send needs: a plain failure, and no success
 * before the network confirmed it.
 */
import type { PaymentReceipt } from "../types";
import { programFailure } from "../chain/program-errors";

export class ChainServiceError extends Error {
  constructor(
    public code: string,
    words: string,
    /** Unix seconds from when trying again can work, when that is known. */
    public retryAt?: number,
  ) {
    super(words.startsWith(`${code}: `) ? words : `${code}: ${words}`);
    this.name = "ChainServiceError";
  }
}

export function must(ok: unknown, code: string, words: string): asserts ok {
  if (!ok) throw new ChainServiceError(code, words);
}

/**
 * Null when the write is confirmed; else the words to fail with. A transaction that was sent but not confirmed is not
 * a success: "the death claim is cancelled" must never be said on a transaction that may not land.
 */
export function writeFailure(r: Pick<PaymentReceipt, "status" | "error" | "signature"> | null): string | null {
  if (r?.status === "confirmed" && r.signature) return null;
  if (!r || r.status === "failed" || !r.signature) {
    const raw = r?.error ?? "Transaction failed.";
    return programFailure(raw) ?? raw;
  }
  return "NotConfirmed: the network has not confirmed this yet, so don't count on it. Open the link, or reload before you try again.";
}
