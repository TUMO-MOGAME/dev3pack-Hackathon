/**
 * Guardians read side (docs/guardians-spec.md §2): decode Guard / Seat / Objection / ApprovalStamp / AssetMedia
 * accounts and the SeatApproval events into the GuardiansSnapshot the UI uses. Decoding and assembly are pure;
 * fetchGuardiansRaw does the RPC (one shared program scan, see reads.ts).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import type { AgentReport, Base58, Claim, Estate } from "../types";
import type { AssetKind, FallbackRecipient, GuardiansSnapshot, Objection, ObjectionStatus, Seat, SeatApprovalItem, TargetKind } from "../guardians/types";
import { formatUsdt, shortAddress } from "../format";
import { accountName, getCoder, getIdl } from "./idl";
import { bits, bool, enumOf, hex, key, num, type Raw } from "./decoders";
import { guardPda } from "./pda";
import { scanAccounts, type ChainEvent } from "./reads";
import { getConnection } from "./tx";

const DEFAULT_KEY = "11111111111111111111111111111111";
/** Byte offsets of Seat.monitors[0] and [1] (8 discriminator + 32 estate + 1 index + 32 holder + 2×32 backups). */
export const SEAT_MONITOR_OFFSETS = [137, 169] as const;
const ZERO_HASH = "0".repeat(64);
const NO_SEAT = 255;
const DISPUTE_SEAT = 254;
const TARGET_KIND = ["Claim", "Unlock", "Sale", "Hardship", "Succession", "Fallback"] as const satisfies readonly TargetKind[];
const OBJECTION_STATUS = ["Open", "Upheld", "Dismissed"] as const satisfies readonly ObjectionStatus[];
const ASSET_KIND = ["Car", "Motorbike", "Furniture", "Jewellery", "Electronics", "Other"] as const satisfies readonly AssetKind[];
const VERDICT = ["Pending", "Approved", "Rejected"] as const;

const set = (k: string) => !!k && k !== DEFAULT_KEY;
const keys = (r: Raw, name: string): string[] => {
  const v = r[name] ?? Object.entries(r).find(([k]) => k.replace(/_/g, "").toLowerCase() === name.replace(/_/g, "").toLowerCase())?.[1];
  if (!Array.isArray(v)) throw new Error(`Field "${name}" is not a key array`);
  return v.map((x) => (typeof x === "string" ? x : (x as { toBase58(): string }).toBase58()));
};
const countBits = (m: number) => bits(m, 8).filter(Boolean).length;

/** Off-chain extras: display names by wallet, objection reasons by hash, fallback kinds by wallet, agent reports by hash. */
export interface GuardianExtras {
  names: Record<Base58, string>;
  reasons: Record<string, string>;
  fallbackKinds: Record<Base58, FallbackRecipient["kind"]>;
  reports: Record<string, AgentReport>;
}

export interface RawGuardians {
  guard: { address: Base58; raw: Raw } | null;
  seats: { address: Base58; raw: Raw }[];
  objections: { address: Base58; raw: Raw }[];
  /** claim address → ApprovalStamp */
  stamps: Record<Base58, Raw>;
  /** asset address → AssetMedia */
  media: Record<Base58, Raw>;
}

const EMPTY: RawGuardians = { guard: null, seats: [], objections: [], stamps: {}, media: {} };

function decode(type: string, data: Uint8Array): Raw {
  return getCoder().accounts.decode(accountName(type), data as Parameters<ReturnType<typeof getCoder>["accounts"]["decode"]>[1]) as Raw;
}

const hasAccount = (name: string) => !!getIdl().accounts?.some((a) => a.name.toLowerCase() === name.toLowerCase());

/** Every guardians account of one estate. Older IDLs (no Guard account type) give an empty result. */
export async function fetchGuardiansRaw(estate: Base58, conn: Connection = getConnection()): Promise<RawGuardians> {
  if (!hasAccount("Guard")) return EMPTY;
  const programId = new PublicKey(getIdl().address);
  const estateKey = new PublicKey(estate);
  const guardAddr = guardPda(programId, estateKey);
  const children = async (type: string) =>
    (await scanAccounts(type, [{ offset: 8, key: estateKey }], conn)).map((a) => ({ address: a.pubkey.toBase58(), raw: decode(type, a.data) }));
  const [guards, seats, objections, stampsAll, mediaAll] = await Promise.all([
    scanAccounts("Guard", [{ offset: 8, key: estateKey }], conn),
    children("Seat"),
    children("Objection"),
    scanAccounts("ApprovalStamp", [], conn),
    scanAccounts("AssetMedia", [], conn),
  ]);
  const g = guards.find((a) => a.pubkey.equals(guardAddr));
  const byTarget = (list: typeof stampsAll, type: string) =>
    Object.fromEntries(list.map((a) => [new PublicKey(a.data.subarray(8, 40)).toBase58(), decode(type, a.data)]));
  return {
    guard: g ? { address: g.pubkey.toBase58(), raw: decode("Guard", g.data) } : null,
    seats: seats.sort((a, b) => num(a.raw, "index") - num(b.raw, "index")),
    objections,
    stamps: byTarget(stampsAll, "ApprovalStamp"),
    media: byTarget(mediaAll, "AssetMedia"),
  };
}

export const disabledGuardians = (): GuardiansSnapshot => ({
  enabled: false, objectionWindowSecs: 0, successionWaitSecs: 0, fallbackWaitSecs: 0, seats: [], feed: [], objections: [], claimPayableAt: {},
  fallback: { recipients: [], startedAt: null, readyAt: null, done: false, canStart: false },
});

/** Joins the raw accounts, the estate's events and the off-chain extras into the UI shape. Pure. */
export function assembleGuardians(
  raw: RawGuardians,
  ctx: { estate: Estate; claims: Claim[]; events: ChainEvent[]; extras: GuardianExtras },
): GuardiansSnapshot {
  if (!raw.guard) return disabledGuardians();
  const { estate, claims, events, extras } = ctx;
  const g = raw.guard.raw;
  const window = num(g, "objection_window_secs");
  const successionWait = num(g, "succession_wait_secs");
  const fallbackWait = num(g, "fallback_wait_secs");
  const name = (w: Base58) => extras.names[w] ?? shortAddress(w);
  const named = (w: Base58) => ({ wallet: w, name: name(w) });

  const latestReview = (seatIndex: number) => {
    const ev = events.find((e) => e.name.toLowerCase() === "seatdeathreviewed" && num(e.data, "seat_index") === seatIndex);
    if (!ev) return undefined;
    try { return extras.reports[hex(ev.data, "report_hash")]; } catch { return undefined; }
  };

  const seats: Seat[] = raw.seats.map(({ address, raw: s }) => {
    const index = num(s, "index");
    const holder = key(s, "holder");
    const backups = keys(s, "backups").filter(set);
    const monitors = keys(s, "monitors").filter(set);
    const cert = hex(s, "death_cert_hash");
    const reportedBy = key(s, "death_reported_by");
    const confirmedBy = key(s, "death_confirmed_by");
    const pendingSince = num(s, "death_pending_since");
    // Mirrors finalize_succession: the first backup who is not the owner, a current holder, the reporter or the confirmer.
    const next = backups.find((b) => b !== estate.owner && !estate.verifiers.includes(b) && b !== reportedBy && b !== confirmedBy);
    return {
      address, index, holder: set(holder) ? holder : null, holderName: set(holder) ? (extras.names[holder] ?? estate.verifierNames[index] ?? shortAddress(holder)) : "",
      backups: backups.map(named), monitors: monitors.map(named), generation: num(s, "generation"), vacant: bool(s, "vacant"),
      succession: cert === ZERO_HASH ? null : {
        certHash: cert, reportedBy, verdict: enumOf(s, "death_verdict", VERDICT), report: latestReview(index),
        confirmedBy: set(confirmedBy) ? confirmedBy : null, pendingSince, readyAt: pendingSince > 0 ? pendingSince + successionWait : 0,
        nextHolder: next ? named(next) : null,
      },
    };
  });

  const stampOf = (claim: Base58) => raw.stamps[claim];
  const claimPayableAt: Record<Base58, number> = {};
  for (const [claim, st] of Object.entries(raw.stamps)) {
    const at = num(st, "approved_at");
    if (at > 0 && claims.some((c) => c.address === claim)) claimPayableAt[claim] = at + window;
  }

  const feed: SeatApprovalItem[] = events
    .filter((e) => e.name.toLowerCase() === "seatapproval")
    .map((e) => {
      const kind = enumOf(e.data, "kind", TARGET_KIND);
      const target = key(e.data, "target");
      const approver = key(e.data, "approver");
      const claim = kind === "Claim" ? claims.find((c) => c.address === target) : undefined;
      const stamp = kind === "Claim" ? stampOf(target) : undefined;
      const stampAt = stamp ? num(stamp, "approved_at") : 0;
      const summary = kind === "Claim"
        ? claim ? `Approved ${formatUsdt(claim.amount)} to ${name(claim.payee)} for ${name(claim.beneficiary)}` : "Approved a claim"
        : kind === "Unlock" ? `Confirmed ${estate.ownerName}'s passing`
          : kind === "Hardship" ? "Approved a request to sell below the minimum price" : "Approved";
      const deadline = kind === "Claim" ? (stampAt > 0 ? stampAt + window : null)
        : kind === "Unlock" && estate.death.pendingSince ? estate.death.pendingSince + estate.waitingPeriodSecs : null;
      return {
        seatIndex: num(e.data, "seat_index"), approver, approverName: name(approver), kind, target, summary,
        ts: num(e.data, "ts") || e.ts, txSignature: e.signature, objectionDeadline: deadline,
      };
    });

  // Disputes (seat_index 254) share the Objection account but are read by chain/disputes.ts.
  const objections: Objection[] = raw.objections.filter(({ raw: o }) => num(o, "seat_index") !== DISPUTE_SEAT).map(({ address, raw: o }) => {
    const seatIndex = num(o, "seat_index");
    const reasonHash = hex(o, "reason_hash");
    const monitor = key(o, "monitor");
    const kind = enumOf(o, "kind", TARGET_KIND);
    const status = enumOf(o, "status", OBJECTION_STATUS);
    const raisedAt = num(o, "raised_at");
    return {
      address, kind, target: key(o, "target"), monitor, monitorName: name(monitor),
      seatIndex: seatIndex === NO_SEAT ? null : seatIndex, reason: extras.reasons[reasonHash] ?? "", reasonHash,
      raisedAt, status, lapsesAt: kind === "Fallback" && status === "Open" ? raisedAt + fallbackWait : null,
      votesUphold: countBits(num(o, "votes_uphold")), votesDismiss: countBits(num(o, "votes_dismiss")),
    };
  }).sort((a, b) => b.raisedAt - a.raisedAt);

  const deadMask = num(g, "fallback_dead");
  const recipients = keys(g, "fallback").map((w, i) => ({ w, dead: (deadMask & (1 << i)) !== 0 })).filter((r) => set(r.w));
  const startedAt = num(g, "fallback_started_at");
  const done = bool(g, "fallback_done");
  const allVacant = seats.length === 3 && seats.every((s) => s.vacant && !s.holder);
  const ownerDeath = estate.status === "Unlocked" || estate.death.verdict === "Approved";
  const restartable = startedAt === 0 || estate.lastHeartbeat >= startedAt;

  return {
    enabled: true, address: raw.guard.address,
    objectionWindowSecs: window, successionWaitSecs: successionWait, fallbackWaitSecs: fallbackWait,
    seats, feed, objections, claimPayableAt,
    fallback: {
      recipients: recipients.map((r) => ({ wallet: r.w, name: name(r.w), kind: extras.fallbackKinds[r.w] ?? "heir", dead: r.dead })),
      startedAt: startedAt > 0 ? startedAt : null,
      readyAt: startedAt > 0 ? startedAt + fallbackWait : null,
      done,
      canStart: !done && restartable && allVacant && ownerDeath && recipients.some((r) => !r.dead),
    },
  };
}

/** AssetMedia account → its on-chain kind, root and count. */
export function decodeMedia(r: Raw): { kind: AssetKind; photosRoot: string; photoCount: number; updatedAt: number } {
  return { kind: enumOf(r, "kind", ASSET_KIND), photosRoot: hex(r, "photos_root"), photoCount: num(r, "photo_count"), updatedAt: num(r, "updated_at") };
}
