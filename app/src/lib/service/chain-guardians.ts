/**
 * GuardiansService on Solana (docs/guardians-spec.md §3). Writes: builders in lib/chain/instructions.ts, signed by
 * the active WDK wallet through chain.ts's pay-once pipeline (fee sponsored where the policy allows). The agent's
 * death-certificate reviews go through /api/review (purposes seat-death / fallback-death).
 *
 * Off-chain extras: people's display names go to the estate meta (`buyerNames` doubles as the names-by-wallet map);
 * objection reasons and fallback kinds are kept on this device (only the reason's hash is on-chain).
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { AgentReport, Base58, Claim, Estate } from "../types";
import type { AssetMediaInfo, FallbackRecipient, GuardiansService, GuardiansSnapshot } from "../guardians/types";
import { chainConfig } from "../chain/config";
import { DEVNET_DEMO_ESTATE, DEVNET_DEMO_FALLBACK_KINDS } from "../chain/demo-estate";
import type { TxResult } from "./types";
import type { EstateMeta } from "../db";
import { chainCtx } from "../chain/client";
import * as ix from "../chain/instructions";
import { guardPda, seatPda } from "../chain/pda";
import { fetchAccountRaw, type ChainEvent } from "../chain/reads";
import { assembleGuardians, decodeMedia, disabledGuardians, fetchGuardiansRaw, type GuardianExtras } from "../chain/guardians";
import { enumOf, key, num } from "../chain/decoders";
import { getActiveSigner } from "../wallet/signer";
import { sha256Hex } from "../agent/hash";
import { cleanSpec, foreignSpecKeys, mediaRootHex } from "../assets/spec";
import { MAX_PHOTOS } from "../media/webp";
import { photosApi } from "../media/client";

export const DISABLED_GUARDIANS: GuardiansSnapshot = disabledGuardians();

type Ixs = TransactionInstruction[] | ((feePayer: PublicKey) => TransactionInstruction[]);
type ReviewPurpose = "seat-death" | "fallback-death";

export interface ChainGuardianDeps {
  send(ixs: Ixs): Promise<TxResult>;
  review(file: File, purpose: ReviewPurpose, estate: Base58, context: string, index: number): Promise<{ report: AgentReport }>;
  getMeta(estate: Base58): Promise<EstateMeta | null>;
  saveMeta(meta: EstateMeta): Promise<void>;
  requireOwnerOf(estate: Base58): PublicKey;
  /** chain.ts getEstate (its snapshot carries `guardians`). */
  getEstate(estate: Base58): Promise<{ guardians?: GuardiansSnapshot }>;
}

/** Off-chain extras for the guardians view: names from the estate meta and this device, reasons and kinds from this device. */
export function guardianExtras(meta: EstateMeta | null, reports: Record<string, AgentReport>): GuardianExtras {
  const l = local();
  // The seeded devnet demo estate's fallback kinds (children, then a charity); this device's choices win.
  const demoKinds = meta?.estate === DEVNET_DEMO_ESTATE && chainConfig.cluster !== "mainnet-beta" ? DEVNET_DEMO_FALLBACK_KINDS : {};
  return { names: { ...l.names, ...(meta?.buyerNames ?? {}) }, reasons: l.reasons, fallbackKinds: { ...demoKinds, ...l.fallbackKinds }, reports };
}

/** The guardians view of an estate from its already-loaded pieces (used by chain.ts getEstate). */
export async function loadGuardians(estate: Base58, base: { estate: Estate; claims: Claim[]; events: ChainEvent[] }, extras: GuardianExtras): Promise<GuardiansSnapshot> {
  return assembleGuardians(await fetchGuardiansRaw(estate), { ...base, extras });
}

const pk = (a: string) => new PublicKey(a);
const DEFAULT_KEY = PublicKey.default.toBase58();
const toB58 = (v: unknown) => (typeof v === "string" ? v : (v as { toBase58(): string }).toBase58());
const keyList = (v: unknown): string[] => (Array.isArray(v) ? v.map(toB58) : []);
const DEMO_WAIT = Number(process.env.NEXT_PUBLIC_DEMO_WAITING_SECS ?? "");
/** Demo deployments (NEXT_PUBLIC_DEMO_WAITING_SECS set) get the short demo timings; real estates 2 days / 7 days / 90 days. */
export const guardTimings = () => Number.isFinite(DEMO_WAIT) && DEMO_WAIT >= 0
  ? { objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120 }
  : { objectionWindowSecs: 2 * 86_400, successionWaitSecs: 7 * 86_400, fallbackWaitSecs: 90 * 86_400 };

/* ---------- device-local extras ---------- */

const LOCAL_KEY = "heirloom.guardians.extras.v1";
type Local = { reasons: Record<string, string>; fallbackKinds: Record<Base58, FallbackRecipient["kind"]>; names: Record<Base58, string> };
function local(): Local {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(LOCAL_KEY) : null;
    if (raw) return { reasons: {}, fallbackKinds: {}, names: {}, ...(JSON.parse(raw) as Partial<Local>) };
  } catch { /* storage blocked */ }
  return { reasons: {}, fallbackKinds: {}, names: {} };
}
function saveLocal(update: (l: Local) => void) {
  const l = local();
  update(l);
  try { if (typeof window !== "undefined") window.localStorage.setItem(LOCAL_KEY, JSON.stringify(l)); } catch { /* ignore */ }
}

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const TARGET_KINDS = ["Claim", "Unlock", "Sale", "Hardship", "Succession", "Fallback"] as const;

export function createChainGuardians(d: ChainGuardianDeps): GuardiansService {
  const me = () => pk(getActiveSigner().address);

  const extras = async (estate: Base58, reports: Record<string, AgentReport>) => guardianExtras(await d.getMeta(estate), reports);
  const snapshot = async (estate: Base58): Promise<GuardiansSnapshot> => (await d.getEstate(estate)).guardians ?? disabledGuardians();

  /** Names entered by the owner: kept in the estate meta (and on this device, in case the meta is unavailable). */
  async function rememberNames(estate: Base58, people: { wallet: Base58; name: string }[]) {
    const named = people.filter((p) => p.name);
    if (!named.length) return;
    saveLocal((l) => { for (const p of named) l.names[p.wallet] = p.name; });
    const meta = await d.getMeta(estate);
    if (meta) await d.saveMeta({ ...meta, buyerNames: { ...meta.buyerNames, ...Object.fromEntries(named.map((p) => [p.wallet, p.name.slice(0, 64)])) } }).catch(() => undefined);
  }

  const guardRaw = (estate: Base58) => fetchAccountRaw("Guard", guardPda(chainCtx().programId, estate).toBase58());
  const seatRaw = (estate: Base58, i: number) => fetchAccountRaw("Seat", seatPda(chainCtx().programId, estate, i).toBase58());
  const nameOf = async (estate: Base58, wallet: Base58) => (await extras(estate, {})).names[wallet] ?? "the person named";
  /** Index of the first seat whose monitors include `wallet`, or null. */
  async function monitoredSeat(estate: Base58, wallet: PublicKey): Promise<number | null> {
    const raw = await fetchGuardiansRaw(estate);
    const s = raw.seats.find((x) => keyList(x.raw.monitors).includes(wallet.toBase58()));
    return s ? num(s.raw, "index") : null;
  }

  return {
    getGuardians: snapshot,

    async setupGuardians(estate, input) {
      const owner = d.requireOwnerOf(estate);
      const ctx = chainCtx();
      const estateKey = pk(estate);
      await rememberNames(estate, [...input.seats.flatMap((s) => [...s.backups, ...s.monitors]), ...input.fallback]);
      saveLocal((l) => { for (const r of input.fallback) l.fallbackKinds[r.wallet] = r.kind; });
      const txs: TxResult[] = [];
      if (!(await guardRaw(estate))) txs.push(await d.send([ix.initGuard(ctx, owner, estateKey, guardTimings())]));
      const seatIxs: TransactionInstruction[] = [];
      for (const i of [0, 1, 2]) {
        // Every seat must exist (the fallback checks all three), so seats the owner did not list are created empty.
        const s = input.seats.find((x) => x.index === i);
        const backups = (s?.backups ?? []).map((b) => pk(b.wallet));
        const monitors = (s?.monitors ?? []).map((m) => pk(m.wallet));
        if (!(await seatRaw(estate, i))) seatIxs.push(ix.initSeat(ctx, owner, i, backups, monitors));
        else if (s) seatIxs.push(ix.setSeatBackups(ctx, owner, estateKey, i, backups), ix.setSeatMonitors(ctx, owner, i, monitors));
      }
      for (const group of chunk(seatIxs, 2)) txs.push(await d.send(group));
      if (input.fallback.length) txs.push(await d.send([ix.setFallback(ctx, owner, input.fallback.map((r) => pk(r.wallet)))]));
      return txs;
    },

    async setSeatBackups(estate, index, backups) {
      await rememberNames(estate, backups);
      return d.send([ix.setSeatBackups(chainCtx(), me(), pk(estate), index, backups.map((b) => pk(b.wallet)))]);
    },

    async setSeatMonitors(estate, index, monitors) {
      const owner = d.requireOwnerOf(estate);
      await rememberNames(estate, monitors);
      return d.send([ix.setSeatMonitors(chainCtx(), owner, index, monitors.map((m) => pk(m.wallet)))]);
    },

    async setFallback(estate, recipients) {
      const owner = d.requireOwnerOf(estate);
      await rememberNames(estate, recipients);
      saveLocal((l) => { for (const r of recipients) l.fallbackKinds[r.wallet] = r.kind; });
      return d.send([ix.setFallback(chainCtx(), owner, recipients.map((r) => pk(r.wallet)))]);
    },

    async reportSeatDeath(estate, index, certificate) {
      const seat = await seatRaw(estate, index);
      if (!seat) throw new Error("This trusted person's seat is not set up.");
      const holder = key(seat, "holder");
      const h = await sha256Hex(new Uint8Array(await certificate.arrayBuffer()));
      const tx = await d.send([ix.reportSeatDeath(chainCtx(), me(), pk(estate), index, h)]);
      const person = await nameOf(estate, holder);
      const r = await d.review(certificate, "seat-death", estate,
        `Trusted person whose death is reported: ${person} (seat ${index + 1}, wallet ${holder}). This is not the estate owner.`, index);
      return { tx, report: r.report };
    },
    async ownerReplaceSeat(estate, index, newHolder) {
      const owner = d.requireOwnerOf(estate);
      const wallet = newHolder.wallet.trim();
      let holder: PublicKey;
      try { holder = pk(wallet); } catch { throw new Error("InvalidAddress: that is not a Solana wallet address."); }
      // The name goes off-chain first: the snapshot shows it for this seat once generation > 0.
      await rememberNames(estate, [{ wallet, name: newHolder.name.trim() }]);
      return d.send([ix.ownerReplaceSeat(chainCtx(), owner, index, holder)]);
    },

    confirmSeatDeath: (estate, index) => d.send([ix.confirmSeatDeath(chainCtx(), me(), pk(estate), index)]),
    vetoSeatDeath: (estate, index) => d.send([ix.vetoSeatDeath(chainCtx(), me(), pk(estate), index)]),
    finalizeSuccession: (estate, index) => d.send([ix.finalizeSuccession(chainCtx(), pk(estate), index, me())]),

    async raiseObjection(estate, input) {
      const objector = me();
      const reason = input.reason.trim();
      if (!reason) throw new Error("Write a short reason.");
      const reasonHashHex = await sha256Hex(reason);
      saveLocal((l) => { l.reasons[reasonHashHex] = reason; });
      const seatSpecific = input.kind !== "Unlock" && input.kind !== "Fallback";
      const monitorSeat = seatSpecific ? input.seatIndex : await monitoredSeat(estate, objector);
      let hardshipAsset: PublicKey | undefined;
      if (input.kind === "Hardship") {
        const h = await fetchAccountRaw("Hardship", input.target);
        if (!h) throw new Error("That request was not found.");
        hardshipAsset = pk(key(h, "asset"));
      }
      return d.send([ix.raiseObjection(chainCtx(), {
        objector, estate: pk(estate), kind: input.kind, target: pk(input.target), seatIndex: seatSpecific ? input.seatIndex : null,
        reasonHashHex, monitorSeat, beneficiary: input.kind === "Fallback" && monitorSeat === null, hardshipAsset,
      })]);
    },

    async voteObjection(estate, objection, uphold) {
      const o = await fetchAccountRaw("Objection", objection);
      if (!o) throw new Error("That objection was not found.");
      const kind = enumOf(o, "kind", TARGET_KINDS);
      const target = key(o, "target");
      const voter = me();
      const voterSeat = kind === "Fallback" ? await monitoredSeat(estate, voter) : null;
      let hardshipAsset: PublicKey | undefined;
      if (kind === "Hardship") {
        const h = await fetchAccountRaw("Hardship", target);
        if (h) hardshipAsset = pk(key(h, "asset"));
      }
      return d.send([ix.voteObjection(chainCtx(), { voter, estate: pk(estate), kind, target: pk(target), uphold, voterSeat, hardshipAsset })]);
    },

    async reportFallbackDeath(estate, recipientIndex, certificate) {
      const g = await guardRaw(estate);
      if (!g) throw new Error("This estate has no fallback plan.");
      const wallet = keyList(g.fallback)[recipientIndex];
      if (!wallet || wallet === DEFAULT_KEY) throw new Error("That fallback recipient does not exist.");
      const h = await sha256Hex(new Uint8Array(await certificate.arrayBuffer()));
      const tx = await d.send([ix.reportFallbackDeath(chainCtx(), me(), pk(estate), recipientIndex, h)]);
      const person = await nameOf(estate, wallet);
      const r = await d.review(certificate, "fallback-death", estate,
        `Fallback recipient whose death is reported: ${person} (wallet ${wallet}). This is not the estate owner.`, recipientIndex);
      return { tx, report: r.report };
    },

    startFallback: (estate) => d.send([ix.startFallback(chainCtx(), pk(estate), me())]),
    lapseObjection: (estate) => d.send([ix.lapseObjection(chainCtx(), pk(estate), me())]),

    async executeFallback(estate) {
      const g = await guardRaw(estate);
      if (!g) throw new Error("This estate has no fallback plan.");
      const dead = num(g, "fallback_dead");
      const next = keyList(g.fallback).find((w, i) => w !== DEFAULT_KEY && (dead & (1 << i)) === 0);
      if (!next) throw new Error("Every fallback recipient has passed away.");
      return d.send([ix.executeFallback(chainCtx(), { payer: me(), estate: pk(estate), recipient: pk(next) })]);
    },

    async getAssetMedia(estate) {
      const [listed, raw] = await Promise.all([photosApi.list(estate).catch(() => []), fetchGuardiansRaw(estate)]);
      const out: AssetMediaInfo[] = await Promise.all(listed.map(async (m) => {
        const onChain = raw.media[m.asset];
        if (!onChain) return { ...m };
        const root = await mediaRootHex(m.photos, cleanSpec(m.spec));
        return { ...m, onChainMatch: decodeMedia(onChain).photosRoot === root };
      }));
      // Devnet without a photo server: the bundled demo photos for assets whose on-chain root is a demo root.
      const missing = Object.entries(raw.media).filter(([asset]) => !out.some((m) => m.asset === asset));
      if (missing.length && chainConfig.cluster !== "mainnet-beta") {
        const { bundledDemoMedia } = await import("./demo-media");
        out.push(...bundledDemoMedia(missing.map(([asset, r]) => ({ asset, ...decodeMedia(r) })), chainConfig.cluster));
      }
      return out;
    },

    async setAssetMedia(estate, asset, input) {
      if (input.photos.length > MAX_PHOTOS) throw new Error(`Add at most ${MAX_PHOTOS} photos.`);
      // The spec schema (zod) loads when photos or a spec sheet are saved, not with the service on every first visit.
      const { parseSpec } = await import("../assets/spec-schema");
      if (foreignSpecKeys(input.kind, parseSpec(input.spec)).length) throw new Error("Some details do not belong on this kind of asset.");
      const root = await mediaRootHex(input.photos, parseSpec(input.spec));
      return d.send([ix.setAssetMedia(chainCtx(), {
        authority: me(), estate: pk(estate), asset: pk(asset), kind: input.kind, photosRootHex: root, photoCount: input.photos.length,
      })]);
    },
  };
}
