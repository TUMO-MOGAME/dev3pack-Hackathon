import type { Base58 } from "../types";
import type { TxResult } from "../service/types";

export interface ContinuityService {
  /** Owner, estate Active: the rule stops paying now. Cannot be undone. */
  endRule(estate: Base58, rule: Base58): Promise<TxResult>;
  /** Owner, estate Active: who receives what is left. */
  setResidual(estate: Base58, recipient: Base58): Promise<TxResult>;
  /** Anyone, estate Unlocked: pays out what no live rule still needs. */
  sweepResidual(estate: Base58): Promise<TxResult>;
  /** Test network only: starter SOL and test USD₮ for the active wallet, once. */
  requestStarter(): Promise<TxResult>;
}

export interface CreateEstateOptions {
  /** The plan uses practice wallets: also make practice payees and give each practice person SOL for rent. */
  practice?: boolean;
  /** Beneficiary label of whoever receives what is left (default: the first beneficiary). */
  residualLabel?: string;
}
