/**
 * Pure helpers for the guardians UI: who may do what, which stage a succession or the fallback plan is in, and the
 * small list edits the editors need. No React here, so every rule is unit-tested (derive.test.ts). The program
 * enforces the real rules; these only decide what the UI offers, so a refusal is rare and explained when it happens.
 */
import type { EstateSnapshot } from "@/lib/service";
import type { Base58 } from "@/lib/types";
import type { FallbackPlan, FallbackRecipient, GuardiansSnapshot, Objection, Seat, SeatApprovalItem } from "@/lib/guardians/types";

export interface Person { wallet: Base58; name: string }
export type DraftRecipient = { wallet: Base58; name: string; kind: FallbackRecipient["kind"] };

export const MAX_BACKUPS = 2;
export const MAX_MONITORS = 2;
export const MAX_FALLBACK = 4;

/** The guardians part of a snapshot, or null for estates without a Guard (or before the service provides it). */
export function guardiansOf(snap: EstateSnapshot | null | undefined): GuardiansSnapshot | null {
  return snap?.guardians ?? null;
}

/** Short form for friendly sentences: "Uncle Bongani Mokoena" → "Uncle Bongani", "Adv. Thandi Ndlovu" → "Adv. Ndlovu" (lib/names). */
export { shortName } from "@/lib/names";

/** Seats this wallet watches as a monitor. */
export function watchedSeats(g: GuardiansSnapshot | null, wallet: Base58 | null | undefined): Seat[] {
  if (!g || !wallet) return [];
  return g.seats.filter((s) => s.monitors.some((m) => m.wallet === wallet));
}

export const isMonitor = (g: GuardiansSnapshot | null, wallet: Base58 | null | undefined) => watchedSeats(g, wallet).length > 0;

/** The seat this wallet currently holds, if any. */
export function heldSeat(g: GuardiansSnapshot | null, wallet: Base58 | null | undefined): Seat | null {
  if (!g || !wallet) return null;
  return g.seats.find((s) => !s.vacant && s.holder === wallet) ?? null;
}

/** Approvals made by the holders this wallet watches, newest first. */
export function feedFor(g: GuardiansSnapshot | null, wallet: Base58 | null | undefined): SeatApprovalItem[] {
  const seats = new Set(watchedSeats(g, wallet).map((s) => s.index));
  return (g?.feed ?? []).filter((f) => seats.has(f.seatIndex)).sort((a, b) => b.ts - a.ts);
}

/** The objection raised against a target (newest first if there were several over time). */
export function objectionFor(g: GuardiansSnapshot | null, target: Base58): Objection | null {
  const list = (g?.objections ?? []).filter((o) => o.target === target).sort((a, b) => b.raisedAt - a.raisedAt);
  return list[0] ?? null;
}

/** An open objection pausing this target, if any: the UI shows "Paused: <name> raised an objection". */
export function pausedBy(g: GuardiansSnapshot | null, target: Base58): Objection | null {
  const o = objectionFor(g, target);
  return o && o.status === "Open" ? o : null;
}

/** Can a monitor still object to this approval? Only within the review window and only once per target. */
export function canObject(g: GuardiansSnapshot | null, item: SeatApprovalItem, now: number | null): boolean {
  if (!g || objectionFor(g, item.target)) return false;
  if (item.objectionDeadline === null) return true;
  return now !== null && now < item.objectionDeadline;
}

/** Feed items a monitor can still act on: the inbox badge. */
export function monitorPending(g: GuardiansSnapshot | null, wallet: Base58 | null | undefined, now: number | null): number {
  return feedFor(g, wallet).filter((f) => canObject(g, f, now)).length;
}

/**
 * Who may vote on an objection: a seat holder who is not the person being watched, or the owner while the estate is
 * Active (the owner decides alone). Returns "owner", "holder" or null.
 */
export function voterRole(g: GuardiansSnapshot | null, o: Objection, snap: EstateSnapshot, wallet: Base58 | null | undefined): "owner" | "holder" | null {
  if (!g || !wallet || o.status !== "Open") return null;
  if (wallet === snap.estate.owner) return snap.estate.status === "Active" ? "owner" : null;
  const mine = heldSeat(g, wallet);
  if (!mine) return null;
  if (o.seatIndex !== null && o.seatIndex === mine.index) return null;
  return "holder";
}

export type SuccessionStage = "none" | "reviewing" | "rejected" | "confirm" | "waiting" | "ready";

/** Where a reported passing of a trusted person stands. */
export function successionStage(seat: Seat, now: number | null): SuccessionStage {
  const s = seat.succession;
  if (!s) return "none";
  if (s.verdict === "Pending") return "reviewing";
  if (s.verdict === "Rejected") return "rejected";
  if (!s.confirmedBy) return "confirm";
  if (now === null || now < s.readyAt) return "waiting";
  return "ready";
}

/**
 * Who may confirm a reported passing (mirrors confirm_seat_death): the holder of another living seat; if no other
 * seat has a living holder, this seat's second backup or one of its monitors. Never the reporter, never backups[0]
 * (they would be confirming their own promotion), never the holder.
 */
export function canConfirm(g: GuardiansSnapshot | null, seat: Seat, wallet: Base58 | null | undefined): boolean {
  const s = seat.succession;
  if (!g || !wallet || !s || s.verdict !== "Approved" || s.confirmedBy) return false;
  if (wallet === seat.holder || wallet === s.reportedBy || wallet === seat.backups[0]?.wallet) return false;
  const others = g.seats.filter((x) => x.index !== seat.index && !x.vacant && x.holder);
  if (others.length > 0) return others.some((x) => x.holder === wallet);
  return seat.backups[1]?.wallet === wallet || seat.monitors.some((m) => m.wallet === wallet);
}

/** Anyone except the holder may report the holder's passing, while the seat is filled and nothing is pending. */
export function canReport(seat: Seat, wallet: Base58 | null | undefined): boolean {
  return !!wallet && !seat.vacant && !!seat.holder && seat.holder !== wallet && !seat.succession;
}

export type FallbackStage = "notNeeded" | "waitingOwner" | "ready" | "counting" | "executable" | "done";

/** Every seat is vacant (each holder and their backups are proven dead). */
export const allVacant = (g: GuardiansSnapshot | null) => !!g && g.seats.length > 0 && g.seats.every((s) => s.vacant);

export function fallbackStage(g: GuardiansSnapshot | null, now: number | null): FallbackStage {
  if (!g) return "notNeeded";
  const f = g.fallback;
  if (f.done) return "done";
  if (f.startedAt !== null) return now !== null && f.readyAt !== null && now >= f.readyAt ? "executable" : "counting";
  if (!allVacant(g)) return "notNeeded";
  return f.canStart ? "ready" : "waitingOwner";
}

/** Who the fallback pays: the first recipient not proven dead. */
export function fallbackWinner(plan: FallbackPlan): { recipient: FallbackRecipient; index: number } | null {
  const index = plan.recipients.findIndex((r) => !r.dead);
  return index < 0 ? null : { recipient: plan.recipients[index], index };
}

/** Seconds left until `readyAt`, never negative; null before the clock is known. */
export function secondsLeft(readyAt: number | null, now: number | null): number | null {
  if (readyAt === null || now === null) return null;
  return Math.max(0, readyAt - now);
}

/** Fraction of a wait that has passed (0..1), for the countdown ring. */
export function waitFraction(readyAt: number | null, waitSecs: number, now: number | null): number {
  const left = secondsLeft(readyAt, now);
  if (left === null || waitSecs <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - left / waitSecs));
}

/** Moves one item in a list (reorder by buttons). Out-of-range moves return the list unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

/** Rough base58 Solana address check (32–44 chars of the base58 alphabet). The program checks the real thing. */
export const looksLikeWallet = (w: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.trim());

export type PeopleError = "name" | "wallet" | "duplicate" | "holder" | "owner" | "otherHolder" | "tooMany";

/**
 * Checks a list of backups or monitors before it is sent (mirrors BadBackup / BadMonitor): each needs a name and a
 * wallet, no duplicates, never the holder they cover, never the owner; backups are also never another seat's holder.
 * Returns the first problem with its row, or null.
 */
export function checkPeople(
  list: readonly Person[], ctx: { kind: "backups" | "monitors"; seat: Seat; owner: Base58; holders: readonly (Base58 | null)[] },
): { row: number; error: PeopleError } | null {
  const max = ctx.kind === "backups" ? MAX_BACKUPS : MAX_MONITORS;
  if (list.length > max) return { row: max, error: "tooMany" };
  const seen = new Set<string>();
  for (let row = 0; row < list.length; row++) {
    const p = list[row];
    const w = p.wallet.trim();
    if (!p.name.trim()) return { row, error: "name" };
    if (!looksLikeWallet(w)) return { row, error: "wallet" };
    if (seen.has(w)) return { row, error: "duplicate" };
    seen.add(w);
    if (ctx.seat.holder && w === ctx.seat.holder) return { row, error: "holder" };
    if (ctx.kind === "backups" && w === ctx.owner) return { row, error: "owner" };
    if (ctx.kind === "backups" && ctx.holders.some((h, i) => h && i !== ctx.seat.index && h === w)) return { row, error: "otherHolder" };
  }
  return null;
}

export type FallbackError = "name" | "wallet" | "duplicate" | "tooMany" | "empty";

export function checkFallback(list: readonly DraftRecipient[]): { row: number; error: FallbackError } | null {
  if (list.length === 0) return { row: 0, error: "empty" };
  if (list.length > MAX_FALLBACK) return { row: MAX_FALLBACK, error: "tooMany" };
  const seen = new Set<string>();
  for (let row = 0; row < list.length; row++) {
    const r = list[row];
    if (!r.name.trim()) return { row, error: "name" };
    if (!looksLikeWallet(r.wallet)) return { row, error: "wallet" };
    if (seen.has(r.wallet.trim())) return { row, error: "duplicate" };
    seen.add(r.wallet.trim());
  }
  return null;
}

/** Everything a trusted person or the owner still has to act on in the guardians area (adds to the inbox badge). */
export function guardianTodo(g: GuardiansSnapshot | null, snap: EstateSnapshot, wallet: Base58 | null | undefined, now: number | null): number {
  if (!g || !wallet) return 0;
  const votes = g.objections.filter((o) => voterRole(g, o, snap, wallet) !== null).length;
  const confirms = g.seats.filter((s) => canConfirm(g, s, wallet)).length;
  const stillHere = g.seats.filter((s) => s.holder === wallet && s.succession && s.succession.verdict !== "Rejected").length;
  return votes + confirms + stillHere + monitorPending(g, wallet, now);
}

/** "2 days" / "90 days" / "60 seconds" / "2 minutes": the copy picks the words, this picks the unit. */
export function waitUnit(secs: number): { unit: "days" | "hours" | "minutes" | "seconds"; n: number } {
  if (secs >= 86400) return { unit: "days", n: Math.round(secs / 86400) };
  if (secs >= 3600) return { unit: "hours", n: Math.round(secs / 3600) };
  if (secs >= 120) return { unit: "minutes", n: Math.round(secs / 60) };
  return { unit: "seconds", n: secs };
}

/** Countdown text: "2d 4h", "3h 05m" or "1:30". */
export function clock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
