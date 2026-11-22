/**
 * HeirloomService on Solana devnet. Writes: build instructions → unsigned base64 tx → the active Tether WDK
 * wallet signs and sends (wallet/signer.ts, kept in sync by <WalletProvider>) → confirm. Reads: RPC + decoders.
 * Agent actions (reviews, listing, accepting offers, valuation, chat) go through our API routes, where the
 * agent's own WDK wallet signs only review_* / list_asset / accept_offer.
 */
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import type { HeirloomService, EstateSnapshot, TxResult } from "./types";
import type { Locale } from "../i18n/locales";
import type {
  AgentReport, Base58, CarValuation, FxRate, OfferRanking, PaymentReceipt, PaymentReview, SavedRecipient, WillChatMessage, WillDraft,
} from "../types";
import { chainCtx } from "../chain/client";
import { chainConfig } from "../chain/config";
import * as ix from "../chain/instructions";
import { ata, claimPda, estatePda, offerPda, hardshipPda } from "../chain/pda";
import { demoEstateFirst } from "../chain/demo-estate";
import { base64ToBytes, bytesToBase64, ChainTxError, getConnection } from "../chain/tx";
import { activityFrom, fetchAccountRaw, fetchEstateRaw, fetchEvents, fetchHistory, findEstateOf, invalidateProgramAccounts, scanAccounts } from "../chain/reads";
import { assembleSnapshot } from "../chain/snapshot";
import { hex, key, num, type Raw } from "../chain/decoders";
import { getActiveSigner, peekActiveSigner } from "../wallet/signer";
import {
  defaultReceiptStore, feeForReview, newPaymentId, openReceipts, recheck, resumeOnReconnect, runPayment, signSponsoredOrSelf, SponsorError, waitForFinal,
  type ChainOps, type SponsorClient, type SponsorStatus, type StoredPayment,
} from "../wallet/payments";
import { readOnly } from "../wallet/wdk";
import { loadWallets } from "../wallet/store";
import { explorerTx, fromBase, toBase } from "../format";
import { hashJson, sha256Hex } from "../agent/hash";
import type { EstateMeta } from "../db";
import { signedMetaRequest } from "../estate-meta/signed";
import { legacyApi, type LegacySigner } from "../legacy/client";
import { createChainGuardians, guardianExtras, loadGuardians } from "./chain-guardians";
import { createChainDisputes, loadDisputes } from "./chain-disputes";
import { createChainAsk } from "./chain-ask";
import { estateRecipients, mergeRecipients } from "./recipients";
import type { TreeService } from "../tree/types";
import type { LettersService } from "../letters/types";
import { disabledGuardians, SEAT_MONITOR_OFFSETS } from "../chain/guardians";
import { SystemProgram } from "@solana/web3.js";
import type { ActivityItem } from "../types";
import type { PaidBill } from "../bills/types";
import { billActivityText } from "../bills/book";
import type { InvoiceRead } from "../bills/invoice";
import {
  AuthorityType, MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction as createAtaIx,
  createInitializeMint2Instruction, createMintToInstruction, createSetAuthorityInstruction,
} from "@solana/spl-token";

// ---------- legacy voice: requests signed by the acting WDK wallet; the server checks the on-chain role ----------
function legacySigner(estate: Base58): LegacySigner {
  const s = getActiveSigner();
  return { estate, wallet: s.address, sign: (m) => s.signMessage(m), canSignQuietly: s.canSignQuietly ? () => s.canSignQuietly!() : undefined };
}

// ---------- small helpers ----------
const pk = (a: string) => new PublicKey(a);

// ---------- pay-once pipeline (wallet/payments.ts) ----------
const receipts = defaultReceiptStore();

// ---------- pay a bill once (lib/bills): the owner's own wallet, never the vault ----------
// The store validates with zod, so it (and the schemas) load the first time bills are used, not on every first visit.
const billSchemas = () => import("../bills/payees");
let billStore: ReturnType<Awaited<ReturnType<typeof billSchemas>>["billPayeeStore"]> | null = null;
const billBook = async () => (billStore ??= (await billSchemas()).billPayeeStore());

/** Bills this device paid from `wallet` (kept with the receipts), newest first. */
function billsFrom(wallet: Base58): PaidBill[] {
  return receipts.list()
    .filter((r) => r.kind === "bill" && r.bill && r.to && r.from === wallet)
    .map((r) => ({ id: r.id, to: r.to!, bill: r.bill!, amount: BigInt(r.amount ?? "0"), status: r.status, signature: r.signature, explorerUrl: r.explorerUrl, ts: Math.floor(r.updatedAt / 1000) }))
    .sort((a, b) => b.ts - a.ts);
}

/**
 * The owner's confirmed bills as activity lines, on the owner's own device only (the bills are not estate events,
 * so nobody else sees them; the public record drops them too, lib/audit.ts).
 */
function billActivity(estate: Base58, ownerName: string): ActivityItem[] {
  const me = peekActiveSigner()?.address;
  if (!me || estatePda(chainCtx().programId, me).toBase58() !== estate) return [];
  const usd = (b: bigint) => `${fromBase(b).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} USD₮`;
  return billsFrom(me).filter((b) => b.status === "confirmed")
    .map((b) => ({ ts: b.ts, kind: "BillPaid", text: billActivityText(ownerName.split(" ")[0] || "The owner", b.bill, usd(b.amount)), amount: b.amount, txSignature: b.signature }));
}

export function chainOps(): ChainOps {
  const conn = getConnection();
  return {
    status: async (sig) => (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0],
    blockHeight: () => conn.getBlockHeight("confirmed"),
    broadcast: async (wire) => { await conn.sendRawTransaction(base64ToBytes(wire), { maxRetries: 3 }); },
  };
}

// ---------- fee sponsorship: the server's agent WDK wallet pays network fees (/api/sponsor) ----------
let sponsorCache: { at: number; value: SponsorStatus | null } | null = null;

const sponsorClient: SponsorClient = {
  async status() {
    if (sponsorCache && Date.now() - sponsorCache.at < 60_000) return sponsorCache.value;
    const value = await api<SponsorStatus>("/api/sponsor").catch(() => null);
    sponsorCache = { at: Date.now(), value };
    return value;
  },
  async cosign(tx) {
    const res = await fetch("/api/sponsor", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx, submit: false }) });
    const data = (await res.json().catch(() => ({}))) as { signature?: string; wireBase64?: string; error?: string; code?: string };
    if (!res.ok || !data.signature || !data.wireBase64) {
      if (res.status === 503) sponsorCache = { at: Date.now(), value: null }; // stop trying for a minute
      throw new SponsorError(data.code ?? `http_${res.status}`, data.error ?? `Fee sponsor refused (${res.status}).`);
    }
    return { signature: data.signature, wireBase64: data.wireBase64 };
  },
};

type Ixs = TransactionInstruction[] | ((feePayer: PublicKey) => TransactionInstruction[]);

/**
 * Builds the tx (fee payer = Heirloom's sponsor when available, else the user), WDK signs it (sign-only; partial
 * when sponsored, then the server co-signs), the signature is persisted, then broadcast; returns the receipt.
 */
async function pay(id: string, ixs: Ixs, meta: Pick<StoredPayment, "kind" | "to" | "toLabel" | "amount" | "from" | "bill">, selfPay = false) {
  const signer = getActiveSigner();
  return runPayment(receipts, chainOps(), id, () => signSponsoredOrSelf({
    user: signer.address,
    async build(feePayer) {
      const conn = getConnection();
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const list = typeof ixs === "function" ? ixs(pk(feePayer)) : ixs;
      const tx = new Transaction({ feePayer: pk(feePayer), blockhash, lastValidBlockHeight }).add(...list);
      return { base64: bytesToBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), lastValidBlockHeight };
    },
    signPartial: signer.signPartial ? (b64) => signer.signPartial!(b64) : undefined,
    signOnly: (b64) => signer.signOnly(b64),
    // A self-paid tx (a title mint: the sponsor never pays for mints) doesn't ask the sponsor at all.
    sponsor: selfPay ? undefined : sponsorClient,
    onFallback: (reason) => console.warn(`Fee sponsor unavailable, paying the fee from the wallet: ${reason}`),
  }), meta);
}

/**
 * Every user-initiated program tx goes through the same pay-once pipeline and waits for confirmation. `ixs` may depend
 * on the fee payer (e.g. approve_claim lets the sponsor pay the approval stamp's rent when it is the fee payer).
 */
async function send(ixs: Ixs, meta: Pick<StoredPayment, "kind" | "to" | "toLabel" | "amount"> = { kind: "program" }, opts: { selfPay?: boolean } = {}): Promise<TxResult> {
  const id = newPaymentId();
  const first = await pay(id, ixs, meta, opts.selfPay);
  const r = first.status === "failed" ? first : await waitForFinal(receipts, chainOps(), id, 60_000, 800);
  if (!r || r.status === "failed") throw new ChainTxError(r?.signature ?? "", r?.error ?? "Transaction failed.");
  if (!r.signature) throw new Error("Transaction was not signed.");
  forget("activity:"); forget("estates:"); forget("history:"); forget("tree:"); invalidateProgramAccounts();
  return { signature: r.signature, explorerUrl: explorerTx(r.signature) };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: "no-store", ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * Saves an estate's names (and, once, the signed will draft), signed by the owner's wallet (lib/estate-meta). The
 * wallet is usually unlocked right after the txs this follows, so the signature is quiet; a locked wallet asks for
 * the PIN now.
 */
async function saveMeta(meta: EstateMeta, draft?: WillDraft): Promise<void> {
  const payload = {
    ownerName: meta.ownerName, verifierNames: meta.verifierNames, assetTitles: meta.assetTitles, buyerNames: meta.buyerNames,
    ...(draft ? { draft } : {}),
  };
  await post("/api/estate-meta", await signedMetaRequest(getActiveSigner(), "save", meta.estate, payload));
  forget(`meta:${meta.estate}`);
}

const fileHash = async (f: File) => sha256Hex(new Uint8Array(await f.arrayBuffer()));

/** OfferRanking amounts come back from JSON as strings. */
function reviveRanking(r: { bestOffer: Base58 | null; eligible: { offer: Base58; amount: string; reason: string }[]; ineligible: { offer: Base58; amount: string; reason: string }[] }): OfferRanking {
  const f = (x: { offer: Base58; amount: string; reason: string }) => ({ ...x, amount: BigInt(x.amount) });
  return { bestOffer: r.bestOffer, eligible: r.eligible.map(f), ineligible: r.ineligible.map(f) };
}

async function review(file: File, purpose: "death" | "claim" | "hardship" | "seat-death" | "fallback-death", estate: Base58, context: string, subject?: Base58, preview = false, index?: number) {
  const form = new FormData();
  form.set("file", file);
  form.set("purpose", purpose);
  form.set("estate", estate);
  form.set("context", context);
  if (subject) form.set("subject", subject);
  if (index !== undefined) form.set("index", String(index));
  if (preview) form.set("preview", "1");
  return api<{ report: AgentReport; tx: TxResult | null; onChain: string }>("/api/review", { method: "POST", body: form });
}

function requireOwnerOf(estate: Base58): PublicKey {
  const me = getActiveSigner().address;
  if (estatePda(chainCtx().programId, me).toBase58() !== estate) throw new Error("Switch to the estate owner's wallet to do this.");
  return pk(me);
}

async function mustFetch(type: string, address: Base58): Promise<Raw> {
  const raw = await fetchAccountRaw(type, address);
  if (!raw) throw new Error(`${type} ${address.slice(0, 6)}… was not found on-chain.`);
  return raw;
}

/**
 * Short-lived memo for reads that rarely change. The public devnet RPC rate-limits hard (HTTP 429), and the
 * dashboard refreshes in the background, so repeating every program-account scan on each refresh would starve
 * the reads that matter. Failed lookups are not cached.
 */
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}
/** Call after a write so the next read sees it. */
const forget = (prefix: string) => { for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k); };

async function getMeta(estate: Base58): Promise<EstateMeta | null> {
  return cached(`meta:${estate}`, 60_000, () => api<EstateMeta | null>(`/api/estate-meta?estate=${estate}`)).catch(() => null);
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Estates this wallet owns, inherits from, verifies or monitors (owner lookup is a PDA read; the rest are program scans). */
async function listEstatesUncached(wallet: Base58) {
  const out: { estate: Base58; role: string; ownerName: string }[] = [];
  const me = pk(wallet);
  const own = await findEstateOf(wallet);
  if (own) out.push({ estate: own, role: "owner", ownerName: (await getMeta(own))?.ownerName ?? "You" });
  // Beneficiary PDAs: [disc][estate 32][wallet 32]
  const bens = await scanAccounts("Beneficiary", [{ offset: 40, key: me }]).catch(() => []);
  // Estate: [disc][owner][agent][usdt_mint][verifiers 3×32] → verifier i at 104 + 32i
  const verifierHits = await Promise.all([0, 1, 2].map((i) => scanAccounts("Estate", [{ offset: 104 + 32 * i, key: me }]).catch(() => [])));
  for (const b of bens) {
    const estate = new PublicKey(b.data.subarray(8, 40)).toBase58();
    out.push({ estate, role: "beneficiary", ownerName: (await getMeta(estate))?.ownerName ?? "Family estate" });
  }
  for (const v of verifierHits.flat()) {
    const estate = v.pubkey.toBase58();
    out.push({ estate, role: "verifier", ownerName: (await getMeta(estate))?.ownerName ?? "Family estate" });
  }
  // Monitors (guardians): Seat = [disc][estate 32][index 1][holder 32][backups 2×32][monitors 2×32] → monitor j at 137 + 32j.
  const monitorHits = await Promise.all(SEAT_MONITOR_OFFSETS.map((offset) => scanAccounts("Seat", [{ offset, key: me }]).catch(() => [])));
  for (const s of monitorHits.flat()) {
    const estate = new PublicKey(s.data.subarray(8, 40)).toBase58();
    if (out.some((o) => o.estate === estate)) continue;
    out.push({ estate, role: "monitor", ownerName: (await getMeta(estate))?.ownerName ?? "Family estate" });
  }
  return demoEstateFirst(out);
}

// ---------- the service ----------
let resumed = false;

/**
 * A fresh SPL title mint for a new asset (0 decimals, supply 1 in the owner's account, mint authority removed), at an
 * address derived from the owner + a random seed so only the owner signs. The asset PDA is then seeded by this mint.
 */
async function newTitleMint(owner: PublicKey): Promise<{ mint: PublicKey; ixs: TransactionInstruction[] }> {
  const seed = `heirloom-asset-${crypto.getRandomValues(new Uint32Array(2)).join("").slice(0, 16)}`;
  const mint = await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID);
  const lamports = await getConnection().getMinimumBalanceForRentExemption(MINT_SIZE);
  const ownerAta = ata(mint, owner);
  return {
    mint,
    ixs: [
      SystemProgram.createAccountWithSeed({ fromPubkey: owner, basePubkey: owner, seed, newAccountPubkey: mint, lamports, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint, 0, owner, null),
      createAtaIx(owner, ownerAta, owner, mint),
      createMintToInstruction(mint, ownerAta, owner, 1),
      createSetAuthorityInstruction(mint, owner, AuthorityType.MintTokens, null),
    ],
  };
}

export function createChainService(): HeirloomService {
  // Once per page: re-check payments left pending by an earlier visit, now and whenever the browser reconnects.
  if (!resumed && typeof window !== "undefined") { resumed = true; resumeOnReconnect(receipts, chainOps()); }
  // "Ask for money": a living claim plus its off-chain note (chain-ask.ts).
  const asks = createChainAsk({
    send: (ixs) => send(ixs),
    review: (file, estate, context, claim) => review(file, "claim", estate, context, claim),
    fetchRaw: (type, address) => fetchAccountRaw(type, address),
    requireOwnerOf,
  });
  // Trust Tree: the estate's full history, child plans and the family links (chain-tree.ts), loaded on first use so
  // the tree's code stays out of every other page.
  let treeService: Promise<TreeService> | null = null;
  const tree = () => (treeService ??= import("./chain-tree").then((m) => m.createChainTree({
    getEstate: (estate) => service.getEstate(estate),
    history: (estate) => cached(`history:${estate}`, 30_000, () => fetchHistory(estate)),
    findEstateOf: (wallet) => cached(`estateOf:${wallet}`, 60_000, () => findEstateOf(wallet)),
    assetKinds: async (estate) => Object.fromEntries((await service.getAssetMedia(estate)).map((m) => [m.asset, m.kind])),
    requireOwnerOf,
    signer: () => getActiveSigner(),
    deviceWallets: () => loadWallets().map((w) => ({ address: w.address, label: w.label })),
  })));
  // Letters for later: signed calls to /api/letters plus the owner's device copy (chain-letters.ts), loaded on first use.
  let lettersService: Promise<LettersService> | null = null;
  const letters = () => (lettersService ??= import("./chain-letters").then((m) => m.createChainLetters({
    getEstate: (estate) => service.getEstate(estate),
    signer: () => getActiveSigner(),
    usdtZar: async () => (await service.getFx()).usdtZar,
  })));
  const service: HeirloomService = {
    mode: "chain",
    listLetters: async (estate, opts) => (await letters()).listLetters(estate, opts),
    saveLetter: async (estate, input, version) => (await letters()).saveLetter(estate, input, version),
    deleteLetter: async (estate, id, version) => (await letters()).deleteLetter(estate, id, version),
    reviewLetter: async (estate, draft, locale) => (await letters()).reviewLetter(estate, draft, locale),
    suggestLetter: async (estate, input, locale) => (await letters()).suggestLetter(estate, input, locale),
    letterCounts: (estate) => cached(`letterCounts:${estate}`, 20_000, async () => (await letters()).letterCounts(estate)),
    getTree: (estate) => cached(`tree:${estate}`, 20_000, async () => {
      const t = await (await tree()).getTree(estate);
      // Older history still loading in the background: let the next read pick it up soon.
      if (t.partial) setTimeout(() => { forget(`tree:${estate}`); forget(`history:${estate}`); }, 5_000);
      return t;
    }),
    setRelationship: async (estate, input) => (await tree()).setRelationship(estate, input).finally(() => forget(`tree:${estate}`)),
    removeRelationship: async (estate, id) => (await tree()).removeRelationship(estate, id).finally(() => forget(`tree:${estate}`)),
    setHidden: async (estate, hidden) => (await tree()).setHidden(estate, hidden).finally(() => forget(`tree:${estate}`)),
    setPhoto: async (estate, person, src) => (await tree()).setPhoto(estate, person, src).finally(() => forget(`tree:${estate}`)),
    removePhoto: async (estate, person) => (await tree()).removePhoto(estate, person).finally(() => forget(`tree:${estate}`)),
    askForMoney: (estate, input) => asks.askForMoney(estate, input).finally(() => forget(`asks:${estate}`)),
    declineAsk: (estate, claim) => asks.declineAsk(estate, claim).finally(() => forget(`asks:${estate}`)),
    ...createChainGuardians({
      send: (ixs) => send(ixs),
      review: (file, purpose, estate, context, index) => review(file, purpose, estate, context, undefined, false, index),
      getMeta,
      saveMeta: (meta) => saveMeta(meta),
      requireOwnerOf,
      getEstate: (estate) => service.getEstate(estate),
    }),
    ...createChainDisputes({ send: (ixs) => send(ixs), requireOwnerOf }),

    async getEstate(estate): Promise<EstateSnapshot> {
      const meta = await getMeta(estate);
      // Names are off-chain. Without Supabase the server keeps them in memory only, so after a restart fall back to
      // the owner's wallet label when that wallet is on this device.
      const localOwner = meta ? undefined : loadWallets().find((w) => estatePda(chainCtx().programId, w.address).toBase58() === estate)?.label;
      const [raw, events] = await Promise.all([
        fetchEstateRaw(estate, meta ?? (localOwner ? { ownerName: localOwner } : {})),
        cached(`activity:${estate}`, 20_000, () => fetchEvents(estate)).catch(() => []),
      ]);
      const activity = activityFrom(events);
      // The death review's report hash lives in the latest DeathReviewed event (the Estate account keeps only the cert hash).
      const deathHash = raw.estate.death.certHash ? activity.find((a) => a.kind === "DeathReviewed")?.reportHash : undefined;
      const hashes = [...new Set([...Object.values(raw.reportHashes), ...(deathHash ? [deathHash] : [])])];
      const reports = hashes.length
        ? await api<Record<string, AgentReport>>(`/api/reports?hashes=${hashes.join(",")}`).catch(() => ({} as Record<string, AgentReport>))
        : {};
      const snap = assembleSnapshot(raw, activity, reports);
      const deathReport = deathHash ? reports[deathHash] : undefined;
      const out = deathReport ? { ...snap, estate: { ...snap.estate, death: { ...snap.estate.death, agentReport: deathReport } } } : snap;
      // Guardians: seat death reviews carry report hashes too (SeatDeathReviewed events).
      const seatHashes = events.filter((e) => e.name.toLowerCase() === "seatdeathreviewed").map((e) => { try { return hex(e.data, "report_hash"); } catch { return ""; } })
        .filter((h) => h && !(h in reports));
      const seatReports = seatHashes.length
        ? await api<Record<string, AgentReport>>(`/api/reports?hashes=${[...new Set(seatHashes)].join(",")}`).catch(() => ({} as Record<string, AgentReport>))
        : {};
      const extras = guardianExtras(meta, { ...reports, ...seatReports });
      const guardians = await loadGuardians(estate, { estate: out.estate, claims: out.claims, events }, extras).catch(() => disabledGuardians());
      // A successor's display name (the estate meta still holds the original three names).
      const verifierNames = out.estate.verifierNames.map((n, i) => {
        const seat = guardians.seats.find((x) => x.index === i);
        return seat?.holder && seat.generation > 0 ? (extras.names[seat.holder] ?? n) : n;
      }) as [string, string, string];
      // Disputes (U9) and each rule's yearly cap: new accounts, read from the same program scan.
      const [extra, askNotes] = await Promise.all([
        loadDisputes(estate, { estate: out.estate, rules: out.rules }, extras.names).catch(() => ({ disputes: [], rules: out.rules })),
        cached(`asks:${estate}`, 15_000, () => asks.loadAsks(estate)).catch(() => ({})),
      ]);
      // Names the meta and this device know, for the activity feed (lib/people.ts) and the sale line's buyer.
      const names = extras.names;
      const withBuyers = out.activity.map((a) => (a.sale && !a.sale.buyerName && names[a.sale.buyer] ? { ...a, sale: { ...a.sale, buyerName: names[a.sale.buyer] } } : a));
      const bills = billActivity(estate, out.estate.ownerName);
      const withBills = bills.length ? [...withBuyers, ...bills].sort((a, b) => b.ts - a.ts) : withBuyers;
      return { ...out, activity: withBills, rules: extra.rules, disputes: extra.disputes, estate: { ...out.estate, verifierNames }, guardians, names, asks: askNotes };
    },

    listEstatesFor(wallet) {
      return cached(`estates:${wallet}`, 60_000, () => listEstatesUncached(wallet));
    },
    getFx: () => api<FxRate>("/api/fx"),

    willChat: (history: WillChatMessage[], locale?: Locale) => post<{ reply: string; draft: WillDraft | null }>("/api/will-chat", { history, locale }),

    async reviewDocument({ file, purpose, context }) {
      const signer = getActiveSigner();
      const estate = estatePda(chainCtx().programId, signer.address).toBase58();
      return (await review(file, purpose, estate, context, undefined, true)).report;
    },

    valueCar: (input) => post<CarValuation>("/api/valuation", input),

    async rankOffers(asset) {
      const raw = await mustFetch("Asset", asset);
      const r = await post<Parameters<typeof reviveRanking>[0]>("/api/rank-offers", { estate: key(raw, "estate"), asset });
      return reviveRanking(r);
    },

    // ----- Owner -----
    async createEstateFromWill(input) {
      // The will schema (zod) loads when a plan is signed, not with the service on every first visit.
      const { intervalSecs, willDraftSchema } = await import("../agent/schemas");
      const draft = willDraftSchema.parse(input); // the exact shape the server re-hashes
      const ctx = chainCtx();
      const owner = pk(getActiveSigner().address);
      const missing = [...draft.beneficiaries.filter((b) => !b.wallet).map((b) => b.label), ...draft.verifiers.filter((v) => !v.wallet).map((v) => v.name)];
      if (missing.length) throw new Error(`Add wallet addresses for: ${missing.join(", ")}.`);
      if (draft.verifiers.length !== 3) throw new Error("Exactly three verifiers are needed.");
      const { agentAddress } = await api<{ agentAddress: string | null }>("/api/agent");
      if (!agentAddress) throw new Error("The AI agent's wallet is not configured on the server.");

      const estate = estatePda(ctx.programId, owner);
      const willHash = await hashJson(draft);
      const { waitingSecsFor } = await import("../will-summary");
      const waiting = waitingSecsFor(draft.waitingPeriodDays, "chain");
      const txs: TxResult[] = [];

      const exists = await fetchAccountRaw("Estate", estate.toBase58());
      const setup: TransactionInstruction[] = [];
      if (!exists) {
        setup.push(ix.createEstate(ctx, {
          owner, agent: pk(agentAddress), verifiers: draft.verifiers.map((v) => pk(v.wallet!)) as [PublicKey, PublicKey, PublicKey],
          deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: waiting,
        }));
      }
      setup.push(ix.setWill(ctx, owner, willHash, `heirloom:will:${willHash.slice(0, 16)}`));
      txs.push(await send(setup));

      const existingBens = new Set((exists ? (await fetchEstateRaw(estate.toBase58())).beneficiaries : []).map((b) => b.wallet));
      const benIxs = draft.beneficiaries.filter((b) => !existingBens.has(b.wallet!)).map((b) => ix.addBeneficiary(ctx, owner, pk(b.wallet!), b.label));
      for (const group of chunk(benIxs, 3)) txs.push(await send(group));

      let ruleId = exists ? num(exists, "rule_count") : 0;
      // Recurring rules pay a fixed payee, which must already be an approved payee (matched by name).
      const payees = exists ? (await fetchEstateRaw(estate.toBase58())).payees : [];
      const now = Math.floor(Date.now() / 1000);
      const ruleIxs = draft.rules.map((r) => {
        const ben = draft.beneficiaries.find((b) => b.label === r.beneficiaryLabel);
        if (!ben?.wallet) throw new Error(`Rule for unknown beneficiary "${r.beneficiaryLabel}".`);
        let recurring: Parameters<typeof ix.addRule>[2]["recurring"];
        if (r.recurring) {
          const payee = payees.find((p) => p.name.toLowerCase() === r.recurring!.payeeName.toLowerCase() && p.kind === r.allowedPayeeKind);
          if (payee) {
            const every = intervalSecs(r.recurring.every);
            recurring = { amount: toBase(r.recurring.amountUsdt), intervalSecs: every, firstDue: now + every, payeeWallet: pk(payee.wallet) };
          } else {
            // The payee's wallet is not known yet: the rule is created claim-based (same caps); add the payee and a
            // recurring rule later with addRule({ recurring }).
            console.warn(`Recurring payee "${r.recurring.payeeName}" is not an approved payee yet; rule created as claim-based.`);
          }
        }
        return ix.addRule(ctx, owner, {
          ruleId: ruleId++, beneficiaryWallet: pk(ben.wallet), category: r.category, allowedPayeeKind: r.allowedPayeeKind,
          maxPerClaim: toBase(r.maxPerClaimUsdt), lifetimeCap: toBase(r.lifetimeCapUsdt), validUntil: Math.floor(Date.parse(r.validUntil) / 1000),
          startsNow: r.startsNow, recurring,
        });
      });
      for (const group of chunk(ruleIxs, 2)) txs.push(await send(group));

      await saveMeta({
        estate: estate.toBase58(), ownerWallet: owner.toBase58(), ownerName: draft.ownerName,
        verifierNames: draft.verifiers.map((v) => v.name) as [string, string, string], assetTitles: {}, buyerNames: {},
      }, draft).catch(() => undefined); // names are cosmetic; the estate itself is already on-chain
      return { estate: estate.toBase58(), txs };
    },

    async deposit(estate, amountUsdt) { const o = requireOwnerOf(estate); return send([ix.deposit(chainCtx(), o, toBase(amountUsdt))], { kind: "vault-deposit", to: estate, toLabel: "Estate vault", amount: toBase(amountUsdt).toString() }); },
    async withdraw(estate, amountUsdt) { const o = requireOwnerOf(estate); return send([ix.withdraw(chainCtx(), o, toBase(amountUsdt))]); },
    async heartbeat(estate) { const o = requireOwnerOf(estate); return send([ix.heartbeat(chainCtx(), o)]); },
    async vetoDeath(estate) { const o = requireOwnerOf(estate); return send([ix.vetoDeath(chainCtx(), o)]); },

    async registerAsset(estate, input) {
      const o = requireOwnerOf(estate);
      // Any new asset without a title token gets a fresh one (its own tx: the sponsor does not pay for mints).
      let nftMint = input.nftMint;
      if (!nftMint) {
        const fresh = await newTitleMint(o);
        // The sponsor refuses mints (422), so the owner pays this one without asking it.
        await send(fresh.ixs, { kind: "program" }, { selfPay: true });
        nftMint = fresh.mint.toBase58();
      }
      const docHash = input.docFile ? await fileHash(input.docFile) : await sha256Hex(`heirloom:asset:${nftMint}:${input.title}`);
      const tx = await send([ix.registerAsset(chainCtx(), o, {
        nftMint: pk(nftMint), floorPrice: toBase(input.floorUsdt), hardshipFloor: toBase(input.hardshipFloorUsdt),
        askingPrice: toBase(input.askingUsdt), proceedsTo: pk(input.proceedsTo), docHashHex: docHash,
      })]);
      const meta = await getMeta(estate);
      if (meta) {
        await saveMeta({ ...meta, assetTitles: { ...meta.assetTitles, [nftMint]: input.title } }).catch(() => undefined);
      }
      return tx;
    },

    async addPayee(estate, input) {
      const o = requireOwnerOf(estate);
      return send([ix.addPayee(chainCtx(), o, pk(input.wallet), input.kind, input.name)]);
    },

    async addRule(estate, input) {
      const o = requireOwnerOf(estate);
      const raw = await mustFetch("Estate", estate);
      return send([ix.addRule(chainCtx(), o, {
        ruleId: num(raw, "rule_count"), beneficiaryWallet: pk(input.beneficiary), category: input.category, allowedPayeeKind: input.allowedPayeeKind,
        maxPerClaim: toBase(input.maxPerClaimUsdt), lifetimeCap: toBase(input.lifetimeCapUsdt), validUntil: input.validUntil,
        startsNow: input.startsNow,
        recurring: input.recurring && {
          amount: toBase(input.recurring.amountUsdt), intervalSecs: input.recurring.intervalSecs,
          firstDue: input.recurring.firstDue, payeeWallet: pk(input.recurring.payee),
        },
      })]);
    },

    async ownerApproveClaim(estate, claim) {
      const o = requireOwnerOf(estate);
      const raw = await mustFetch("Claim", claim);
      return send([ix.ownerApproveClaim(chainCtx(), o, pk(claim), pk(key(raw, "rule")))]);
    },

    async executeScheduled(estate, rule) {
      const raw = await mustFetch("Rule", rule);
      const fixed = key(raw, "fixed_payee");
      return send([ix.executeScheduled(chainCtx(), { estate: pk(estate), payer: pk(getActiveSigner().address), rule: pk(rule), payeeWallet: pk(fixed) })],
        { kind: "scheduled", to: fixed, toLabel: "Scheduled payee", amount: String(raw.recurring_amount ?? "0") });
    },

    // ----- Family -----
    async submitDeathClaim(estate, certificate) {
      const me = pk(getActiveSigner().address);
      const h = await fileHash(certificate);
      const tx = await send([ix.submitDeathClaim(chainCtx(), pk(estate), me, h)]);
      const meta = await getMeta(estate);
      const r = await review(certificate, "death", estate, `Estate owner's name: ${meta?.ownerName ?? "unknown"}.`);
      return { tx, report: r.report };
    },

    async submitClaim(estate, input) {
      const ctx = chainCtx();
      const me = pk(getActiveSigner().address);
      const rule = await mustFetch("Rule", input.rule);
      const ruleId = num(rule, "id");
      const claimId = num(rule, "claim_count");
      const h = await fileHash(input.evidence);
      const tx = await send([ix.submitClaim(ctx, {
        estate: pk(estate), signer: me, ruleId, claimId, payeeWallet: pk(input.payee), amount: toBase(input.amountUsdt), evidenceHashHex: h,
      })]);
      const claim = claimPda(ctx.programId, input.rule, claimId).toBase58();
      const r = await review(input.evidence, "claim", estate, `Claim for ${input.amountUsdt} USD₮ under rule #${ruleId}, payee wallet ${input.payee}.`, claim);
      return { tx, claim, report: r.report };
    },

    async submitHardship(estate, input) {
      const ctx = chainCtx();
      const me = pk(getActiveSigner().address);
      const h = await fileHash(input.evidence);
      const tx = await send([ix.submitHardship(ctx, pk(estate), pk(input.asset), me, h)]);
      const hardship = hardshipPda(ctx.programId, input.asset, me).toBase58();
      const r = await review(input.evidence, "hardship", estate, "Hardship request to sell the car below the floor price.", hardship);
      return { tx, report: r.report };
    },

    // ----- Verifiers -----
    async attestDeath(estate) { return send([ix.attestDeath(pk(estate), pk(getActiveSigner().address))]); },

    async approveClaim(estate, claim) {
      const raw = await mustFetch("Claim", claim);
      const verifier = pk(getActiveSigner().address);
      // The fee payer (Heirloom's sponsor when available) also pays the approval stamp's rent.
      return send((feePayer) => {
        const t = ix.approveClaim(pk(estate), verifier, pk(claim), pk(key(raw, "rule")));
        const at = t.keys.findIndex((k, i) => i > 0 && k.pubkey.equals(verifier) && k.isWritable);
        if (at > 0 && !feePayer.equals(verifier)) t.keys[at] = { ...t.keys[at], pubkey: feePayer };
        return [t];
      });
    },

    async approveHardship(estate, hardship) {
      const raw = await mustFetch("Hardship", hardship);
      return send([ix.approveHardship(pk(estate), pk(getActiveSigner().address), pk(key(raw, "asset")), pk(hardship))]);
    },

    // ----- Anyone -----
    async finalizeUnlock(estate) { return send([ix.finalizeUnlock(pk(estate), pk(getActiveSigner().address))]); },

    async executeClaim(estate, claim) {
      const raw = await mustFetch("Claim", claim);
      return send([ix.executeClaim(chainCtx(), {
        estate: pk(estate), payer: pk(getActiveSigner().address), rule: pk(key(raw, "rule")), claim: pk(claim), payeeWallet: pk(key(raw, "payee")),
      })], { kind: "claim-payout", to: key(raw, "payee"), toLabel: "Approved institution", amount: String(raw.amount ?? "0") });
    },

    // ----- P2P USD₮ (Tether track flow: review → approve → WDK sign → pending → confirmed) -----
    async reviewSend({ to, toLabel, amountUsdt, bill: billInput }): Promise<PaymentReview> {
      const from = getActiveSigner().address;
      const bill = billInput ? (await billSchemas()).billDetailsSchema.parse(billInput) : undefined;
      let toKey: PublicKey;
      try { toKey = pk(to); } catch { throw new Error("That is not a valid Solana address."); }
      if (to === from) throw new Error("You cannot send to your own wallet.");
      if (!(amountUsdt > 0)) throw new Error("Enter an amount above zero.");
      const amount = toBase(amountUsdt);
      const conn = getConnection();
      const mint = chainCtx().usdtMint;
      const warnings: string[] = [];

      // Token check: the configured USD₮ mint must exist on this cluster with 6 decimals.
      const mintInfo = await conn.getParsedAccountInfo(mint, "confirmed");
      const parsed = mintInfo.value?.data as { parsed?: { type?: string; info?: { decimals?: number } } } | undefined;
      const verified = parsed?.parsed?.type === "mint" && parsed.parsed.info?.decimals === 6;
      if (!verified) warnings.push("The USD₮ token could not be verified on this network. Do not send.");
      if (!PublicKey.isOnCurve(toKey.toBytes())) warnings.push("This address is a program account, not a person's wallet. Check it carefully.");

      // Balances + fee quote via Tether WDK (read-only account: no keys needed).
      const ro = await readOnly(from, chainConfig.rpcUrl);
      const [usdt, lamports, quote, recipientAta] = await Promise.all([
        ro.getTokenBalance(mint.toBase58()), ro.getBalance(),
        ro.quoteTransfer({ token: mint.toBase58(), recipient: to, amount }).catch(() => null),
        conn.getAccountInfo(ata(mint, toKey), "confirmed"),
      ]);
      const rent = recipientAta ? 0 : 2_039_280; // rent for a new token account
      const networkFee = Number(quote?.fee ?? 5000n);
      const sponsor = await sponsorClient.status().catch(() => null);
      // Sponsored: two signatures (sponsor + sender) instead of one.
      const { fee, userLamports } = feeForReview({ user: from, networkFeeLamports: sponsor?.available ? 10_000 : networkFee, rentLamports: rent, sponsor });
      if (!recipientAta) {
        warnings.push(fee.sponsored && sponsor?.paysRent
          ? "The recipient has no USD₮ account yet: it will be created, and Heirloom covers the cost."
          : "The recipient has no USD₮ account yet: it will be created (about 0.002 SOL, paid by you).");
      }
      if (!quote && !fee.sponsored) warnings.push("Fee estimate unavailable; using the standard network fee.");
      const sol = Number(lamports) / 1e9;
      const sufficient = usdt >= amount && Number(lamports) >= userLamports;
      if (usdt < amount) warnings.push("Not enough USD₮ in this wallet.");
      if (Number(lamports) < userLamports) warnings.push("Not enough SOL to pay the network fee.");

      const review: PaymentReview = {
        id: newPaymentId(), kind: bill ? "bill" : "p2p", from, to, toLabel: toLabel || bill?.payee || "", amount,
        token: { symbol: "USD₮", mint: mint.toBase58(), verified },
        network: { name: `Solana ${chainConfig.cluster}`, cluster: chainConfig.cluster === "mainnet-beta" ? "mainnet-beta" : chainConfig.cluster === "localnet" ? "localnet" : "devnet" },
        fee,
        balances: { usdt, sol, sufficient },
        warnings,
        ...(bill ? { bill } : {}),
      };
      receipts.put({ id: review.id, status: "awaiting-approval", kind: review.kind, from, to, toLabel: review.toLabel, amount: amount.toString(), updatedAt: Date.now(), ...(bill ? { bill } : {}) });
      return review;
    },

    async confirmSend(review) {
      if (!review.token.verified) throw new Error("The USD₮ token is not verified on this network; payment blocked.");
      if (review.token.mint !== chainCtx().usdtMint.toBase58()) throw new Error("Token mismatch: this is not the configured USD₮ mint.");
      if (review.from !== getActiveSigner().address) throw new Error("Switch back to the wallet that reviewed this payment.");
      const mint = chainCtx().usdtMint;
      const from = pk(review.from), to = pk(review.to);
      const needsAta = !(await getConnection().getAccountInfo(ata(mint, to), "confirmed"));
      const sponsorPaysRent = Boolean((await sponsorClient.status().catch(() => null))?.paysRent);
      // The rent payer for a new recipient account is the sponsor when it is the fee payer and covers rent.
      const ixs = (feePayer: PublicKey) => [
        ...(needsAta ? [createAssociatedTokenAccountIdempotentInstruction(!feePayer.equals(from) && sponsorPaysRent ? feePayer : from, ata(mint, to), to, mint)] : []),
        createTransferCheckedInstruction(ata(mint, from), mint, ata(mint, to), from, review.amount, 6),
      ];
      const bill = review.bill ? (await billSchemas()).billDetailsSchema.parse(review.bill) : undefined;
      return pay(review.id, ixs, { kind: bill ? "bill" : "p2p", from: review.from, to: review.to, toLabel: review.toLabel, amount: review.amount.toString(), ...(bill ? { bill } : {}) });
    },

    getReceipt: (id): Promise<PaymentReceipt | null> => recheck(receipts, chainOps(), id),

    async listPendingReceipts() {
      const out: PaymentReceipt[] = [];
      for (const r of openReceipts(receipts)) { const n = await recheck(receipts, chainOps(), r.id).catch(() => r); if (n) out.push(n); }
      return out;
    },

    async savedRecipients(estate?: Base58): Promise<SavedRecipient[]> {
      const me = getActiveSigner().address;
      // The estate on screen first (its family and trusted people by name), then this device's wallets, then people
      // paid before.
      const people = estate ? await service.getEstate(estate).then((s) => estateRecipients(s, me)).catch(() => []) : [];
      const devices = loadWallets().filter((w) => w.address !== me).map((w) => ({ label: w.label, address: w.address, relationship: w.role }));
      const paid = receipts.list().filter((r) => r.kind === "p2p" && r.to && r.toLabel && r.to !== me).map((r) => ({ label: r.toLabel!, address: r.to! }));
      return mergeRecipients(people, devices, paid);
    },

    // ----- Pay a bill once: same WDK transfer as a send, with the bill's details on the receipt -----
    async billPayees() { return (await billBook()).list(getActiveSigner().address); },
    async saveBillPayee(input) { return (await billBook()).save(getActiveSigner().address, input); },
    async readInvoice(file): Promise<InvoiceRead> {
      const form = new FormData();
      form.set("file", file);
      const { invoiceReadSchema } = await import("../bills/invoice");
      return invoiceReadSchema.parse(await api<unknown>("/api/invoice", { method: "POST", body: form }));
    },
    async paidBills() {
      const me = getActiveSigner().address;
      // Re-check open ones first (never re-sends), so a bill confirmed while away shows as paid.
      for (const b of billsFrom(me)) if (["signing", "submitted", "pending"].includes(b.status)) await recheck(receipts, chainOps(), b.id).catch(() => null);
      return billsFrom(me).filter((b) => b.status !== "awaiting-approval");
    },

    // ----- Car sale -----
    listAsset: (estate, asset, durationSecs) => post<TxResult>("/api/list-asset", { estate, asset, durationSecs }),

    async placeOffer(estate, asset, amountUsdt, buyerName) {
      const tx = await send([ix.placeOffer(chainCtx(), pk(estate), pk(asset), pk(getActiveSigner().address), toBase(amountUsdt))],
        { kind: "offer", to: asset, toLabel: "Offer escrow", amount: toBase(amountUsdt).toString() });
      // The buyer's own name beside the offer and on the sale (off-chain; never replaces a name the owner gave).
      const name = buyerName?.trim().slice(0, 64);
      if (name && getActiveSigner().canSignQuietly?.() !== false) {
        await post("/api/estate-meta", await signedMetaRequest(getActiveSigner(), "buyer-name", estate, { asset, name }))
          .then(() => forget(`meta:${estate}`)).catch(() => undefined);
      }
      return tx;
    },

    async withdrawOffer(estate, asset) {
      const me = getActiveSigner().address;
      if (!(await fetchAccountRaw("Offer", offerPda(chainCtx().programId, asset, me).toBase58()))) throw new Error("You have no open offer on this car.");
      return send([ix.withdrawOffer(chainCtx(), pk(estate), pk(asset), pk(me))]);
    },

    async acceptBestOffer(estate, asset) {
      const res = await fetch("/api/accept-offer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ estate, asset }) });
      const data = (await res.json()) as { tx: TxResult | null; ranking: Parameters<typeof reviveRanking>[0]; error?: string };
      if (!res.ok || !data.tx) throw new Error(data.error ?? `Could not accept an offer (${res.status}).`);
      return { tx: data.tx, ranking: reviveRanking(data.ranking) };
    },

    legacyStatus: (estate, opts) => legacyApi.status(legacySigner(estate), opts),
    createLegacyVoice: (estate, input) => legacyApi.createVoice(legacySigner(estate), input),
    deleteLegacyVoice: (estate) => legacyApi.deleteVoice(legacySigner(estate)),
    saveLegacyBook: (estate, book) => legacyApi.saveBook(legacySigner(estate), book),
    deleteLegacyBook: (estate) => legacyApi.deleteBook(legacySigner(estate)),
    setLegacyOptIn: (estate, on) => legacyApi.optIn(legacySigner(estate), on),
    legacySpeak: (estate, input) => legacyApi.speak(legacySigner(estate), input),
  };
  return service;
}
