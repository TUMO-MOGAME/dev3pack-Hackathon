/**
 * Who may do what under the program's rules (plan §18.2 and §18.8, docs/program-spec.md "Second security review"),
 * read from a snapshot. Pure. The screens offer only what these allow, and the program still checks everything.
 */
import type { EstateSnapshot } from "../service/types";
import type { Asset, Base58, Claim, Estate, Hardship, Verdict } from "../types";
import { eligibleSeats, isCurrentClaim, quorum, refuteWait, replaceableAt, reviewedHold } from "../death-rules";
import { openToPeople } from "../verdict";
import type { FallbackDeathReport, Seat, TargetKind } from "./types";

export const NO_WALLET = "11111111111111111111111111111111";
export const isHeld = (w: Base58 | null | undefined): w is Base58 => !!w && w !== NO_WALLET;

export const hasLivingSeat = (e: Pick<Estate, "verifiers">) => eligibleSeats(e.verifiers).length > 0;
export const isFamily = (snap: Pick<EstateSnapshot, "beneficiaries">, w: Base58 | null | undefined) =>
  !!w && snap.beneficiaries.some((b) => b.wallet === w && b.active);

/** Was in the family and the owner took them out: they still see the plan, and can do nothing in it as family. */
export const wasRemoved = (snap: Pick<EstateSnapshot, "beneficiaries">, w: Base58 | null | undefined) =>
  !!w && !isFamily(snap, w) && snap.beneficiaries.some((b) => b.wallet === w);

/**
 * The conditions of lib/agent/sale.ts `mayAskToList`, without its Solana imports in the first load (a test holds
 * them equal): a trusted person; or, with no seat held, family still in the plan, for an asset still Held or a
 * listing that ended with no acceptable offer. Never over one: that would put off the lone sale.
 */
export function mayList(
  snap: Pick<EstateSnapshot, "beneficiaries" | "offers"> & { estate: Pick<Estate, "verifiers"> },
  asset: Asset, me: Base58 | null | undefined, now: number,
): boolean {
  if (!isHeld(me)) return false;
  if (hasLivingSeat(snap.estate)) return snap.estate.verifiers.includes(me);
  if (!isFamily(snap, me)) return false;
  if (asset.status === "Held") return true;
  if (asset.status !== "Listed" || asset.listingEnds === null || now < asset.listingEnds) return false;
  const least = asset.hardshipBeneficiary ? asset.hardshipFloor : asset.floorPrice;
  return !snap.offers.some((o) => o.asset === asset.address && o.amount >= least);
}

/** A death claim that "I'm still here" would cancel. */
export const deathOpen = (e: Pick<Estate, "status" | "death">) => e.status === "DeathPending" || (e.status === "Active" && !!e.death.certHash);

/** The program's `death_pending_since`: the submission while Active, else when the death took effect. */
export function deathSince(e: Pick<Estate, "status" | "death">): number {
  if (e.status === "Active") return e.death.certHash ? e.death.submittedAt ?? 0 : 0;
  return e.death.pendingSince ?? 0;
}

/* ----- quorums ----- */

export interface Tally {
  needed: number;
  got: number;
  met: boolean;
  /** How many people may decide. */
  eligible: number;
  /** The votes that count, by seat. */
  votes: boolean[];
}

function tallyOf(verifiers: readonly Base58[], given: readonly boolean[], threshold: number, verdict: Verdict, interested: Base58 | null): Tally {
  const eligible = eligibleSeats(verifiers, interested);
  const votes = verifiers.map((_, i) => eligible.includes(i) && !!given[i]);
  return { ...quorum({ verifiers, votes, threshold, verdict, interested }), eligible: eligible.length, votes };
}

export const deathTally = (e: Pick<Estate, "verifiers" | "deathThreshold" | "death">): Tally =>
  tallyOf(e.verifiers, e.death.attestations, e.deathThreshold, e.death.verdict, e.death.submittedBy);

/** Approvals from before this death don't count: they can be given again. */
export const claimTally = (e: Pick<Estate, "verifiers" | "claimThreshold">, c: Claim): Tally =>
  tallyOf(e.verifiers, c.approvalsCount === false ? [] : c.approvals, e.claimThreshold, c.agentVerdict, c.beneficiary);

export const hardshipTally = (e: Pick<Estate, "verifiers" | "hardshipThreshold">, h: Hardship): Tally =>
  tallyOf(e.verifiers, h.approvals, e.hardshipThreshold, h.agentVerdict, h.beneficiary);

/**
 * approve: a first vote. again: their earlier vote predates the death. complete: they voted and the quorum has since
 * dropped to what is there, so signing again finishes it. waiting: voted, others must. own: they would gain.
 */
export type Vote = "approve" | "again" | "complete" | "waiting" | "own";
export const canSign = (v: Vote | null) => v === "approve" || v === "again" || v === "complete";

export function deathVote(e: Estate, me: Base58 | null | undefined): Vote | null {
  if (!isHeld(me) || e.status !== "Active" || !e.death.certHash || !openToPeople(e.death.verdict)) return null;
  const i = e.verifiers.indexOf(me);
  if (i < 0) return null;
  if (me === e.death.submittedBy) return "own";
  if (!e.death.attestations[i]) return "approve";
  return deathTally(e).met ? "complete" : "waiting";
}

export type ClaimBlock = "endedRule" | "expired" | "beneficiary" | "payee";

/** Why a claim can never be paid as things stand, or null. */
export function claimBlock(snap: EstateSnapshot, c: Claim, now?: number | null): ClaimBlock | null {
  const rule = snap.rules.find((r) => r.address === c.rule);
  if (c.fromEndedRule || (rule?.claimCount !== undefined && !isCurrentClaim(c.id, rule.claimCount))) return "endedRule";
  if (!isFamily(snap, c.beneficiary)) return "beneficiary";
  if (!rule) return null;
  if (!snap.payees.some((p) => p.wallet === c.payee && p.kind === rule.allowedPayeeKind)) return "payee";
  return now && now > rule.validUntil ? "expired" : null;
}

/** With guardians a payment needs the window that started when the quorum was reached. */
const windowStarted = (snap: EstateSnapshot, c: Claim) => !snap.guardians?.enabled || snap.guardians.claimPayableAt?.[c.address] !== undefined;

export function claimVote(snap: EstateSnapshot, c: Claim, me: Base58 | null | undefined, now?: number | null): Vote | null {
  const e = snap.estate;
  if (!isHeld(me) || e.status !== "Unlocked" || c.status !== "Open" || c.ownerApproved || !openToPeople(c.agentVerdict) || claimBlock(snap, c, now)) return null;
  const i = e.verifiers.indexOf(me);
  if (i < 0) return null;
  if (me === c.beneficiary) return "own";
  if (!c.approvals[i]) return "approve";
  if (c.approvalsCount === false) return "again";
  return claimTally(e, c).met && !windowStarted(snap, c) ? "complete" : "waiting";
}

/** Approved by enough people: anyone may pay it, once any window has passed. */
export function claimPayable(snap: EstateSnapshot, c: Claim, now?: number | null): boolean {
  if (c.status !== "Open" || !openToPeople(c.agentVerdict) || claimBlock(snap, c, now)) return false;
  const e = snap.estate;
  if (c.ownerApproved) return e.status === "Unlocked" || (e.status === "Active" && !!snap.rules.find((r) => r.address === c.rule)?.startsNow);
  return e.status === "Unlocked" && claimTally(e, c).met && windowStarted(snap, c);
}

/** The owner, alive, may answer this request. */
export function ownerMayApprove(snap: EstateSnapshot, c: Claim, now?: number | null): boolean {
  return snap.estate.status === "Active" && c.status === "Open" && openToPeople(c.agentVerdict)
    && !!snap.rules.find((r) => r.address === c.rule)?.startsNow && !claimBlock(snap, c, now);
}

/** Another hardship already decides who gets the sale's money (R21). */
export function hardshipStands(snap: Pick<EstateSnapshot, "assets">, h: Hardship): boolean {
  const to = snap.assets.find((a) => a.address === h.asset)?.hardshipBeneficiary;
  return h.status === "Open" && !!to && to !== h.beneficiary;
}

export function hardshipVote(snap: EstateSnapshot, h: Hardship, me: Base58 | null | undefined): Vote | null {
  const e = snap.estate;
  if (!isHeld(me) || e.status !== "Unlocked" || h.status !== "Open" || !openToPeople(h.agentVerdict) || hardshipStands(snap, h)) return null;
  if (snap.assets.find((a) => a.address === h.asset)?.status === "Sold") return null;
  const i = e.verifiers.indexOf(me);
  if (i < 0) return null;
  if (me === h.beneficiary) return "own";
  if (!h.approvals[i]) return "approve";
  return hardshipTally(e, h).met ? "complete" : "waiting";
}

/** Who gains if a challenged action goes ahead: they can't raise the challenge or vote to dismiss it. */
export function interestedIn(snap: EstateSnapshot, kind: TargetKind, target: Base58): Base58 | null {
  switch (kind) {
    case "Claim": return snap.claims.find((c) => c.address === target)?.beneficiary ?? null;
    case "Hardship": return snap.hardships.find((h) => h.address === target)?.beneficiary ?? null;
    case "Unlock": return snap.estate.death.submittedBy;
    case "Fallback": return snap.guardians?.fallback.recipients.find((r) => !r.dead)?.wallet ?? null;
    default: return null;
  }
}

/* ----- replaceable reports ----- */

export interface ReplaceTimes {
  /** From when anyone else who may report can replace it. */
  others: number;
  /** From when whoever made it can. */
  reporter: number;
}

function replaceTimes(verdict: Verdict, reportedAt: number, waitingSecs: number, hold: number): ReplaceTimes {
  const at = (who: Base58) => replaceableAt({ verdict, reportedAt, reporter: "reporter", who, waitingSecs, hold });
  return { others: at("someone else"), reporter: at("reporter") };
}

/** Null: no open claim, or it stays (the fallback plan's proof when nobody is left). */
export function deathReplace(e: Estate): ReplaceTimes | null {
  if (e.status !== "Active" || !e.death.certHash) return null;
  if (e.death.verdict !== "Pending" && !hasLivingSeat(e)) return null;
  return replaceTimes(e.death.verdict, e.death.submittedAt ?? 0, e.waitingPeriodSecs, reviewedHold(e.waitingPeriodSecs));
}

export function seatReplace(e: Estate, seat: Pick<Seat, "succession">): ReplaceTimes | null {
  const s = seat.succession;
  if (!s || s.confirmedBy) return null;
  return replaceTimes(s.verdict, s.reportedAt ?? 0, e.waitingPeriodSecs, reviewedHold(e.waitingPeriodSecs));
}

export function fallbackReplace(e: Estate, fallbackWaitSecs: number, r: FallbackDeathReport): ReplaceTimes {
  return replaceTimes(r.verdict, r.reportedAt, e.waitingPeriodSecs, 2 * refuteWait(fallbackWaitSecs));
}

/** When `who` may replace it. */
export const replaceFor = (t: ReplaceTimes, reporter: Base58 | null, who: Base58) => (who === reporter ? t.reporter : t.others);

export function canSubmitDeath(snap: EstateSnapshot, me: Base58 | null | undefined, now: number | null): boolean {
  const e = snap.estate;
  if (!me || e.status !== "Active" || !isFamily(snap, me)) return false;
  if (!e.death.certHash) return true;
  const t = deathReplace(e);
  return !!t && now !== null && now >= replaceFor(t, e.death.submittedBy, me);
}

/* ----- a trusted person's death ----- */

/** Who may report it: the trusted people, the owner, this seat's monitors and backups, the family. */
export function seatParticipant(snap: EstateSnapshot, seat: Seat, me: Base58 | null | undefined): boolean {
  const e = snap.estate;
  if (!isHeld(me) || me === e.agent || me === seat.holder) return false;
  return e.verifiers.includes(me) || me === e.owner || isFamily(snap, me)
    || seat.monitors.some((m) => m.wallet === me) || seat.backups.some((b) => b.wallet === me);
}

export function canReportSeat(snap: EstateSnapshot, seat: Seat, me: Base58 | null | undefined, now: number | null): boolean {
  if (seat.vacant || !seat.holder || !me || !seatParticipant(snap, seat, me)) return false;
  if (!seat.succession) return true;
  const t = seatReplace(snap.estate, seat);
  return !!t && now !== null && now >= replaceFor(t, seat.succession.reportedBy, me);
}

/**
 * trusted: the other holders confirm. watchers: none is left, so the second backup or a monitor does.
 * family: none of those exist either, so a family member does (R18).
 */
export type ConfirmRoute = "trusted" | "watchers" | "family";
export function confirmRoute(e: Pick<Estate, "verifiers">, seat: Pick<Seat, "index" | "backups" | "monitors">): ConfirmRoute {
  if (e.verifiers.some((v, j) => j !== seat.index && isHeld(v))) return "trusted";
  return seat.backups[1] || seat.monitors.length ? "watchers" : "family";
}

export function canConfirmSeat(snap: EstateSnapshot, seat: Seat, me: Base58 | null | undefined): boolean {
  const s = seat.succession;
  if (!isHeld(me) || !s || s.verdict !== "Approved" || s.confirmedBy) return false;
  const e = snap.estate;
  if (me === seat.holder || me === s.reportedBy || me === seat.backups[0]?.wallet || me === e.agent) return false;
  const route = confirmRoute(e, seat);
  if (route === "trusted") return e.verifiers.some((v, j) => j !== seat.index && v === me);
  if (route === "watchers") return seat.backups[1]?.wallet === me || seat.monitors.some((m) => m.wallet === me);
  return isFamily(snap, me);
}

export type SuccessionOutcome = { kind: "promote"; next: { wallet: Base58; name: string } } | { kind: "clear" } | { kind: "vacate" };

/** What finalising would do: nobody promotes themselves, and only a seat no backup could take becomes empty. */
export function successionOutcome(e: Pick<Estate, "owner" | "agent" | "verifiers">, seat: Seat): SuccessionOutcome {
  let held = false;
  for (const b of seat.backups) {
    if (!isHeld(b.wallet) || b.wallet === e.owner || b.wallet === e.agent || e.verifiers.includes(b.wallet)) continue;
    if (b.wallet === seat.succession?.confirmedBy || b.wallet === seat.succession?.reportedBy) { held = true; continue; }
    return { kind: "promote", next: b };
  }
  return held ? { kind: "clear" } : { kind: "vacate" };
}

/* ----- a fallback recipient's death ----- */

export function fallbackParticipant(snap: EstateSnapshot, me: Base58 | null | undefined): boolean {
  if (!isHeld(me) || me === snap.estate.agent) return false;
  const g = snap.guardians;
  return snap.estate.verifiers.includes(me) || isFamily(snap, me)
    || !!g?.seats.some((s) => s.monitors.some((m) => m.wallet === me))
    || !!g?.fallback.recipients.some((r) => !r.dead && r.wallet === me);
}

export function canReportRecipient(snap: EstateSnapshot, index: number, me: Base58 | null | undefined, now: number | null): boolean {
  const g = snap.guardians;
  const r = g?.fallback.recipients[index];
  if (!g || !r || r.dead || g.fallback.done || !me || me === r.wallet || !fallbackParticipant(snap, me)) return false;
  if (!r.report) return true;
  return now !== null && now >= replaceFor(fallbackReplace(snap.estate, g.fallbackWaitSecs, r.report), r.report.reporter, me);
}

/** May confirm, once the wait to refute is over: not the person, the reporter or whoever would be next. */
export function canConfirmRecipient(snap: EstateSnapshot, index: number, me: Base58 | null | undefined): boolean {
  const f = snap.guardians?.fallback;
  const r = f?.recipients[index];
  if (!f || !me || !r?.report || r.dead || f.done || r.report.verdict !== "Approved") return false;
  const next = f.recipients.find((x, i) => i > index && !x.dead)?.wallet;
  return me !== r.wallet && me !== r.report.reporter && me !== next && fallbackParticipant(snap, me);
}

/** Open reports that say `me` has died. */
export function reportsAbout(snap: EstateSnapshot, me: Base58 | null | undefined): number[] {
  if (!me) return [];
  return (snap.guardians?.fallback.recipients ?? []).flatMap((r, i) => (r.wallet === me && !r.dead && r.report ? [i] : []));
}

/** Until when a reported death holds the fallback payout, or null. */
export function payoutHeldUntil(snap: EstateSnapshot, now: number | null): number | null {
  const g = snap.guardians;
  const r = g?.fallback.recipients.find((x) => !x.dead)?.report;
  if (!g || !r || now === null || r.verdict !== "Approved" || g.fallback.readyAt === null || r.reportedAt >= g.fallback.readyAt) return null;
  const until = r.reportedAt + 2 * refuteWait(g.fallbackWaitSecs);
  return now < until ? until : null;
}

/** Until when a reported death can hold a sweep that pays by the fallback list (R20), or null. */
export function sweepHeldUntil(snap: EstateSnapshot, now: number | null): number | null {
  const g = snap.guardians;
  const next = g?.fallback.recipients.find((x) => !x.dead);
  const r = next?.report;
  if (!g || !next || !r || now === null || r.verdict !== "Approved" || snap.residual !== next.wallet) return null;
  const until = r.reportedAt + 2 * refuteWait(g.fallbackWaitSecs);
  return now < until ? until : null;
}

/* ----- replacing the agent ----- */

/** While Active every trusted person, at least two. Afterwards two, or the only one left. */
export function agentVotesNeeded(e: Pick<Estate, "status" | "verifiers">): number {
  const seats = eligibleSeats(e.verifiers).length;
  return e.status === "Active" ? Math.max(seats, 2) : Math.min(seats, 2);
}

export function agentVoteFor(snap: EstateSnapshot, candidate: Base58): { got: number; needed: number; voters: Base58[] } {
  const e = snap.estate;
  const given = snap.agentVotes?.find((v) => v.candidate === candidate)?.voters ?? [];
  const voters = e.verifiers.filter((v) => isHeld(v) && given.includes(v));
  return { got: voters.length, needed: agentVotesNeeded(e), voters };
}
