/**
 * Shared types for guardians (trusted-person seats with backups and monitors), objections, succession, the fallback
 * plan and asset photos. Source of truth for the UI (Agent C, D) and the service layer (Agent B); mirrors
 * docs/guardians-spec.md and the on-chain accounts (Agent A). Amounts are base units (6 dp) like the rest of lib/types.
 */
import type { AgentReport, Base58 } from "../types";
import type { TxResult } from "../service/types";

export type TargetKind = "Claim" | "Unlock" | "Sale" | "Hardship" | "Succession" | "Fallback";
export type ObjectionStatus = "Open" | "Upheld" | "Dismissed";
export type AssetKind = "Car" | "Motorbike" | "Furniture" | "Jewellery" | "Electronics" | "Other";

export interface Seat {
  address: Base58;
  index: number;                    // 0..2
  holder: Base58 | null;            // null when vacant
  holderName: string;               // off-chain display name ("Uncle Bongani Mokoena")
  backups: { wallet: Base58; name: string }[];   // 0..2, in promotion order
  monitors: { wallet: Base58; name: string }[];  // 0..2
  generation: number;
  vacant: boolean;
  succession: SeatSuccession | null;
}

export interface SeatSuccession {
  certHash: string;                 // hex SHA-256
  reportedBy: Base58;
  verdict: "Pending" | "Approved" | "Rejected";
  report?: AgentReport;
  confirmedBy: Base58 | null;
  pendingSince: number;             // unix seconds
  readyAt: number;                  // pendingSince + successionWaitSecs
  nextHolder: { wallet: Base58; name: string } | null;  // backups[0] (or [1]); null = seat becomes vacant
}

/** One approval a seat holder made; what a monitor watches. From the SeatApproval event. */
export interface SeatApprovalItem {
  seatIndex: number;
  approver: Base58;
  approverName: string;
  kind: TargetKind;
  target: Base58;
  summary: string;                  // "Approved 3 500 USD₮ to University of Cape Town for Lerato"
  ts: number;
  txSignature?: string;
  objectionDeadline: number | null; // after this an objection can no longer pause it (claims: approved_at + window)
}

export interface Objection {
  address: Base58;
  kind: TargetKind;
  target: Base58;
  monitor: Base58;
  monitorName: string;
  seatIndex: number | null;
  reason: string;                   // off-chain text; only its hash is on-chain
  reasonHash: string;
  raisedAt: number;
  status: ObjectionStatus;
  votesUphold: number;              // count of votes
  votesDismiss: number;
}

export interface FallbackRecipient {
  wallet: Base58;
  name: string;                     // "Lerato (daughter)", "Mokoena Family Trust", "Ithemba Children's Charity"
  kind: "family" | "heir" | "charity";
  dead: boolean;                    // proven dead (family/heir only)
}

export interface FallbackPlan {
  recipients: FallbackRecipient[];  // ordered, up to 4
  startedAt: number | null;
  readyAt: number | null;           // startedAt + fallbackWaitSecs
  done: boolean;
  /** True when every seat is vacant and the owner's death is proven: anyone may start the fallback. */
  canStart: boolean;
}

export interface GuardiansSnapshot {
  enabled: boolean;                 // a Guard account exists (older estates: false, everything below empty)
  objectionWindowSecs: number;
  successionWaitSecs: number;
  fallbackWaitSecs: number;
  seats: Seat[];
  feed: SeatApprovalItem[];         // newest first
  objections: Objection[];
  fallback: FallbackPlan;
}

export interface AssetPhoto { sha256: string; url: string; width: number; height: number; bytes: number }
export interface AssetMediaInfo { asset: Base58; kind: AssetKind; title: string; photos: AssetPhoto[]; photosRoot: string; updatedAt: number }

/** Methods the UI calls. Implemented by mock.ts and chain.ts (Agent B); HeirloomService extends this. */
export interface GuardiansService {
  getGuardians(estate: Base58): Promise<GuardiansSnapshot>;
  // owner (estate Active)
  setupGuardians(estate: Base58, input: {
    seats: { index: number; backups: { wallet: Base58; name: string }[]; monitors: { wallet: Base58; name: string }[] }[];
    fallback: { wallet: Base58; name: string; kind: FallbackRecipient["kind"] }[];
  }): Promise<TxResult[]>;
  setSeatBackups(estate: Base58, index: number, backups: { wallet: Base58; name: string }[]): Promise<TxResult>;
  setSeatMonitors(estate: Base58, index: number, monitors: { wallet: Base58; name: string }[]): Promise<TxResult>;
  setFallback(estate: Base58, recipients: { wallet: Base58; name: string; kind: FallbackRecipient["kind"] }[]): Promise<TxResult>;
  // succession
  reportSeatDeath(estate: Base58, index: number, certificate: File): Promise<{ tx: TxResult; report: AgentReport }>;
  confirmSeatDeath(estate: Base58, index: number): Promise<TxResult>;
  vetoSeatDeath(estate: Base58, index: number): Promise<TxResult>;
  finalizeSuccession(estate: Base58, index: number): Promise<TxResult>;
  // monitors and objections
  raiseObjection(estate: Base58, input: { kind: TargetKind; target: Base58; seatIndex: number | null; reason: string }): Promise<TxResult>;
  voteObjection(estate: Base58, objection: Base58, uphold: boolean): Promise<TxResult>;
  // fallback
  reportFallbackDeath(estate: Base58, recipientIndex: number, certificate: File): Promise<{ tx: TxResult; report: AgentReport }>;
  startFallback(estate: Base58): Promise<TxResult>;
  executeFallback(estate: Base58): Promise<TxResult>;
  // asset photos (Agent D uploads; B records the root on-chain)
  getAssetMedia(estate: Base58): Promise<AssetMediaInfo[]>;
  setAssetMedia(estate: Base58, asset: Base58, input: { kind: AssetKind; title: string; photos: AssetPhoto[] }): Promise<TxResult>;
}
