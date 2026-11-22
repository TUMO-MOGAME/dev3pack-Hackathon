/**
 * Mock twin of the guardians part of the contract (docs/guardians-spec.md §2): seats with backups and monitors,
 * approval stamps and the objection window, objections and votes, succession, the fallback plan and asset photos.
 * Same checks and error names as the program, so the UI behaves the same in mock and chain mode.
 *
 * Synchronous "instructions" only; mock.ts wraps them in the async GuardiansService methods (hashing, the agent's
 * review, latency) and calls the hooks (recordApproval, check*) from its existing instructions.
 */
import type { AgentReport, Base58, PaymentRef } from "../types";
import type { EstateSnapshot, TxResult } from "./types";
import type {
  AssetKind, AssetMediaInfo, AssetPhoto, FallbackRecipient, GuardiansSnapshot, ObjectionStatus, SeatApprovalItem, TargetKind,
} from "../guardians/types";
import { fail, need } from "./mock-errors";
import { shortName } from "../names";
import { cleanSpec, foreignSpecKeys, isPhotoLabel, type AssetSpec } from "../assets/spec";
import { objectionLapsesAt } from "../disputes/types";

/** Demo timings: objection window, succession wait and fallback wait (real: 2 days, 7 days, 90 days). */
export const GUARD_DEMO_TIMINGS = { objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120 } as const;
export const VACANT_KEY = "11111111111111111111111111111111";
/** The program's MAX_PHOTOS (raised from 8 to 24 on 15 Nov 2026). */
export const MAX_PHOTOS = 24;

export interface Named { wallet: Base58; name: string }
export type FallbackInput = { wallet: Base58; name: string; kind: FallbackRecipient["kind"] };

interface MockSuccession {
  certHash: string;
  reportedBy: Base58;
  verdict: "Pending" | "Approved" | "Rejected";
  report?: AgentReport;
  confirmedBy: Base58 | null;
  pendingSince: number;
}

interface MockSeat {
  address: Base58;
  index: number;
  holder: Base58 | null;
  backups: Base58[];
  monitors: Base58[];
  generation: number;
  vacant: boolean;
  succession: MockSuccession | null;
}

interface MockObjection {
  address: Base58;
  kind: TargetKind;
  target: Base58;
  monitor: Base58;
  seatIndex: number | null;
  reason: string;
  reasonHash: string;
  raisedAt: number;
  status: ObjectionStatus;
  votesUphold: number;  // bitmap of seats (Fallback: of monitors, bit = seat * 2 + slot)
  votesDismiss: number;
}

export interface MockGuardState {
  address: Base58;
  enabled: boolean;
  objectionWindowSecs: number;
  successionWaitSecs: number;
  fallbackWaitSecs: number;
  seats: MockSeat[];
  fallback: FallbackInput[];
  fallbackDead: boolean[];
  fallbackStartedAt: number | null;
  fallbackDone: boolean;
  /** ApprovalStamp per target (claims): who brought it to its threshold and when. */
  stamps: Record<Base58, { seatIndex: number; approver: Base58; approvedAt: number }>;
  feed: SeatApprovalItem[];
  objections: MockObjection[];
  media: Record<Base58, { kind: AssetKind; title: string; description?: string; photos: AssetPhoto[]; spec?: AssetSpec; photosRoot: string; updatedAt: number }>;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeAddr = () => Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join("");
const nowSecs = () => Math.floor(Date.now() / 1000);
const bitCount = (m: number) => [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => (m & (1 << i)) !== 0).length;

export function blankGuard(): MockGuardState {
  return {
    address: fakeAddr(), enabled: false, ...GUARD_DEMO_TIMINGS,
    seats: [], fallback: [], fallbackDead: [], fallbackStartedAt: null, fallbackDone: false,
    stamps: {}, feed: [], objections: [], media: {},
  };
}

export interface GuardDeps {
  guard(): MockGuardState;
  snap(): EstateSnapshot;
  names(): Record<Base58, string>;
  created(): boolean;
  me(): Base58;
  agent: Base58;
  tx(): TxResult;
  log(kind: string, text: string, t: TxResult, amount?: bigint, payment?: PaymentRef): void;
  credit(wallet: Base58, amount: bigint): void;
  usd(amount: bigint): string;
}

export function createMockGuardians(d: GuardDeps) {
  const g = () => d.guard();
  const est = () => d.snap().estate;
  const name = (a: Base58) => d.names()[a] ?? "Someone";
  const first = (a: Base58) => shortName(name(a)); // the short form used in sentences (lib/names)
  const remember = (people: Named[]) => { for (const p of people) if (p.name && !(p.wallet in d.names())) d.names()[p.wallet] = p.name; };

  const needCreated = () => need(d.created(), "NoEstate", "There is no estate yet. The owner signs the will first.");
  const needGuard = () => { needCreated(); need(g().enabled, "BadStatus", "Guardians are not set up for this estate."); };
  const needOwnerActive = () => {
    need(d.me() === est().owner, "NotOwner", "Only the estate owner can do this.");
    need(est().status === "Active", "BadStatus", "This can only change while the estate is active.");
  };
  const seat = (index: number) => g().seats.find((s) => s.index === index) ?? fail("BadStatus", "That trusted person's seat does not exist.");
  /** An Open objection lapses (counts as dismissed): Fallback after the fallback wait, the others after two waiting periods. */
  const lapsesAt = (o: MockObjection) => (o.status !== "Open" ? null
    : o.kind === "Fallback" ? o.raisedAt + g().fallbackWaitSecs : objectionLapsesAt(o.raisedAt, est().waitingPeriodSecs));
  const openObjection = (target: Base58) =>
    g().objections.find((o) => o.target === target && o.status === "Open" && (o.kind === "Fallback" || !lapsed(o)));
  const lapsed = (o: MockObjection) => { const at = lapsesAt(o); return at !== null && nowSecs() >= at; };
  function markLapsed(o: MockObjection) {
    o.status = "Dismissed";
    d.log("ObjectionResolved", o.kind === "Fallback" ? "The objection lapsed: it was not upheld in time, so the fallback plan can go ahead" : "The objection lapsed: it was not upheld in time, so the paused step can go ahead", d.tx());
  }

  function createSeats() {
    const e = est();
    for (const index of [0, 1, 2]) {
      if (g().seats.some((s) => s.index === index)) continue;
      const holder = e.verifiers[index] && e.verifiers[index] !== VACANT_KEY ? e.verifiers[index] : null;
      g().seats.push({ address: fakeAddr(), index, holder, backups: [], monitors: [], generation: 0, vacant: !holder, succession: null });
    }
    g().seats.sort((a, b) => a.index - b.index);
  }

  function validBackups(index: number, wallets: Base58[]) {
    need(wallets.length <= 2, "BadBackup", "Name at most two backups.");
    need(new Set(wallets).size === wallets.length, "BadBackup", "The same person is named twice.");
    const holders = est().verifiers;
    for (const w of wallets) {
      need(!!w && w !== VACANT_KEY, "BadBackup", "A backup needs a wallet address.");
      need(w !== est().owner, "BadBackup", "The owner cannot be a backup.");
      need(w !== seat(index).holder, "BadBackup", "A trusted person cannot be their own backup.");
      need(!holders.includes(w), "BadBackup", "This person already holds another seat.");
    }
  }

  function validMonitors(index: number, wallets: Base58[]) {
    need(wallets.length <= 2, "BadMonitor", "Name at most two monitors.");
    need(new Set(wallets).size === wallets.length, "BadMonitor", "The same person is named twice.");
    for (const w of wallets) {
      need(!!w && w !== VACANT_KEY, "BadMonitor", "A monitor needs a wallet address.");
      need(w !== seat(index).holder, "BadMonitor", "A trusted person cannot watch themselves.");
    }
  }

  function validFallback(list: FallbackInput[]) {
    need(list.length <= 4, "BadFallback", "Name at most four fallback recipients.");
    need(new Set(list.map((r) => r.wallet)).size === list.length, "BadFallback", "The same recipient is named twice.");
    for (const r of list) {
      need(!!r.wallet && r.wallet !== VACANT_KEY, "BadFallback", "Each recipient needs a wallet address.");
      need(r.wallet !== est().owner, "BadFallback", "The owner cannot be a fallback recipient.");
    }
  }

  /* ----- owner setup ----- */

  function setup(input: {
    seats: { index: number; backups: Named[]; monitors: Named[] }[];
    fallback: FallbackInput[];
  }): TxResult[] {
    needCreated(); needOwnerActive();
    const txs: TxResult[] = [];
    if (!g().enabled) {
      g().enabled = true;
      createSeats();
      const t = d.tx(); txs.push(t);
      d.log("GuardCreated", "Guardians switched on: approvals now wait for an objection window", t);
    }
    for (const s of input.seats) {
      need(s.index >= 0 && s.index <= 2, "BadStatus", "There are only three trusted people.");
      remember([...s.backups, ...s.monitors]);
      txs.push(setBackups(s.index, s.backups.map((b) => b.wallet)));
      txs.push(setMonitors(s.index, s.monitors.map((m) => m.wallet)));
    }
    if (input.fallback.length) txs.push(setFallback(input.fallback));
    return txs;
  }

  function setBackups(index: number, wallets: Base58[]): TxResult {
    needGuard();
    const s = seat(index);
    const isHolder = !!s.holder && d.me() === s.holder;
    if (!isHolder) needOwnerActive();
    need(!s.succession, "SuccessionPending", "A passing is being confirmed for this seat.");
    validBackups(index, wallets);
    s.backups = [...wallets];
    const t = d.tx();
    const who = s.holder ? first(s.holder) : "this seat";
    d.log("SeatBackupsSet", wallets.length ? `Backups for ${who}: ${wallets.map(first).join(", then ")}` : `${who} has no backups`, t);
    return t;
  }

  function setMonitors(index: number, wallets: Base58[]): TxResult {
    needGuard(); needOwnerActive();
    const s = seat(index);
    validMonitors(index, wallets);
    s.monitors = [...wallets];
    const t = d.tx();
    d.log("SeatMonitorsSet", wallets.length
      ? `${wallets.map(first).join(" and ")} now ${wallets.length > 1 ? "watch" : "watches"} ${s.holder ? first(s.holder) : "this seat"}'s approvals`
      : `Nobody watches ${s.holder ? first(s.holder) : "this seat"} now`, t);
    return t;
  }

  function setFallback(list: FallbackInput[]): TxResult {
    needGuard(); needOwnerActive();
    need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
    validFallback(list);
    remember(list);
    g().fallback = list.map((r) => ({ ...r }));
    g().fallbackDead = list.map(() => false);
    g().fallbackStartedAt = null; // the owner is alive and changing the plan: a started countdown is void
    const t = d.tx();
    d.log("FallbackSet", `Fallback order set: ${list.map((r) => r.name).join(", then ")}`, t);
    return t;
  }

  /**
   * owner_replace_seat: the living owner swaps the person in a seat (or fills an empty one). Same checks as the
   * program: the owner, estate Active (BadStatus), the new holder set, not the owner and not holding any seat
   * (DuplicateVerifier). Backups and monitors stay, minus the new holder; a reported passing is cleared.
   */
  function replaceSeat(index: number, newHolder: Named): TxResult {
    needGuard(); needOwnerActive();
    const s = seat(index);
    const e = est();
    const w = newHolder.wallet.trim();
    need(!!w && w !== VACANT_KEY, "DuplicateVerifier", "The new trusted person needs a wallet address.");
    need(w !== e.owner, "DuplicateVerifier", "The owner cannot be their own trusted person.");
    need(!e.verifiers.includes(w), "DuplicateVerifier", "This person already holds a trusted place.");
    remember([{ wallet: w, name: newHolder.name.trim() }]);
    const previous = s.holder;
    s.holder = w;
    s.backups = s.backups.filter((b) => b !== w);
    s.monitors = s.monitors.filter((m) => m !== w);
    s.vacant = false;
    s.generation += 1;
    s.succession = null;
    e.verifiers[index] = w;
    e.verifierNames[index] = name(w);
    const t = d.tx();
    d.log("SeatConfigured", previous ? `${name(w)} replaces ${name(previous)} as a trusted person` : `${name(w)} fills an empty trusted place`, t);
    return t;
  }

  /* ----- approvals, stamps and the objection window (hooks for mock.ts) ----- */

  /** SeatApproval event: called by attest_death / approve_claim / approve_hardship. */
  function recordApproval(item: { kind: TargetKind; seatIndex: number; target: Base58; summary: string; t: TxResult; deadline: number | null }) {
    if (!g().enabled) return;
    const approver = d.me();
    g().feed.unshift({
      seatIndex: item.seatIndex, approver, approverName: name(approver), kind: item.kind, target: item.target,
      summary: item.summary, ts: nowSecs(), txSignature: item.t.signature, objectionDeadline: item.deadline,
    });
  }

  /** approve_claim reached its threshold: init the ApprovalStamp. Returns the objection deadline. */
  function stamp(target: Base58, seatIndex: number): number | null {
    if (!g().enabled) return null;
    const approvedAt = nowSecs();
    if (!g().stamps[target]) g().stamps[target] = { seatIndex, approver: d.me(), approvedAt };
    return g().stamps[target].approvedAt + g().objectionWindowSecs;
  }

  /** execute_claim with a Guard: the stamp must exist, the window must have passed, and no objection may be open. */
  function checkClaimExecutable(claim: Base58, byQuorum: boolean) {
    if (!g().enabled) return;
    need(!openObjection(claim), "ObjectionOpen", "A monitor objected. This payment waits until the objection is decided.");
    if (!byQuorum) return; // the owner's own approval (living plan) is not a seat approval
    const st = g().stamps[claim];
    need(!!st, "ObjectionWindowOpen", "This approval has not been recorded yet.");
    need(nowSecs() >= st.approvedAt + g().objectionWindowSecs, "ObjectionWindowOpen", "The objection window is still open. Try again shortly.");
  }

  /** finalize_unlock / accept_offer / hardship-gated sales: no open objection on the target. */
  function checkNotObjected(target: Base58) {
    if (!g().enabled) return;
    need(!openObjection(target), "ObjectionOpen", "A monitor objected. This waits until the objection is decided.");
  }

  /* ----- succession ----- */

  /** report_seat_death + review_seat_death in one step (the agent's verdict is already known). */
  function reportSeatDeath(index: number, certHash: string, report: AgentReport): TxResult {
    needGuard();
    const s = seat(index);
    need(!s.vacant && !!s.holder, "SeatVacant", "This seat is already empty.");
    need(d.me() !== s.holder, "BadStatus", "You cannot report your own passing.");
    need(!s.succession, "SuccessionPending", "A passing is already being confirmed for this seat.");
    const t = d.tx();
    d.log("SeatDeathReported", `${first(d.me())} reported that ${first(s.holder!)} has passed away`, t);
    if (report.verdict !== "approve") {
      d.log("SeatDeathReviewed", "The agent could not accept the certificate. Nothing has changed", d.tx());
      return t;
    }
    // The wait starts when another trusted person confirms (pendingSince stays 0 until then).
    s.succession = { certHash, reportedBy: d.me(), verdict: "Approved", report, confirmedBy: null, pendingSince: 0 };
    d.log("SeatDeathReviewed", `The agent read ${first(s.holder!)}'s death certificate and found no problems`, d.tx());
    return t;
  }

  /** Holders of the other seats (as on-chain: estate.verifiers[j] is set). */
  const otherLivingHolders = (index: number) =>
    est().verifiers.filter((v, j) => j !== index && !!v && v !== VACANT_KEY);

  function confirmSeatDeath(index: number): TxResult {
    needGuard();
    const s = seat(index);
    const sc = s.succession ?? fail("NoSuccessionPending", "No passing has been reported for this seat.");
    need(sc.verdict === "Approved", "AgentNotApproved", "The agent has not cleared the certificate.");
    need(!sc.confirmedBy, "AlreadyApproved", "This passing has already been confirmed.");
    const me = d.me();
    need(me !== sc.reportedBy, "NotConfirmer", "The person who reported the passing cannot also confirm it.");
    need(me !== s.holder, "NotConfirmer", "You cannot confirm your own passing.");
    need(me !== s.backups[0], "NotConfirmer", "The next holder cannot confirm their own promotion.");
    const others = otherLivingHolders(index);
    const allowed = others.length ? others : [s.backups[1], ...s.monitors].filter(Boolean);
    need(allowed.includes(me), "NotConfirmer", others.length
      ? "Only another trusted person can confirm this."
      : "Only this seat's second backup or a monitor can confirm this.");
    sc.confirmedBy = me;
    sc.pendingSince = nowSecs();
    const t = d.tx();
    d.log("SeatDeathConfirmed", `${first(me)} confirmed ${first(s.holder!)}'s passing. ${s.backups[0] ? `${first(s.backups[0])} takes the seat after a short wait` : "The seat becomes empty after a short wait"}`, t);
    return t;
  }

  function vetoSeatDeath(index: number): TxResult {
    needGuard();
    const s = seat(index);
    need(!!s.succession, "NoSuccessionPending", "No passing has been reported for this seat.");
    need(d.me() === s.holder, "NotVerifier", "Only the person reported as passed can cancel this.");
    s.succession = null;
    const t = d.tx();
    d.log("SeatDeathVetoed", `${first(s.holder!)} said "I'm still here". The report was cancelled`, t);
    return t;
  }

  function finalizeSuccession(index: number): TxResult {
    needGuard();
    const s = seat(index);
    const sc = s.succession ?? fail("NoSuccessionPending", "No passing has been reported for this seat.");
    need(sc.verdict === "Approved", "AgentNotApproved", "The agent has not cleared the certificate.");
    need(!!sc.confirmedBy, "NotConfirmer", "Another trusted person must confirm the passing first.");
    need(nowSecs() >= sc.pendingSince + g().successionWaitSecs, "WaitingPeriodNotOver", "The waiting period has not ended yet.");
    need(!openObjection(s.address), "ObjectionOpen", "A monitor objected. This waits until the objection is decided.");
    const gone = s.holder!;
    const e = est();
    // First backup still eligible: not the owner, not already a holder, not the reporter or confirmer.
    const pick = s.backups.findIndex((b) => b !== e.owner && !e.verifiers.includes(b) && b !== sc.confirmedBy && b !== sc.reportedBy);
    need(pick >= 0 || s.backups.length === 0, "BadBackup", "No backup can take this seat. The owner or a new report must sort it out.");
    const next = pick >= 0 ? s.backups[pick] : null;
    s.succession = null;
    s.generation += 1;
    const t = d.tx();
    if (next) {
      s.holder = next;
      s.backups = pick === 0 ? s.backups.slice(1) : [];
      s.monitors = s.monitors.filter((m) => m !== next);
      e.verifiers[index] = next;
      e.verifierNames[index] = name(next);
      d.log("SuccessionFinalized", `${first(next)} now holds ${first(gone)}'s seat as a trusted person`, t);
    } else {
      s.holder = null;
      s.vacant = true;
      s.backups = [];
      e.verifiers[index] = VACANT_KEY;
      d.log("SeatVacated", `${first(gone)}'s seat is now empty: no backup was left`, t);
    }
    return t;
  }

  /* ----- objections ----- */

  function targetIsLive(kind: TargetKind, target: Base58, seatIndex: number | null) {
    const sn = d.snap();
    switch (kind) {
      case "Claim": {
        const c = sn.claims.find((x) => x.address === target) ?? fail("BadStatus", "That claim does not exist.");
        need(c.status === "Open", "BadStatus", "This claim is already closed.");
        need(!!c.approvals[seatIndex ?? -1], "BadStatus", "The person you watch has not approved this.");
        return;
      }
      case "Hardship": {
        const h = sn.hardships.find((x) => x.address === target) ?? fail("BadStatus", "That request does not exist.");
        need(h.status !== "Rejected", "BadStatus", "This request is already closed.");
        need(!!h.approvals[seatIndex ?? -1], "BadStatus", "The person you watch has not approved this.");
        need(sn.assets.find((a) => a.address === h.asset)?.status !== "Sold", "BadStatus", "The asset has already been sold.");
        return;
      }
      case "Sale": {
        const a = sn.assets.find((x) => x.address === target) ?? fail("BadStatus", "That asset does not exist.");
        need(a.status === "Listed", "BadStatus", "This asset is not for sale.");
        return;
      }
      case "Unlock":
        need(target === est().address, "BadStatus", "That is not this estate.");
        need(est().status === "DeathPending" || (est().status === "Active" && !!est().death.certHash), "BadStatus", "No passing is being confirmed.");
        return;
      case "Succession": {
        const s = seat(seatIndex ?? -1);
        need(target === s.address, "BadStatus", "That is not this seat.");
        need(!!s.succession, "NoSuccessionPending", "No passing has been reported for this seat.");
        return;
      }
      case "Fallback":
        need(target === g().address, "BadStatus", "That is not this estate's fallback plan.");
        need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
        need(g().fallbackStartedAt !== null, "FallbackNotReady", "The fallback plan is not running.");
    }
  }

  function raiseObjection(input: { kind: TargetKind; target: Base58; seatIndex: number | null; reason: string }, reasonHash: string): TxResult {
    needGuard();
    const me = d.me();
    const reason = input.reason.trim();
    need(reason.length > 0, "BadStatus", "Write a short reason.");
    need(reason.length <= 1000, "StringTooLong", "Keep the reason under 1,000 characters.");
    const seatSpecific = input.kind !== "Unlock" && input.kind !== "Fallback";
    if (seatSpecific) {
      need(input.seatIndex !== null && input.seatIndex >= 0 && input.seatIndex <= 2, "NotMonitor", "Choose the trusted person you watch.");
      need(seat(input.seatIndex!).monitors.includes(me), "NotMonitor", "Only a monitor of this trusted person can object.");
    } else {
      const anyMonitor = g().seats.some((s) => s.monitors.includes(me));
      const beneficiary = input.kind === "Fallback" && d.snap().beneficiaries.some((b) => b.wallet === me && b.active);
      need(anyMonitor || beneficiary, "NotMonitor", input.kind === "Fallback" ? "Only a monitor or a family member can object." : "Only a monitor can object.");
    }
    targetIsLive(input.kind, input.target, input.seatIndex);
    // One objection per target at a time; a decided one may be raised again, except a dismissed one on a claim or hardship.
    const prev = g().objections.find((o) => o.target === input.target);
    if (prev) {
      need(prev.status !== "Open", "ObjectionOpen", "An objection is already open on this.");
      if (prev.status === "Open" && prev.kind !== "Fallback" && lapsed(prev)) markLapsed(prev);
      need(!(prev.status === "Dismissed" && (input.kind === "Claim" || input.kind === "Hardship")), "BadStatus", "This objection was already dismissed.");
      need(!(input.kind === "Unlock" && prev.status === "Dismissed" && prev.raisedAt >= (est().death.pendingSince ?? 0)), "BadStatus", "This waiting period has already been challenged once.");
      if (prev.status === "Dismissed" && (input.kind === "Sale" || input.kind === "Succession")) {
        const free = objectionLapsesAt(prev.raisedAt, est().waitingPeriodSecs) + Math.max(est().waitingPeriodSecs, 60);
        need(nowSecs() >= free, "ObjectionCooldown", "It is too soon to object to this again.");
      }
      // One fallback objection per countdown: a dismissed or lapsed one can't be raised again until it restarts.
      need(!(input.kind === "Fallback" && prev.status === "Dismissed" && prev.raisedAt >= (g().fallbackStartedAt ?? Infinity)), "BadStatus", "An objection to this countdown was already decided.");
      g().objections = g().objections.filter((o) => o !== prev);
    }
    g().objections.unshift({
      address: fakeAddr(), kind: input.kind, target: input.target, monitor: me, seatIndex: seatSpecific ? input.seatIndex : null,
      reason, reasonHash, raisedAt: nowSecs(), status: "Open", votesUphold: 0, votesDismiss: 0,
    });
    remember([{ wallet: me, name: name(me) }]);
    const t = d.tx();
    const watched = seatSpecific ? seat(input.seatIndex!).holder : null;
    d.log("ObjectionRaised", `${first(me)} objected${watched ? ` to ${first(watched)}'s approval` : ""}. It is paused until the trusted people decide`, t);
    return t;
  }

  function resolve(o: MockObjection, upheld: boolean) {
    o.status = upheld ? "Upheld" : "Dismissed";
    if (!upheld) return;
    const sn = d.snap();
    const e = est();
    switch (o.kind) {
      case "Claim": {
        const c = sn.claims.find((x) => x.address === o.target);
        if (c) c.status = "Rejected";
        return;
      }
      case "Unlock":
        if (e.status === "Unlocked") return;
        e.status = "Active";
        e.death = { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null };
        return;
      case "Succession": {
        const s = g().seats.find((x) => x.address === o.target);
        if (s) s.succession = null;
        return;
      }
      case "Fallback":
        g().fallbackStartedAt = null;
        return;
      case "Sale": {
        const a = sn.assets.find((x) => x.address === o.target);
        if (!a) return;
        // The listing is cancelled; offers can only be accepted after a fresh listing.
        if (a.status === "Listed") a.status = "Held";
        return;
      }
      case "Hardship": {
        const h = sn.hardships.find((x) => x.address === o.target);
        if (!h) return;
        h.status = "Rejected";
        const a = sn.assets.find((x) => x.address === h.asset);
        if (a && a.hardshipBeneficiary === h.beneficiary) a.hardshipBeneficiary = null;
      }
    }
  }

  function voteObjection(address: Base58, uphold: boolean): TxResult {
    needGuard();
    const o = g().objections.find((x) => x.address === address) ?? fail("BadStatus", "That objection does not exist.");
    need(o.status === "Open", "BadStatus", "This objection has already been decided.");
    need(!lapsed(o), "ObjectionLapsed", "This objection has lapsed: its waiting period is over.");
    const me = d.me();
    const e = est();
    const t = d.tx();
    if (me === e.owner && e.status === "Active") {
      resolve(o, uphold);
      d.log("ObjectionResolved", `${first(me)} ${uphold ? "upheld" : "dismissed"} ${first(o.monitor)}'s objection`, t);
      return t;
    }
    need(me !== o.monitor, "NotVerifier", "You raised this objection, so you cannot vote on it.");
    let bit: number;
    if (o.kind === "Fallback") {
      // Every trusted person is gone: the monitors decide (bit = seat * 2 + monitor slot).
      const s = g().seats.find((x) => x.monitors.includes(me)) ?? fail("NotMonitor", "Only a monitor can decide this.");
      bit = 1 << (s.index * 2 + s.monitors.indexOf(me));
    } else {
      const i = e.verifiers.indexOf(me);
      need(i >= 0 && me !== VACANT_KEY, "NotVerifier", "Only a trusted person or the owner can decide this.");
      need(o.seatIndex === null || i !== o.seatIndex, "NotVerifier", "The person being watched cannot vote on this.");
      bit = 1 << i;
    }
    need(((o.votesUphold | o.votesDismiss) & bit) === 0, "AlreadyApproved", "You have already voted.");
    o[uphold ? "votesUphold" : "votesDismiss"] |= bit;
    const n = bitCount(uphold ? o.votesUphold : o.votesDismiss);
    d.log("ObjectionVoted", `${first(me)} voted to ${uphold ? "uphold" : "dismiss"} the objection (${n} of 2)`, t);
    if (n >= 2) {
      resolve(o, uphold);
      d.log("ObjectionResolved", uphold ? "The objection was upheld. The paused step was cancelled" : "The objection was dismissed. The paused step can go ahead", d.tx());
    }
    return t;
  }

  /* ----- fallback plan ----- */

  function reportFallbackDeath(i: number, _certHash: string, report: AgentReport): TxResult {
    needGuard();
    need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
    const r = g().fallback[i] ?? fail("NoFallbackRecipient", "That fallback recipient does not exist.");
    need(!g().fallbackDead[i], "BadStatus", "This passing is already recorded.");
    const t = d.tx();
    d.log("FallbackDeathReported", `${first(d.me())} reported that ${r.name} has passed away`, t);
    if (report.verdict !== "approve") {
      d.log("FallbackDeathReviewed", "The agent could not accept the certificate. Nothing has changed", d.tx());
      return t;
    }
    g().fallbackDead[i] = true;
    // The recipient changed: restart the countdown so the family can object to the new one.
    if (g().fallbackStartedAt !== null) g().fallbackStartedAt = nowSecs();
    d.log("FallbackDeathReviewed", `The agent checked the certificate: ${r.name} is skipped in the fallback order`, d.tx());
    return t;
  }

  const allSeatsVacant = () => g().seats.length === 3 && g().seats.every((s) => s.vacant && !s.holder);
  const nextRecipient = () => g().fallback.findIndex((_r, k) => !g().fallbackDead[k]);
  /** A heartbeat (or veto) after the start voids the countdown (on-chain: last_heartbeat >= started_at; the mock
   * ignores a heartbeat in the very same second, which only the instant demo seeding can produce). */
  const startVoided = () => g().fallbackStartedAt !== null && est().lastHeartbeat > g().fallbackStartedAt!;
  const ownerDeathProven = () => est().death.verdict === "Approved" || est().status === "Unlocked";

  function startFallback(): TxResult {
    needGuard();
    need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
    need(g().fallbackStartedAt === null || startVoided(), "BadStatus", "The fallback plan has already started.");
    need(allSeatsVacant(), "SeatsNotVacant", "A trusted person is still available, so the fallback plan cannot start.");
    need(ownerDeathProven(), "FallbackNotReady", "The owner's passing has not been proven.");
    need(nextRecipient() >= 0, "NoFallbackRecipient", "Every fallback recipient has passed away.");
    g().fallbackStartedAt = nowSecs();
    const t = d.tx();
    d.log("FallbackStarted", "All trusted people are gone. The fallback plan has started its waiting period", t);
    return t;
  }

  function executeFallback(): TxResult {
    needGuard();
    need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
    const started = g().fallbackStartedAt ?? fail("FallbackNotReady", "The fallback plan has not started.");
    need(!startVoided(), "FallbackNotReady", "The owner checked in after the plan started.");
    need(ownerDeathProven(), "FallbackNotReady", "The owner's passing has not been proven.");
    need(allSeatsVacant(), "SeatsNotVacant", "A trusted person is available again.");
    need(nowSecs() >= started + g().fallbackWaitSecs, "WaitingPeriodNotOver", "The waiting period has not ended yet.");
    const fo = openObjection(g().address);
    if (fo && lapsed(fo)) markLapsed(fo); // a lapsed objection is closed in the same step, then the payout runs
    need(!openObjection(g().address), "ObjectionOpen", "Someone objected. This waits until the objection is decided.");
    const i = nextRecipient();
    need(i >= 0, "NoFallbackRecipient", "Every fallback recipient has passed away.");
    const r = g().fallback[i];
    const e = est();
    const amount = e.vaultBalance;
    e.vaultBalance = 0n;
    d.credit(r.wallet, amount);
    g().fallbackDone = true;
    e.status = "Unlocked";
    const t = d.tx();
    d.log("FallbackExecuted", `Fallback plan: the whole vault (${d.usd(amount)}) went to ${r.name}`, t, amount, { payee: r.wallet });
    return t;
  }

  /** Anyone: closes an Open Fallback objection that was not upheld in time. The countdown is not restarted. */
  function lapseObjection(): TxResult {
    needGuard();
    const o = openObjection(g().address) ?? fail("BadStatus", "There is no open objection to the fallback plan.");
    need(lapsed(o), "ObjectionNotLapsed", "This objection cannot lapse yet.");
    const t = d.tx();
    markLapsed(o);
    return t;
  }

  /* ----- asset photos ----- */

  /**
   * `checked`: the spec sheet already run through specInputSchema by the caller (the service, which loads zod only
   * then). Without it the sheet is taken as given: the seeded demo assets, whose sheets the tests validate.
   */
  function setAssetMedia(asset: Base58, input: { kind: AssetKind; title: string; photos: AssetPhoto[]; description?: string; spec?: AssetSpec }, photosRoot: string, checked?: { success: boolean; data?: AssetSpec }): TxResult {
    needCreated();
    const me = d.me();
    need(me === d.agent || (me === est().owner && est().status === "Active"), "NotOwner", "Only the owner (while the estate is active) or the agent can change photos.");
    const a = d.snap().assets.find((x) => x.address === asset) ?? fail("BadStatus", "That asset does not exist.");
    need(input.photos.length <= MAX_PHOTOS, "InvalidAmount", `Add at most ${MAX_PHOTOS} photos.`);
    // Off-chain checks the photo API makes (the program only sees the root): known labels, a valid spec sheet.
    need(input.photos.every((p) => p.label === undefined || isPhotoLabel(p.label)), "InvalidSpec", "Every photo label must be one of the listed ones.");
    need(!checked || checked.success, "InvalidSpec", "Some details in the spec sheet are not valid.");
    const spec = cleanSpec(checked ? (checked.success ? checked.data : undefined) : input.spec);
    need(foreignSpecKeys(input.kind, spec).length === 0, "InvalidSpec", "Some details do not belong on this kind of asset.");
    g().media[asset] = {
      kind: input.kind, title: input.title || a.title, ...(input.description ? { description: input.description } : {}),
      photos: input.photos.map((p) => ({ ...p })), ...(spec ? { spec } : {}), photosRoot, updatedAt: nowSecs(),
    };
    const t = d.tx();
    d.log("AssetMediaSet", `${input.photos.length} photo${input.photos.length === 1 ? "" : "s"} saved for ${input.title || a.title}`, t);
    return t;
  }

  function assetMedia(): AssetMediaInfo[] {
    return Object.entries(g().media).map(([asset, m]) => ({ asset, ...structuredClone(m) }));
  }

  /* ----- reads ----- */

  function snapshot(): GuardiansSnapshot {
    const gs = g();
    const named = (w: Base58) => ({ wallet: w, name: name(w) });
    if (!gs.enabled) {
      return {
        enabled: false, ...GUARD_DEMO_TIMINGS, seats: [], feed: [], objections: [], claimPayableAt: {},
        fallback: { recipients: [], startedAt: null, readyAt: null, done: false, canStart: false },
      };
    }
    return {
      enabled: true, address: gs.address,
      objectionWindowSecs: gs.objectionWindowSecs, successionWaitSecs: gs.successionWaitSecs, fallbackWaitSecs: gs.fallbackWaitSecs,
      seats: gs.seats.map((s) => ({
        address: s.address, index: s.index, holder: s.holder, holderName: s.holder ? name(s.holder) : "",
        backups: s.backups.map(named), monitors: s.monitors.map(named), generation: s.generation, vacant: s.vacant,
        succession: s.succession ? {
          certHash: s.succession.certHash, reportedBy: s.succession.reportedBy, verdict: s.succession.verdict,
          report: s.succession.report ? structuredClone(s.succession.report) : undefined,
          confirmedBy: s.succession.confirmedBy, pendingSince: s.succession.pendingSince,
          readyAt: s.succession.pendingSince ? s.succession.pendingSince + gs.successionWaitSecs : 0,
          nextHolder: s.backups[0] ? named(s.backups[0]) : null,
        } : null,
      })),
      feed: gs.feed.map((f) => ({ ...f })),
      claimPayableAt: Object.fromEntries(Object.entries(gs.stamps).map(([claim, st]) => [claim, st.approvedAt + gs.objectionWindowSecs])),
      objections: gs.objections.map((o) => ({
        address: o.address, kind: o.kind, target: o.target, monitor: o.monitor, monitorName: name(o.monitor), seatIndex: o.seatIndex,
        reason: o.reason, reasonHash: o.reasonHash, raisedAt: o.raisedAt, status: o.status,
        votesUphold: bitCount(o.votesUphold), votesDismiss: bitCount(o.votesDismiss), lapsesAt: lapsesAt(o),
      })),
      fallback: {
        recipients: gs.fallback.map((r, i) => ({ wallet: r.wallet, name: r.name, kind: r.kind, dead: !!gs.fallbackDead[i] })),
        startedAt: gs.fallbackStartedAt,
        readyAt: gs.fallbackStartedAt === null ? null : gs.fallbackStartedAt + gs.fallbackWaitSecs,
        done: gs.fallbackDone,
        canStart: (gs.fallbackStartedAt === null || startVoided()) && !gs.fallbackDone && nextRecipient() >= 0 && allSeatsVacant() && ownerDeathProven(),
      },
    };
  }

  /* ----- demo clock helpers (mock shortcuts) ----- */

  function endObjectionWindow() {
    const back = g().objectionWindowSecs;
    for (const st of Object.values(g().stamps)) st.approvedAt -= back;
    for (const f of g().feed) if (f.objectionDeadline !== null) f.objectionDeadline -= back;
  }
  function endSuccessionWait() {
    for (const s of g().seats) if (s.succession?.pendingSince) s.succession.pendingSince -= g().successionWaitSecs;
  }
  function endFallbackWait() {
    const started = g().fallbackStartedAt;
    if (started === null) return;
    g().fallbackStartedAt = started - g().fallbackWaitSecs;
    // The same time passes for fallback objections (so they can lapse).
    for (const o of g().objections) if (o.kind === "Fallback") o.raisedAt -= g().fallbackWaitSecs;
    // Moving the clock must not make an earlier heartbeat look like a check-in after the start.
    if (est().lastHeartbeat <= started) est().lastHeartbeat = Math.min(est().lastHeartbeat, started - g().fallbackWaitSecs - 1);
  }
  /** Every holder and backup gone (demo of the fallback plan). */
  function vacateAllSeats() {
    needGuard();
    const e = est();
    for (const s of g().seats) {
      if (s.vacant) continue;
      s.holder = null; s.vacant = true; s.backups = []; s.succession = null; s.generation += 1;
      e.verifiers[s.index] = VACANT_KEY;
    }
    d.log("SeatVacated", "Demo: every trusted person and backup is recorded as passed away", d.tx());
  }

  return {
    setup, setBackups, setMonitors, setFallback, replaceSeat,
    recordApproval, stamp, checkClaimExecutable, checkNotObjected,
    reportSeatDeath, confirmSeatDeath, vetoSeatDeath, finalizeSuccession,
    raiseObjection, voteObjection,
    reportFallbackDeath, startFallback, executeFallback, lapseObjection,
    setAssetMedia, assetMedia, snapshot,
    endObjectionWindow, endSuccessionWait, endFallbackWait, vacateAllSeats,
    otherLivingHolders, seat,
  };
}

export type MockGuardians = ReturnType<typeof createMockGuardians>;
