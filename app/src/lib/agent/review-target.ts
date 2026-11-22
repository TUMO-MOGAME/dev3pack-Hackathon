import "server-only";
/**
 * What /api/review is being asked to review, read from the chain: the evidence hash, the only wallet that may ask
 * (the person who submitted it) and the facts the reviewer may trust. Nothing the caller typed is in `facts`.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { HttpError } from "../api/http";
import { big, bool, enumOf, hex, key, num, str, type Raw } from "../chain/decoders";
import { fetchAccountRaw, findRecentEvent } from "../chain/reads";
import { beneficiaryPda, guardPda, payeePda, seatPda } from "../chain/pda";
import { reviewClaim, reviewDeath, reviewFallbackDeath, reviewHardship, reviewSeatDeath } from "../chain/instructions";
import { getIdl } from "../chain/idl";
import { getEstateMeta } from "../db";
import { fromBase } from "../format";
import type { ReviewOutcome } from "../verdict";
import type { ReviewPurpose } from "./review";
import { isRoleOnly } from "../chain/public-names";

const VERDICTS = ["Pending", "Approved", "Rejected", "Referred"] as const;
const NOBODY = PublicKey.default.toBase58();

export interface ReviewTarget {
  estate: { agent: string; usdtMint: string };
  /** Who submitted the evidence: the only wallet that may ask for this review. */
  submitter: string;
  /** Trusted context for the reviewer. */
  facts: string;
  /** False for seat and fallback deaths: there an unsure agent rejects (a clearer certificate can be sent). */
  canRefer: boolean;
  instruction(agent: PublicKey, outcome: ReviewOutcome, reportHash: string): TransactionInstruction;
}

export interface TargetInput { purpose: ReviewPurpose; estate: string; subject?: string; index?: number; sha256: string }

function pending(raw: Raw, field: string): void {
  if (enumOf(raw, field, VERDICTS) !== "Pending") throw new HttpError(409, "The agent has already reviewed this.", "already_reviewed");
}

function sameFile(onChain: string, sha256: string): void {
  if (onChain !== sha256) throw new HttpError(409, "This file does not match the hash submitted on-chain.", "hash_mismatch");
}

function keyAt(raw: Raw, field: string, i: number): string {
  const v = (raw as Record<string, unknown>)[field];
  return Array.isArray(v) && v[i] ? String(v[i]) : NOBODY;
}

export async function loadReviewTarget(p: TargetInput): Promise<ReviewTarget> {
  const raw = await fetchAccountRaw("Estate", p.estate);
  if (!raw) throw new HttpError(404, "Estate not found on-chain.", "not_found");
  const estateKey = new PublicKey(p.estate);
  const estate = { agent: key(raw, "agent"), usdtMint: key(raw, "usdt_mint") };
  const programId = new PublicKey(getIdl().address);
  const meta = await getEstateMeta(p.estate);
  const named = (wallet: string): string | null => meta?.buyerNames[wallet] ?? null;
  // The ledger holds roles, not names (chain/public-names.ts): without the off-chain name nobody can be matched.
  const personOf = (wallet: string, label: string): string =>
    named(wallet) ?? (isRoleOnly(label) ? `${label} (their name is not on record, so a name on the document cannot be checked: use needs_human)` : label);

  if (p.purpose === "death") {
    sameFile(hex(raw, "death_cert_hash"), p.sha256);
    pending(raw, "death_verdict");
    return {
      estate, canRefer: true,
      submitter: key(raw, "death_submitted_by"),
      facts: meta?.ownerName
        ? `Estate owner's name: ${meta.ownerName}.`
        : "Estate owner's name: not on record, so the name on the certificate cannot be checked: use needs_human.",
      instruction: (agent, outcome, hash) => reviewDeath(estateKey, agent, outcome, hash),
    };
  }

  if (p.purpose === "claim") {
    if (!p.subject) throw new HttpError(400, "subject (the claim's address) is required.");
    const claim = await fetchAccountRaw("Claim", p.subject);
    if (!claim || key(claim, "estate") !== p.estate) throw new HttpError(404, "Claim not found in this estate.", "not_found");
    sameFile(hex(claim, "evidence_hash"), p.sha256);
    pending(claim, "agent_verdict");
    const [ruleAddr, who, payeeWallet] = [key(claim, "rule"), key(claim, "beneficiary"), key(claim, "payee")];
    const [rule, ben, payee] = await Promise.all([
      fetchAccountRaw("Rule", ruleAddr),
      fetchAccountRaw("Beneficiary", beneficiaryPda(programId, p.estate, who).toBase58()),
      fetchAccountRaw("Payee", payeePda(programId, p.estate, payeeWallet).toBase58()),
    ]);
    const lines = [
      `Claim for ${fromBase(big(claim, "amount"))} USD₮ under rule #${rule ? num(rule, "id") : "?"}. The program has already checked the rule's limits.`,
      `Claimed by: ${personOf(who, ben ? str(ben, "label") : "a beneficiary")}.`,
      `Approved payee on-chain: ${payee ? str(payee, "name") : "unknown"} (wallet ${payeeWallet}).`,
    ];
    if (rule && bool(rule, "starts_now")) {
      lines.push(
        "This is a living-plan rule. If the file is only the app's own request note (nothing attached), there is nothing to verify: use needs_human, and do not reject it just because it is not an invoice.",
      );
    }
    return {
      estate, canRefer: true, submitter: who, facts: lines.join("\n"),
      instruction: (agent, outcome, hash) => reviewClaim(estateKey, agent, new PublicKey(p.subject!), new PublicKey(ruleAddr), outcome, hash),
    };
  }

  if (p.purpose === "hardship") {
    if (!p.subject) throw new HttpError(400, "subject (the request's address) is required.");
    const h = await fetchAccountRaw("Hardship", p.subject);
    if (!h) throw new HttpError(404, "Request not found.", "not_found");
    const assetAddr = key(h, "asset");
    const asset = await fetchAccountRaw("Asset", assetAddr);
    if (!asset || key(asset, "estate") !== p.estate) throw new HttpError(404, "Request not found in this estate.", "not_found");
    sameFile(hex(h, "evidence_hash"), p.sha256);
    pending(h, "agent_verdict");
    const who = key(h, "beneficiary");
    const ben = await fetchAccountRaw("Beneficiary", beneficiaryPda(programId, p.estate, who).toBase58());
    return {
      estate, canRefer: true, submitter: who,
      facts: `Hardship request by ${personOf(who, ben ? str(ben, "label") : "a beneficiary")} to sell an estate asset below its floor price.`,
      instruction: (agent, outcome, hash) => reviewHardship(estateKey, agent, new PublicKey(assetAddr), new PublicKey(p.subject!), outcome, hash),
    };
  }

  const index = p.index;
  if (index === undefined) throw new HttpError(400, "index is required for this review.");

  if (p.purpose === "seat-death") {
    if (index > 2) throw new HttpError(400, "There are only three seats.");
    const seat = await fetchAccountRaw("Seat", seatPda(programId, p.estate, index).toBase58());
    if (!seat) throw new HttpError(404, "This trusted person's seat was not found on-chain.", "not_found");
    sameFile(hex(seat, "death_cert_hash"), p.sha256);
    pending(seat, "death_verdict");
    const holder = key(seat, "holder");
    const name = named(holder) ?? (num(seat, "generation") === 0 ? meta?.verifierNames[index] : null) ?? null;
    return {
      estate, canRefer: false,
      submitter: key(seat, "death_reported_by"),
      facts: [
        `Trusted person whose death is reported: seat ${index + 1}, wallet ${holder}${name ? `, name: ${name}` : ""}. This is not the estate owner.`,
        ...(name ? [] : ["Their name is not on record: judge the document itself. A second trusted person confirms who it is before anything changes."]),
      ].join("\n"),
      instruction: (agent, outcome, hash) => reviewSeatDeath(estateKey, agent, index, outcome === "Approve", hash),
    };
  }

  const guardAddr = guardPda(programId, p.estate).toBase58();
  const guard = await fetchAccountRaw("Guard", guardAddr);
  if (!guard) throw new HttpError(404, "This estate has no fallback plan on-chain.", "not_found");
  // The Guard keeps no certificate hash: the report's hash and reporter are in its FallbackDeathReported event.
  let reporter = NOBODY;
  const reported = await findRecentEvent(guardAddr, "FallbackDeathReported", (d) => {
    if (Number(d.index) !== index || hex(d, "cert_hash") !== p.sha256) return false;
    reporter = key(d, "reported_by");
    return true;
  });
  if (!reported || reporter === NOBODY) throw new HttpError(409, "This file does not match a death certificate reported on-chain for this person.", "hash_mismatch");
  const recipient = keyAt(guard, "fallback", index);
  const name = named(recipient);
  return {
    estate, canRefer: false, submitter: reporter,
    facts: name
      ? `Fallback recipient whose death is reported: ${name} (wallet ${recipient}). This is not the estate owner.`
      : `Fallback recipient whose death is reported: wallet ${recipient}. Their name is not on record, so the certificate cannot be matched to them: use needs_human.`,
    instruction: (agent, outcome, hash) => reviewFallbackDeath(estateKey, agent, index, outcome === "Approve", hash),
  };
}
