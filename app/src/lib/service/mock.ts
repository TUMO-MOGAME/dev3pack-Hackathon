/**
 * In-memory demo implementation of HeirloomService.
 * It behaves like the Solana program in docs/program-spec.md: the same checks, the same error names,
 * so the UI can be designed, demoed and recorded without a network. State survives reloads (localStorage).
 *
 * Extras beyond the interface (see MockService) let the UI tell the mock who is acting and jump the
 * demo to a later stage. The UI only uses them when `mode === "mock"`.
 */
import { explorerTx, fromBase, toBase } from "../format";
import type {
  AgentReport, Asset, Base58, CarValuation, Claim, Hardship, OfferRanking, PaymentReceipt, PaymentReview, Role, SavedRecipient, WillChatMessage, WillDraft,
} from "../types";
import type { EstateSnapshot, HeirloomService, TxResult } from "./types";
import { DEMO_PERSONAS as WALLET_PERSONAS } from "../wallet/personas";
import { createMockLegacy } from "./mock-legacy";
import { fail } from "./mock-errors";
import { blankGuard, createMockGuardians, VACANT_KEY, type FallbackInput, type MockGuardState, type Named } from "./mock-guardians";
import { sha256Hex } from "../agent/hash";
import { cleanSpec, mediaRootHex, specInputSchema } from "../assets/spec";
import { DEMO_ASSETS } from "./demo-asset-photos";

export interface MockActor { address: Base58; role: Role; label: string }
/** "guardians": the estate unlocked, with a Guard set up before Thabo passed (seats, backups, Aunt Zodwa, fallback; 60/60/120 s). */
export type DemoStage = "fresh" | "funded" | "unlocked" | "listed" | "lowOffers" | "guardians";

export interface MockService extends HeirloomService {
  mode: "mock";
  setActor(actor: MockActor | null): void;
  resetDemo(stage: DemoStage): void;
  balanceOf(address: Base58): bigint | null;
  /** Demo shortcuts (mock only): play the "passing reported and confirmed" steps, end the wait, or bring schedules due. */
  simulatePassing(): void;
  skipWait(): void;
  makeDue(): void;
  /**
   * Guardians demo shortcuts (mock only). Each plays steps the real people would do, or moves the demo clock;
   * they never skip a check that the contract makes.
   */
  /** Thabo sets up the demo guardians (backups, Aunt Zodwa as monitor, fallback order). Estate must be active. */
  setupDemoGuardians(): void;
  /** Uncle Bongani (or whoever holds the seat) approves a claim, so his monitors see it in their inbox. */
  simulateSeatApproval(index?: number): void;
  /** "Simulate Uncle Bongani's passing": Aunt Zodwa reports it, the agent clears the certificate, another trusted person confirms. */
  simulateSeatPassing(index?: number): void;
  /** Move the demo clock past the objection window (approvals), the succession wait or the fallback wait. */
  endObjectionWindow(): void;
  endSuccessionWait(): void;
  endFallbackWait(): void;
  /** "All trusted people are gone": every holder and backup recorded as passed, and Thabo's passing reported and cleared. */
  simulateAllSeatsVacant(): void;
}

export function isMockService(s: HeirloomService | null | undefined): s is MockService {
  return !!s && s.mode === "mock" && typeof (s as MockService).setActor === "function";
}

/* ---------- demo cast ---------- */

type PersonaKey = "thabo" | "lerato" | "sipho" | "naledi" | "nomsa" | "david" | "busi" | "zanele" | "zodwa";

const CAST: { key: PersonaKey; name: string; relation: string }[] = [
  { key: "thabo", name: "Thabo Mokoena", relation: "Dad" },
  { key: "lerato", name: "Lerato Mokoena", relation: "Daughter, 20" },
  { key: "sipho", name: "Sipho Mokoena", relation: "Son, 18" },
  { key: "naledi", name: "Naledi Mokoena", relation: "Daughter, 15" },
  { key: "nomsa", name: "Adv. Thandi Ndlovu", relation: "Executor" },
  { key: "david", name: "Ms. Anita Pillay", relation: "Family attorney" },
  { key: "busi", name: "Uncle Bongani Mokoena", relation: "Thabo's brother" },
  { key: "zanele", name: "Pieter van Wyk", relation: "Car buyer" },
  { key: "zodwa", name: "Aunt Zodwa Mokoena", relation: "Thabo's sister, watches Bongani" },
];

/** Guardians demo cast that are not personas: Uncle Bongani's backups and the charity at the end of the fallback order. */
export const DEMO_GUARDIANS = {
  kagiso: { wallet: "8QDekGfekh5Bg85sbkoW5EQpxQmoqbL1SY3m3ieyW9BH", name: "Cousin Kagiso Mokoena" },
  priya: { wallet: "34biue8WinN94cpC41bcp6YkG5EUWicexxjd3zyjcnQ1", name: "Adv. Priya Naidoo" },
  charity: { wallet: "6gUaiCvYvtSfEY2y4ygyVSwTjnV4oNP5ENoCdweqPVsN", name: "Ithemba Children's Charity" },
} as const;

/** Same wallets, in the same order, as the wallet layer's mock personas (lib/wallet/personas.ts). */
export const DEMO_PERSONAS: { key: PersonaKey; label: string; role: Role; relation: string; address: Base58; usdt: number }[] =
  CAST.map((c, i) => ({ key: c.key, label: c.name, relation: c.relation, role: WALLET_PERSONAS[i].role, address: WALLET_PERSONAS[i].address, usdt: WALLET_PERSONAS[i].usdt }));

const AGENT = "AgNt1HeiRLooMwDKagentWaLLet7xQp5sZc3FdYg8uE6r";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const ESTATE = "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo";
const CAR_MINT = "CaRt1tLe2016ToYoTaCoRoLLa5sZc3FdYg8uE6rAoNFT1";
const BIKE_MINT = "BiKeT1tLe2025BiGBoYMuStAnG250sZc3FdYg8uE6rNFT";
/** Thabo's motorbike (the second demo asset): asking / minimum / hardship floor in USD₮ (Tumo, 15 Nov 2026). */
const BIKE_PRICES = { askingUsdt: 2000, floorUsdt: 1800, hardshipFloorUsdt: 1500 };
const RIVALS = [
  { address: "AyEsHaKhAn4xT8rLp3cZd6FgJy4bN7eQiBuYeR5551aa", name: "Ayesha Khan" },
  { address: "JoHaNbOtHa2xT5rLm8cZp3FgHy6bJ9eUaBuYeR662bcd", name: "Johan Botha" },
];
const PAYEES = [
  { wallet: "UCT1uNiVeRsItYoFcApEtOwN5sZc3FdYg8uE6rAoPaY1", kind: "University" as const, name: "University of Cape Town" },
  { wallet: "WiTs2uNiVeRsItYwItWaTeRsRaNd3FdYg8uE6rAoPaY2", kind: "University" as const, name: "University of the Witwatersrand" },
  { wallet: "MoRr3iSiSaAcSoNhIgHsChOoLsOwEtOg8uE6rAoPaY3", kind: "School" as const, name: "Morris Isaacson High School" },
  { wallet: "SoUt4hPoInTsTuDeNtReSiDeNcEsBrAaMg8uE6rAPaY4", kind: "Landlord" as const, name: "South Point Student Residences" },
  { wallet: "VaNs5cHaIkBoOkStOrEbRaAmFoNtEiNg8uE6rAoPaY55", kind: "Other" as const, name: "Van Schaik Bookstore" },
];

export const DEMO_FX = 17.85;
/** Demo clock: a 30 day waiting period lasts 60 seconds, and every schedule repeats every 60 seconds. */
export const DEMO_SECONDS_PER_DAY = 2;
export const DEMO_INTERVAL_SECS = 60;

/* ---------- state ---------- */

interface State {
  v: 5;
  created: boolean;
  bind: Record<string, Base58>;
  snap: EstateSnapshot;
  balances: Record<Base58, bigint>;
  names: Record<Base58, string>;
  /** P2P sends: receipt plus what is needed to settle it once "the network" confirms. */
  sends: Record<string, { receipt: PaymentReceipt; from: Base58; to: Base58; toLabel: string; amount: bigint; confirmAt: number }>;
  /** Guardians (added after v5 shipped; created on first use when a saved state has none). */
  guard?: MockGuardState;
}

const KEY = "heirloom.mock.v5";
const nowSecs = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const rand = (n: number, alphabet: string) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
const fakeSig = () => rand(88, B58);
const fakeAddr = () => rand(44, B58);
const fakeHash = () => rand(64, "0123456789abcdef");

function serialise(s: State): string {
  // blob: URLs (photos previewed in this tab) die with the page, so they are never saved.
  return JSON.stringify(s, (k, v) => (typeof v === "bigint" ? { $n: v.toString() } : k === "url" && typeof v === "string" && v.startsWith("blob:") ? "" : v));
}
function parse(raw: string): State {
  return JSON.parse(raw, (k, v) => (v && typeof v === "object" && typeof v.$n === "string" ? BigInt(v.$n) : k === "url" && typeof v === "string" && v.startsWith("blob:") ? "" : v));
}

function blank(): State {
  const bind: Record<string, Base58> = {};
  const balances: Record<Base58, bigint> = {};
  const names: Record<Base58, string> = { [AGENT]: "Heirloom agent" };
  for (const p of DEMO_PERSONAS) {
    bind[p.key] = p.address;
    names[p.address] = p.label;
    balances[p.address] = toBase(p.usdt);
  }
  RIVALS.forEach((r, i) => { names[r.address] = r.name; balances[r.address] = toBase(i === 0 ? 15000 : 13000); });
  PAYEES.forEach((p) => { names[p.wallet] = p.name; balances[p.wallet] = 0n; });
  Object.values(DEMO_GUARDIANS).forEach((p) => { names[p.wallet] = p.name; balances[p.wallet] = 0n; });
  return {
    v: 5,
    guard: blankGuard(),
    sends: {},
    created: false,
    bind,
    balances,
    names,
    snap: {
      estate: {
        address: ESTATE, owner: bind.thabo, ownerName: "Thabo Mokoena", agent: AGENT, usdtMint: USDT_MINT,
        verifiers: [bind.nomsa, bind.david, bind.busi],
        verifierNames: ["Adv. Thandi Ndlovu", "Ms. Anita Pillay", "Uncle Bongani Mokoena"],
        deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: 60,
        status: "Active", willHash: null, vaultBalance: 0n,
        death: { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null },
        lastHeartbeat: 0,
      },
      beneficiaries: [], payees: [], rules: [], claims: [], assets: [], offers: [], hardships: [], activity: [],
    },
  };
}


const usd = (b: bigint) => `${fromBase(b).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} USD₮`;

/* ---------- the service ---------- */

/** The car's minimum price from the owner's words: the latest USD₮ amount wins ("change it to 13,000 USDT"), else a large rand amount. */
export function floorFromText(text: string, fallback = 12500): number {
  const num = (x: string) => Number(x.replace(/[\s,]/g, ""));
  const usdt = [...text.matchAll(/(\d[\d\s,.]*)\s*(?:usd₮|usdt)/gi)].map((m) => num(m[1])).filter((n) => n > 0);
  if (usdt.length) return usdt[usdt.length - 1];
  const zar = [...text.matchAll(/R\s?(\d[\d\s,]*)/g)].map((m) => num(m[1])).filter((z) => z > 20000);
  return zar.length ? Math.round(zar[zar.length - 1] / DEMO_FX / 50) * 50 : fallback;
}

/** `instant: true` skips the simulated network latency (tests). */
export function createMockService(opts: { instant?: boolean } = {}): MockService {
  let s: State = blank();
  let actor: MockActor | null = null;
  const wait = (ms: number) => (opts.instant ? Promise.resolve() : sleep(ms));

  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const loaded = parse(raw);
        if (loaded.v === 5) s = loaded;
      }
    } catch { /* storage blocked: stay in memory */ }
  }
  const save = () => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(KEY, serialise(s)); } catch { /* ignore */ }
  };

  const est = () => s.snap.estate;
  const name = (a: Base58) => s.names[a] ?? "Someone";
  const first = (a: Base58) => name(a).split(" ")[0];
  const me = (): Base58 => actor?.address ?? fail("NoWallet", "Choose who you are acting as first.");
  const tx = (): TxResult => { const signature = fakeSig(); return { signature, explorerUrl: explorerTx(signature) }; };
  const log = (kind: string, text: string, t: TxResult, amount?: bigint) => {
    s.snap.activity.unshift({ ts: nowSecs(), kind, text, amount, txSignature: t.signature });
  };
  const need = (ok: boolean, code: string, detail: string) => { if (!ok) fail(code, detail); };
  const needCreated = () => need(s.created, "NoEstate", "There is no estate yet. The owner signs the will first.");
  const needOwner = () => need(me() === est().owner, "NotOwner", "Only the estate owner can do this.");
  const verifierIndex = () => {
    const i = est().verifiers.indexOf(me());
    need(i >= 0, "NotVerifier", "Only one of the three trusted people can do this.");
    return i;
  };
  const needBeneficiary = () => need(s.snap.beneficiaries.some((b) => b.wallet === me() && b.active), "NotBeneficiary", "Only a named family member can do this.");
  const count = (a: boolean[]) => a.filter(Boolean).length;
  const credit = (a: Base58, amt: bigint) => { s.balances[a] = (s.balances[a] ?? 0n) + amt; };

  const G = createMockGuardians({
    guard: () => (s.guard ??= blankGuard()),
    snap: () => s.snap, names: () => s.names, created: () => s.created, me, agent: AGENT,
    tx, log, credit, usd,
  });

  /* ----- synchronous "instructions" (shared by the async API and the stage seeder) ----- */

  function createEstate(draft: WillDraft): TxResult[] {
    need(!s.created, "BadStatus", "This estate already has a signed will.");
    const owner = me();
    const txs: TxResult[] = [];
    const e = est();
    e.owner = owner;
    e.ownerName = draft.ownerName || actor?.label || "Estate owner";
    s.names[owner] = e.ownerName;
    const vKeys = ["nomsa", "david", "busi"];
    e.verifiers = [0, 1, 2].map((i) => draft.verifiers[i]?.wallet ?? s.bind[vKeys[i]]) as [Base58, Base58, Base58];
    e.verifierNames = [0, 1, 2].map((i) => draft.verifiers[i]?.name ?? name(e.verifiers[i])) as [string, string, string];
    e.verifiers.forEach((v, i) => { s.names[v] = e.verifierNames[i]; });
    e.waitingPeriodSecs = Math.max(5, Math.round(draft.waitingPeriodDays * DEMO_SECONDS_PER_DAY));
    e.status = "Active";
    e.lastHeartbeat = nowSecs();
    e.willHash = fakeHash();
    s.created = true;
    let t = tx(); txs.push(t);
    log("EstateCreated", `${first(owner)} created the estate and named three trusted people`, t);

    const kids = ["lerato", "sipho", "naledi"];
    draft.beneficiaries.forEach((b, i) => {
      const wallet = b.wallet ?? DEMO_PERSONAS.find((p) => p.label.toLowerCase().startsWith(b.label.toLowerCase().split(" ")[0]))?.key;
      const resolved = b.wallet ?? (wallet ? s.bind[wallet] : s.bind[kids[i]] ?? fakeAddr());
      s.names[resolved] = s.names[resolved] ?? b.label;
      s.snap.beneficiaries.push({ address: fakeAddr(), wallet: resolved, label: `${b.label.split(" ")[0]} (${b.relationship})`, active: true });
    });
    PAYEES.forEach((p) => s.snap.payees.push({ address: fakeAddr(), ...p }));
    draft.rules.forEach((r, i) => {
      const ben = s.snap.beneficiaries.find((b) => b.label.toLowerCase().startsWith(r.beneficiaryLabel.toLowerCase().split(" ")[0])) ?? s.snap.beneficiaries[0];
      const fixed = r.recurring ? s.snap.payees.find((p) => p.name === r.recurring!.payeeName) ?? s.snap.payees.find((p) => p.kind === r.allowedPayeeKind) : undefined;
      s.snap.rules.push({
        address: fakeAddr(), id: i, beneficiary: ben.wallet, category: r.category, allowedPayeeKind: r.allowedPayeeKind,
        maxPerClaim: toBase(r.maxPerClaimUsdt), lifetimeCap: toBase(r.lifetimeCapUsdt), spentTotal: 0n,
        validUntil: Math.floor(new Date(r.validUntil).getTime() / 1000),
        startsNow: r.startsNow,
        recurringAmount: r.recurring && fixed ? toBase(r.recurring.amountUsdt) : 0n,
        intervalSecs: r.recurring && fixed ? DEMO_INTERVAL_SECS : 0,
        // Living schedules are due straight away; legacy schedules start when the estate unlocks.
        nextDue: r.recurring && fixed && r.startsNow ? nowSecs() : null,
        fixedPayee: r.recurring && fixed ? fixed.wallet : null,
      });
    });
    t = tx(); txs.push(t);
    log("WillSet", `Plan signed and locked: ${draft.rules.filter((r) => r.startsNow).length} rules start now, ${draft.rules.filter((r) => !r.startsNow).length} after a passing`, t);
    return txs;
  }

  function deposit(amountUsdt: number): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active", "BadStatus", "Deposits are only possible while the estate is active.");
    const amt = toBase(amountUsdt);
    need(amt > 0n, "InvalidAmount", "Enter an amount above zero.");
    need((s.balances[me()] ?? 0n) >= amt, "InsufficientFunds", "Your wallet does not hold that much USD₮.");
    s.balances[me()] -= amt;
    est().vaultBalance += amt;
    const t = tx();
    log("Deposit", `${first(me())} added ${usd(amt)} to the vault`, t, amt);
    return t;
  }

  function withdraw(amountUsdt: number): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active", "BadStatus", "The vault is locked to its rules once a passing is being confirmed.");
    const amt = toBase(amountUsdt);
    need(amt > 0n, "InvalidAmount", "Enter an amount above zero.");
    need(est().vaultBalance >= amt, "InsufficientFunds", "The vault does not hold that much.");
    est().vaultBalance -= amt;
    credit(me(), amt);
    const t = tx();
    log("Withdraw", `${first(me())} withdrew ${usd(amt)} from the vault`, t, amt);
    return t;
  }

  function registerAsset(input: { nftMint: Base58; title: string; floorUsdt: number; hardshipFloorUsdt: number; askingUsdt: number; proceedsTo: Base58 }, docHash: string): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active", "BadStatus", "Assets can only be added while the estate is active.");
    // Any number of assets (car, furniture, ...), one per digital title; a missing mint gets a demo one.
    const mint = input.nftMint || (s.snap.assets.length ? fakeAddr() : CAR_MINT);
    need(!s.snap.assets.some((a) => a.nftMint === mint), "BadStatus", "This asset is already registered.");
    need(input.hardshipFloorUsdt > 0 && input.floorUsdt >= input.hardshipFloorUsdt, "InvalidAmount", "The hardship floor must be above zero and no higher than the minimum price.");
    need(input.askingUsdt >= input.floorUsdt, "InvalidAmount", "The asking price cannot be below the minimum price.");
    const asset: Asset = {
      address: fakeAddr(), nftMint: mint, title: input.title, imageUrl: s.snap.assets.length === 0 ? "/car-corolla.svg" : undefined,
      floorPrice: toBase(input.floorUsdt), hardshipFloor: toBase(input.hardshipFloorUsdt), askingPrice: toBase(input.askingUsdt),
      proceedsTo: input.proceedsTo || ESTATE, status: "Held", listingEnds: null, docHash, hardshipBeneficiary: null,
    };
    s.snap.assets.push(asset);
    const t = tx();
    log("AssetRegistered", `${asset.title} added. Its digital title is now held by the estate`, t);
    return t;
  }

  function submitDeath(certHash: string, approve: boolean): TxResult {
    needCreated(); needBeneficiary();
    need(est().status === "Active", "BadStatus", "A passing has already been reported for this estate.");
    const d = est().death;
    const t = tx();
    log("DeathClaimSubmitted", `${first(me())} reported that ${first(est().owner)} has passed away`, t);
    if (approve) {
      d.certHash = certHash; d.submittedBy = me(); d.verdict = "Approved"; d.attestations = [false, false, false]; d.pendingSince = null;
      log("DeathReviewed", "The agent read the death certificate and found no problems", tx());
    } else {
      d.certHash = null; d.submittedBy = null; d.verdict = "Pending";
      d.agentReport = undefined;
      log("DeathReviewed", "The agent could not accept the certificate. Nothing has changed", tx());
    }
    return t;
  }

  function attestDeath(): TxResult {
    needCreated();
    const i = verifierIndex();
    const d = est().death;
    need(!!d.certHash, "NoDeathClaim", "No passing has been reported.");
    need(d.verdict === "Approved", "AgentNotApproved", "The agent has not cleared the certificate.");
    need(!d.attestations[i], "AlreadyApproved", "You have already confirmed this.");
    d.attestations[i] = true;
    const t = tx();
    log("DeathAttested", `${name(me())} confirmed the passing (${count(d.attestations)} of ${est().deathThreshold})`, t);
    if (count(d.attestations) >= est().deathThreshold && est().status === "Active") {
      est().status = "DeathPending";
      d.pendingSince = nowSecs();
    }
    G.recordApproval({
      kind: "Unlock", seatIndex: i, target: est().address, t, summary: `Confirmed ${first(est().owner)}'s passing`,
      deadline: d.pendingSince !== null ? d.pendingSince + est().waitingPeriodSecs : null,
    });
    return t;
  }

  function vetoDeath(): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active" || est().status === "DeathPending", "BadStatus", "The estate has already unlocked.");
    const e = est();
    e.status = "Active";
    e.death = { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null };
    e.lastHeartbeat = nowSecs();
    const t = tx();
    log("DeathVetoed", `${first(e.owner)} said "I'm still here". The report was cancelled and the vault stays locked`, t);
    return t;
  }

  function finalizeUnlock(force = false): TxResult {
    needCreated();
    const e = est();
    need(e.status === "DeathPending", "BadStatus", "The estate is not waiting to unlock.");
    need(force || nowSecs() >= (e.death.pendingSince ?? 0) + e.waitingPeriodSecs, "WaitingPeriodNotOver", "The waiting period has not ended yet.");
    G.checkNotObjected(e.address);
    e.status = "Unlocked";
    for (const r of s.snap.rules) if (r.recurringAmount > 0n && r.nextDue === null) r.nextDue = nowSecs();
    const t = tx();
    log("EstateUnlocked", "Waiting period over. The estate is unlocked and the rules are now in force", t);
    return t;
  }

  function submitClaim(input: { rule: Base58; payee: Base58; amountUsdt: number }, evidenceHash: string, report: AgentReport): { t: TxResult; claim: Claim } {
    needCreated(); needBeneficiary();
    const rule = s.snap.rules.find((r) => r.address === input.rule) ?? fail("BadStatus", "That rule does not exist.");
    need(est().status === "Unlocked" || (rule.startsNow && est().status === "Active"), "BadStatus", rule.startsNow ? "Claims are paused while a passing is being confirmed." : "This rule only starts after the estate is unlocked.");
    need(rule.beneficiary === me(), "NotBeneficiary", "This rule was written for someone else.");
    const payee = s.snap.payees.find((p) => p.wallet === input.payee) ?? fail("WrongPayeeKind", "That institution is not on the approved list.");
    need(payee.kind === rule.allowedPayeeKind, "WrongPayeeKind", `This rule only pays a ${rule.allowedPayeeKind.toLowerCase()}.`);
    const amt = toBase(input.amountUsdt);
    need(amt > 0n, "InvalidAmount", "Enter an amount above zero.");
    need(amt <= rule.maxPerClaim, "ExceedsPerClaimCap", `The most this rule pays per claim is ${usd(rule.maxPerClaim)}.`);
    need(rule.spentTotal + amt <= rule.lifetimeCap, "ExceedsLifetimeCap", `Only ${usd(rule.lifetimeCap - rule.spentTotal)} is left under this rule.`);
    need(nowSecs() <= rule.validUntil, "RuleExpired", "This rule has ended.");
    const approved = report.verdict === "approve";
    const claim: Claim = {
      address: fakeAddr(), rule: rule.address, id: s.snap.claims.length, beneficiary: me(), payee: payee.wallet, amount: amt,
      evidenceHash, agentVerdict: approved ? "Approved" : "Rejected", agentReport: report,
      approvals: [false, false, false], ownerApproved: false, status: approved ? "Open" : "Rejected", createdAt: nowSecs(),
    };
    s.snap.claims.unshift(claim);
    const t = tx();
    log("ClaimSubmitted", `${first(me())} asked for ${usd(amt)} to be paid to ${payee.name}`, t, amt);
    log("ClaimReviewed", approved ? `The agent checked the ${rule.category.toLowerCase()} statement: it matches the claim` : "The agent could not accept the document. The claim was declined", tx());
    return { t, claim };
  }

  function approveClaim(address: Base58): TxResult {
    needCreated();
    const i = verifierIndex();
    const c = s.snap.claims.find((x) => x.address === address) ?? fail("BadStatus", "That claim does not exist.");
    need(c.status === "Open", "BadStatus", "This claim is already closed.");
    need(c.agentVerdict === "Approved", "AgentNotApproved", "The agent has not cleared this claim.");
    need(!c.approvals[i], "AlreadyApproved", "You have already approved this.");
    c.approvals[i] = true;
    const t = tx();
    log("ClaimApproved", `${name(me())} approved ${first(c.beneficiary)}'s claim`, t);
    const deadline = count(c.approvals) >= est().claimThreshold ? G.stamp(c.address, i) : null;
    G.recordApproval({ kind: "Claim", seatIndex: i, target: c.address, t, deadline, summary: `Approved ${usd(c.amount)} to ${name(c.payee)} for ${first(c.beneficiary)}` });
    return t;
  }

  function ownerApproveClaim(address: Base58): TxResult {
    needCreated(); needOwner();
    const c = s.snap.claims.find((x) => x.address === address) ?? fail("BadStatus", "That claim does not exist.");
    const rule = s.snap.rules.find((r) => r.address === c.rule)!;
    need(rule.startsNow, "BadStatus", "Only living-plan rules can be approved by the owner.");
    need(est().status === "Active", "BadStatus", "Owner approval only applies while the estate is active.");
    need(c.status === "Open", "BadStatus", "This claim cannot be approved.");
    need(c.agentVerdict === "Approved", "AgentNotApproved", "The agent has not cleared this claim.");
    need(!c.ownerApproved, "AlreadyApproved", "You have already approved this.");
    c.ownerApproved = true;
    const t = tx();
    log("ClaimApproved", `${first(me())} approved ${first(c.beneficiary)}'s claim under the living plan`, t);
    return t;
  }

  function executeScheduled(address: Base58, force = false): TxResult {
    needCreated();
    const r = s.snap.rules.find((x) => x.address === address) ?? fail("BadStatus", "That rule does not exist.");
    need(r.recurringAmount > 0n && !!r.fixedPayee, "BadStatus", "This rule has no schedule.");
    const st = est().status;
    need(st === "Unlocked" || (r.startsNow && st === "Active"), "BadStatus", r.startsNow ? "Scheduled payments pause while a passing is being confirmed." : "This schedule starts after the estate is unlocked.");
    need(force || (r.nextDue !== null && nowSecs() >= r.nextDue), "NotDue", "This payment is not due yet.");
    need(nowSecs() <= r.validUntil, "RuleExpired", "This rule has ended.");
    need(r.spentTotal + r.recurringAmount <= r.lifetimeCap, "ExceedsLifetimeCap", `Only ${usd(r.lifetimeCap - r.spentTotal)} is left under this rule.`);
    need(est().vaultBalance >= r.recurringAmount, "InsufficientFunds", "The vault does not hold enough for this payment.");
    est().vaultBalance -= r.recurringAmount;
    r.spentTotal += r.recurringAmount;
    credit(r.fixedPayee!, r.recurringAmount);
    r.nextDue = nowSecs() + r.intervalSecs;
    const t = tx();
    log("ScheduledPaid", `Scheduled payment: ${usd(r.recurringAmount)} paid to ${name(r.fixedPayee!)} for ${first(r.beneficiary)}`, t, r.recurringAmount);
    return t;
  }

  function executeClaim(address: Base58): TxResult {
    needCreated();
    const c = s.snap.claims.find((x) => x.address === address) ?? fail("BadStatus", "That claim does not exist.");
    const rule = s.snap.rules.find((r) => r.address === c.rule)!;
    need(est().status === "Unlocked" || (rule.startsNow && est().status === "Active"), "BadStatus", "This claim cannot be paid right now.");
    need(c.status === "Open", "BadStatus", "This claim cannot be paid.");
    need(c.agentVerdict === "Approved", "AgentNotApproved", "The agent has not cleared this claim.");
    // As on-chain: while the owner is alive only his approval counts; after unlock his approval or the quorum.
    const approvedToPay = est().status === "Active" ? c.ownerApproved : c.ownerApproved || count(c.approvals) >= est().claimThreshold;
    need(approvedToPay, "InsufficientApprovals", est().status === "Active" ? "The owner still needs to approve this." : "A trusted person still needs to approve this.");
    G.checkClaimExecutable(c.address, !c.ownerApproved);
    need(rule.spentTotal + c.amount <= rule.lifetimeCap, "ExceedsLifetimeCap", "This would go over the rule's total limit.");
    need(nowSecs() <= rule.validUntil, "RuleExpired", "This rule has ended.");
    need(est().vaultBalance >= c.amount, "InsufficientFunds", "The vault does not hold enough for this payment.");
    est().vaultBalance -= c.amount;
    rule.spentTotal += c.amount;
    credit(c.payee, c.amount);
    c.status = "Paid";
    const t = tx();
    c.txSignature = t.signature;
    log("ClaimPaid", `${usd(c.amount)} paid straight to ${name(c.payee)} for ${first(c.beneficiary)}`, t, c.amount);
    return t;
  }

  function listAsset(address: Base58, durationSecs: number, withRivals: "both" | "low" | "none" = "both"): TxResult {
    needCreated();
    need(est().verifiers.includes(me()) || me() === AGENT, "NotVerifier", "A trusted person or the agent opens the sale.");
    need(est().status === "Unlocked", "BadStatus", "The car can only be sold after the estate unlocks.");
    const a = s.snap.assets.find((x) => x.address === address) ?? fail("BadStatus", "That asset does not exist.");
    need(a.status === "Held", "BadStatus", "This car is already listed or sold.");
    a.status = "Listed";
    a.listingEnds = nowSecs() + durationSecs;
    const t = tx();
    log("AssetListed", `${a.title} listed for sale at ${usd(a.askingPrice)}`, t, a.askingPrice);
    const add = (r: (typeof RIVALS)[number], amountUsdt: number) => {
      const amt = toBase(amountUsdt);
      s.balances[r.address] = (s.balances[r.address] ?? 0n) - amt;
      s.snap.offers.push({ address: fakeAddr(), asset: a.address, buyer: r.address, buyerName: r.name, amount: amt, createdAt: nowSecs() });
      log("OfferPlaced", `${r.name} put ${usd(amt)} in escrow as an offer`, tx(), amt);
    };
    const floor = fromBase(a.floorPrice);
    if (withRivals !== "none") add(RIVALS[1], Math.round(floor * 0.93 / 50) * 50);
    if (withRivals === "both") add(RIVALS[0], Math.round(floor * 1.017 / 50) * 50);
    return t;
  }

  function placeOffer(assetAddr: Base58, amountUsdt: number): TxResult {
    needCreated();
    const a = s.snap.assets.find((x) => x.address === assetAddr) ?? fail("BadStatus", "That listing does not exist.");
    need(a.status === "Listed", "ListingClosed", "This listing is not open for offers.");
    need(a.listingEnds === null || nowSecs() < a.listingEnds, "ListingClosed", "This listing has ended.");
    const amt = toBase(amountUsdt);
    need(amt > 0n, "InvalidAmount", "Enter an amount above zero.");
    const existing = s.snap.offers.find((o) => o.asset === a.address && o.buyer === me());
    const available = (s.balances[me()] ?? 0n) + (existing?.amount ?? 0n);
    need(available >= amt, "InsufficientFunds", "Your wallet does not hold that much USD₮.");
    if (existing) s.snap.offers = s.snap.offers.filter((o) => o !== existing);
    s.balances[me()] = available - amt;
    s.names[me()] = s.names[me()] ?? actor?.label ?? "Buyer";
    s.snap.offers.push({ address: fakeAddr(), asset: a.address, buyer: me(), buyerName: name(me()), amount: amt, createdAt: nowSecs() });
    const t = tx();
    log("OfferPlaced", `${name(me())} put ${usd(amt)} in escrow as an offer`, t, amt);
    return t;
  }

  function withdrawOffer(assetAddr: Base58): TxResult {
    needCreated();
    const o = s.snap.offers.find((x) => x.asset === assetAddr && x.buyer === me()) ?? fail("BadStatus", "You have no offer on this listing.");
    s.snap.offers = s.snap.offers.filter((x) => x !== o);
    credit(me(), o.amount);
    const t = tx();
    log("OfferWithdrawn", `${name(me())} took back an offer of ${usd(o.amount)}`, t, o.amount);
    return t;
  }

  function rank(assetAddr: Base58): { a: Asset; ranking: OfferRanking; min: bigint; hardship: boolean } {
    const a = s.snap.assets.find((x) => x.address === assetAddr) ?? fail("BadStatus", "That listing does not exist.");
    const hardship = !!a.hardshipBeneficiary;
    const min = hardship ? a.hardshipFloor : a.floorPrice;
    const offers = s.snap.offers.filter((o) => o.asset === a.address).sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : x.createdAt - y.createdAt));
    const eligible = offers.filter((o) => o.amount >= min).map((o, i) => ({
      offer: o.address, amount: o.amount,
      reason: i === 0 ? (hardship ? "Highest offer at or above the hardship floor" : "Highest offer at or above the minimum price") : "Meets the minimum, but a higher offer exists",
    }));
    const ineligible = offers.filter((o) => o.amount < min).map((o) => ({
      offer: o.address, amount: o.amount,
      reason: hardship ? `Below the hardship floor of ${usd(a.hardshipFloor)}. The contract will never accept this` : `Below the minimum price of ${usd(a.floorPrice)}. Blocked unless a hardship request is approved`,
    }));
    return { a, ranking: { bestOffer: eligible[0]?.offer ?? null, eligible, ineligible }, min, hardship };
  }

  function acceptBest(assetAddr: Base58): { t: TxResult; ranking: OfferRanking } {
    needCreated();
    const { a, ranking, hardship } = rank(assetAddr);
    need(a.status === "Listed", "BadStatus", "This car is not listed for sale.");
    G.checkNotObjected(a.address);
    if (hardship) for (const h of s.snap.hardships.filter((x) => x.asset === a.address && x.status === "Approved")) G.checkNotObjected(h.address);
    need(ranking.eligible.length + ranking.ineligible.length > 0, "InvalidAmount", "There are no offers yet.");
    if (!ranking.bestOffer) {
      if (hardship) fail("BelowHardshipFloor", `No offer reaches the hardship floor of ${usd(a.hardshipFloor)}.`);
      fail("BelowFloor", `No offer reaches the minimum price of ${usd(a.floorPrice)}.`);
    }
    const o = s.snap.offers.find((x) => x.address === ranking.bestOffer)!;
    const to = a.hardshipBeneficiary ?? a.proceedsTo;
    if (to === ESTATE) est().vaultBalance += o.amount; else credit(to, o.amount);
    s.snap.offers = s.snap.offers.filter((x) => x !== o);
    a.status = "Sold";
    const t = tx();
    log("AssetSold", `${a.title} sold to ${o.buyerName ?? name(o.buyer)} for ${usd(o.amount)}. ${to === ESTATE ? "The money went into the vault" : `The money went to ${first(to)}`} and the digital title moved to the buyer in the same transaction`, t, o.amount);
    return { t, ranking };
  }

  function submitHardship(assetAddr: Base58, evidenceHash: string, report: AgentReport): TxResult {
    needCreated(); needBeneficiary();
    need(est().status === "Unlocked", "BadStatus", "Hardship requests open once the estate is unlocked.");
    const a = s.snap.assets.find((x) => x.address === assetAddr) ?? fail("BadStatus", "That asset does not exist.");
    need(a.status !== "Sold", "BadStatus", "The car has already been sold.");
    // Like the contract: one request per family member per car (the account is created once and never reused).
    need(!s.snap.hardships.some((h) => h.beneficiary === me() && h.asset === assetAddr), "BadStatus", "You have already asked once for this car.");
    const ok = report.verdict === "approve";
    const h: Hardship = {
      address: fakeAddr(), asset: a.address, beneficiary: me(), evidenceHash, agentVerdict: ok ? "Approved" : "Rejected",
      agentReport: report, approvals: [false, false, false], status: ok ? "Open" : "Rejected",
    };
    s.snap.hardships.unshift(h);
    const t = tx();
    log("HardshipSubmitted", `${first(me())} asked for the car to be sold below the minimum price because of hardship`, t);
    log("HardshipReviewed", ok ? "The agent checked the affidavit: commissioned, stamped and dated" : "The agent could not accept the affidavit", tx());
    return t;
  }

  function approveHardship(address: Base58): TxResult {
    needCreated();
    const i = verifierIndex();
    const h = s.snap.hardships.find((x) => x.address === address) ?? fail("BadStatus", "That request does not exist.");
    need(h.status === "Open" && h.agentVerdict === "Approved", "BadStatus", "This request cannot be approved.");
    need(!h.approvals[i], "AlreadyApproved", "You have already approved this.");
    h.approvals[i] = true;
    const t = tx();
    log("HardshipApproved", `${name(me())} approved ${first(h.beneficiary)}'s hardship request (${count(h.approvals)} of ${est().hardshipThreshold})`, t);
    G.recordApproval({ kind: "Hardship", seatIndex: i, target: h.address, t, deadline: null, summary: `Approved ${first(h.beneficiary)}'s request to sell below the minimum price` });
    if (count(h.approvals) >= est().hardshipThreshold) {
      h.status = "Approved";
      const a = s.snap.assets.find((x) => x.address === h.asset);
      if (a) a.hardshipBeneficiary = h.beneficiary;
    }
    return t;
  }

  /* ----- plain USD₮ transfers (the Tether payment flow) ----- */

  /** Moves a pending send to confirmed once its (simulated) confirmation time has passed. Never re-sends. */
  function settle(id: string): PaymentReceipt | null {
    const x = s.sends[id];
    if (!x) return null;
    if (x.receipt.status === "pending" && Date.now() >= x.confirmAt) {
      credit(x.to, x.amount);
      x.receipt = { ...x.receipt, status: "confirmed", confirmations: 32, updatedAt: nowSecs() };
      s.snap.activity.unshift({ ts: nowSecs(), kind: "Transfer", text: `${first(x.from)} sent ${usd(x.amount)} to ${x.toLabel}`, amount: x.amount, txSignature: x.receipt.signature });
      save();
    }
    return { ...x.receipt };
  }

  /* ----- agent simulations ----- */

  // The scripted reviewer rejects by file name (docs/demo-documents/rejected/* all match).
  const suspicious = (f: File) => /fake|edit|tamper|alter|photoshop|wrong|unsigned|reject/i.test(f.name);
  async function hashFile(f: File): Promise<string> {
    try {
      const buf = await f.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch { return fakeHash(); }
  }
  const zar = (usdt: number) => `R ${(usdt * DEMO_FX).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
  const today = () => new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });

  function report(purpose: "death" | "claim" | "hardship" | "seat-death" | "fallback-death", file: File, ctx: { amountUsdt?: number; payee?: string; who?: string; person?: string }): AgentReport {
    const bad = suspicious(file);
    const who = ctx.who ?? (actor ? actor.label : "Applicant");
    if (purpose === "seat-death" || purpose === "fallback-death") {
      const person = ctx.person ?? "the person named";
      return {
        verdict: bad ? "reject" : "approve", documentType: "death_certificate",
        extracted: { "Full name": person, "Date of death": today(), "Issued by": "Department of Home Affairs", "Form": "DHA-5 (abridged death certificate)", "Serial number": "C 5528 1307", "Reported by": who },
        redFlags: bad ? ["The typeface in the name field differs from the rest of the form", "No official stamp is visible"] : [],
        confidence: bad ? 0.3 : 0.93,
        summary: bad
          ? `This does not look like a genuine Home Affairs death certificate for ${person}. Nothing has changed.`
          : purpose === "seat-death"
            ? `This is an abridged death certificate for ${person}, issued by Home Affairs. The name matches the trusted person, and I found nothing unusual. Another trusted person must still confirm.`
            : `This is an abridged death certificate for ${person}, issued by Home Affairs. The name matches the fallback recipient, so the plan will skip to the next one.`,
        reportHash: fakeHash(),
      };
    }
    if (purpose === "death") {
      return {
        verdict: bad ? "reject" : "approve", documentType: "death_certificate",
        extracted: { "Full name": est().ownerName, "Date of death": today(), "Issued by": "Department of Home Affairs", "Form": "DHA-5 (abridged death certificate)", "Serial number": "C 4471 0892", "Reported by": who },
        redFlags: bad ? ["The typeface in the name field differs from the rest of the form", "The serial number does not follow the Home Affairs pattern", "No official stamp is visible"] : [],
        confidence: bad ? 0.31 : 0.94,
        summary: bad
          ? "This does not look like a genuine Home Affairs death certificate. Parts of the form appear to have been edited. I have not passed it to the trusted people."
          : `This is an abridged death certificate for ${est().ownerName}, issued by Home Affairs. The name matches the estate owner, the stamp and serial number are present, and I found nothing unusual. Two trusted people must still confirm.`,
        reportHash: fakeHash(),
      };
    }
    if (purpose === "claim") {
      const amount = ctx.amountUsdt ?? 0;
      return {
        verdict: bad ? "reject" : "approve", documentType: "fee_statement",
        extracted: { "Student": who, "Student number": "MKNLER003", "Institution": ctx.payee ?? "Institution", "Amount due": zar(amount), "Statement date": today(), "Payment reference": "MKNLER003-2027" },
        redFlags: bad ? ["The amount due appears to have been altered", "The bank reference does not match the institution's format"] : [],
        confidence: bad ? 0.38 : 0.92,
        summary: bad
          ? "The statement appears to have been altered, so I have declined this claim. You can submit a clean copy from the institution."
          : `This is a fee statement from ${ctx.payee ?? "the institution"} in ${who}'s name. The amount due is ${zar(amount)}, which matches the ${amount.toLocaleString("en-ZA")} USD₮ requested at today's rate. The payee is on the approved list.`,
        reportHash: fakeHash(),
      };
    }
    return {
      verdict: bad ? "reject" : "approve", documentType: "affidavit",
      extracted: { "Deponent": who, "Commissioner of Oaths": "Sgt. T. Mahlangu, SAPS Orlando", "Station stamp": "Present, dated " + today(), "Jurat": "Present (sworn and signed)", "Stated reason": "Outstanding medical bills and three months of rent arrears", "Supporting papers": "Hospital account, landlord letter" },
      redFlags: bad ? ["No commissioner's stamp is visible", "The affidavit is not signed by the deponent"] : [],
      confidence: bad ? 0.35 : 0.88,
      summary: bad
        ? "This affidavit is missing the commissioner's stamp and a signature, so I cannot accept it. SAPS stations commission affidavits free of charge."
        : `${who} swore this affidavit at SAPS Orlando. It has the commissioner's details, a dated stamp and the sworn statement. The reason given is medical debt and rent arrears, with supporting papers. Two trusted people must agree before the car can sell below the minimum price.`,
      reportHash: fakeHash(),
    };
  }

  function draftFor(history: WillChatMessage[]): { stage: number; draft: WillDraft } {
    const userText = history.filter((m) => m.role === "user").map((m) => m.text).join(" ");
    const stage = history.filter((m) => m.role === "user").length;
    const floor = floorFromText(userText);
    const ownerName = actor?.label ?? "Thabo Mokoena";
    const draft: WillDraft = {
      ownerName,
      beneficiaries: [
        { label: "Lerato Mokoena", relationship: "daughter" },
        { label: "Sipho Mokoena", relationship: "son" },
        { label: "Naledi Mokoena", relationship: "daughter" },
      ],
      verifiers: stage >= 2 ? [
        { name: "Adv. Thandi Ndlovu", role: "Executor named in your will" },
        { name: "Ms. Anita Pillay", role: "Family attorney" },
        { name: "Uncle Bongani Mokoena", role: "Your brother" },
      ] : [],
      rules: [
        { beneficiaryLabel: "Lerato", category: "Books", allowedPayeeKind: "Other", maxPerClaimUsdt: 85, lifetimeCapUsdt: 3000, validUntil: "2030-12-31", notes: "Monthly book allowance (about R1,500), paid to the bookstore account", startsNow: true, recurring: { amountUsdt: 85, every: "month", payeeName: "Van Schaik Bookstore" } },
        { beneficiaryLabel: "Lerato", category: "Tuition", allowedPayeeKind: "University", maxPerClaimUsdt: 3500, lifetimeCapUsdt: 14000, validUntil: "2030-12-31", notes: "University fees, paid to the university only. You approve while you are here", startsNow: true },
        { beneficiaryLabel: "Lerato", category: "Accommodation", allowedPayeeKind: "Landlord", maxPerClaimUsdt: 450, lifetimeCapUsdt: 6000, validUntil: "2030-12-31", notes: "Residence rent every month, paid to the residence", startsNow: false, recurring: { amountUsdt: 450, every: "month", payeeName: "South Point Student Residences" } },
        { beneficiaryLabel: "Sipho", category: "Tuition", allowedPayeeKind: "University", maxPerClaimUsdt: 3500, lifetimeCapUsdt: 14000, validUntil: "2032-12-31", notes: "University fees, paid to the university only", startsNow: false },
        { beneficiaryLabel: "Naledi", category: "Tuition", allowedPayeeKind: "School", maxPerClaimUsdt: 1500, lifetimeCapUsdt: 9000, validUntil: "2034-12-31", notes: "High school fees now, university later by a new rule", startsNow: false },
      ],
      assets: stage >= 3 ? [{
        title: DEMO_ASSETS.corolla.title,
        // 12,500 minimum → 10,500 hardship floor and 13,500 asking (Tumo's prices for the 2017 Corolla).
        floorPriceUsdt: floor, hardshipFloorUsdt: Math.round(floor * 0.84 / 50) * 50, askingPriceUsdt: Math.round(floor * 1.08 / 50) * 50,
        proceedsTo: "The family vault, to fund the children's rules",
        hardshipPolicy: "May sell below the minimum only if a child proves real hardship with a sworn affidavit and two trusted people agree. Never below the hardship floor.",
      }] : [],
      waitingPeriodDays: 30,
      plainLanguageSummary: stage >= 3
        ? `Starting now, Lerato's book allowance is paid every month and you approve her university fees yourself. After two of your three trusted people confirm your passing and 30 days go by, the same plan carries on without you: rent, school and university fees are paid straight to approved institutions, within the limits you set. Your Corolla is sold to the best offer at or above ${floor.toLocaleString("en-ZA")} USD₮, and the money goes into the family vault. Nothing is paid to anyone in cash.`
        : "Two rules start now (Lerato's book allowance and her university fees) and three carry on after you're gone. Every payment goes straight to an approved institution. We still need to settle who confirms your passing and what happens to the car.",
    };
    return { stage, draft };
  }

  /* ----- stage seeding for the demo ----- */

  function as<T>(key: PersonaKey | "agent", fn: () => T): T {
    const prev = actor;
    const p = DEMO_PERSONAS.find((x) => x.key === key);
    actor = key === "agent" ? { address: AGENT, role: "agent", label: "Heirloom agent" } : { address: s.bind[key], role: p!.role, label: p!.label };
    try { return fn(); } finally { actor = prev; }
  }

  function asAddr<T>(address: Base58, role: Role, label: string, fn: () => T): T {
    const prev = actor;
    actor = { address, role, label };
    try { return fn(); } finally { actor = prev; }
  }

  /** Thabo's guardians: Bongani's backups are Kagiso then Adv. Naidoo; Aunt Zodwa watches Bongani; fallback to the children, then a charity. */
  function demoGuardianInput(): { seats: { index: number; backups: Named[]; monitors: Named[] }[]; fallback: FallbackInput[] } {
    const b = s.bind;
    return {
      seats: [
        { index: 0, backups: [], monitors: [] },
        { index: 1, backups: [], monitors: [] },
        { index: 2, backups: [{ ...DEMO_GUARDIANS.kagiso }, { ...DEMO_GUARDIANS.priya }], monitors: [{ wallet: b.zodwa, name: "Aunt Zodwa Mokoena" }] },
      ],
      fallback: [
        { wallet: b.lerato, name: "Lerato (daughter)", kind: "family" },
        { wallet: b.sipho, name: "Sipho (son)", kind: "family" },
        { wallet: b.naledi, name: "Naledi (daughter)", kind: "family" },
        { ...DEMO_GUARDIANS.charity, kind: "charity" },
      ],
    };
  }

  const certificate = () => new File(["demo"], "death-certificate.pdf");

  /** Thabo's passing reported by Lerato and cleared by the agent (no confirmations yet). */
  function reportOwnerPassing() {
    if (est().death.certHash) return;
    as("lerato", () => {
      est().death.agentReport = report("death", certificate(), { who: "Lerato Mokoena" });
      submitDeath(fakeHash(), true);
    });
  }

  function seed(stage: DemoStage) {
    s = blank();
    if (stage === "fresh") return;
    const { draft } = draftFor([{ role: "user", text: "a" }, { role: "user", text: "b" }, { role: "user", text: "c" }]);
    draft.ownerName = "Thabo Mokoena";
    as("thabo", () => {
      createEstate(draft);
      deposit(24000);
      const car = draft.assets[0];
      registerAsset({ nftMint: CAR_MINT, title: car.title, floorUsdt: car.floorPriceUsdt, hardshipFloorUsdt: car.hardshipFloorUsdt, askingUsdt: car.askingPriceUsdt, proceedsTo: ESTATE }, fakeHash());
      registerAsset({ nftMint: BIKE_MINT, title: DEMO_ASSETS.mustang.title, ...BIKE_PRICES, proceedsTo: ESTATE }, fakeHash());
      // Labelled photos and spec sheets for both (the roots were computed when the photos were converted).
      const [carAsset, bikeAsset] = s.snap.assets;
      for (const [a, d] of [[carAsset, DEMO_ASSETS.corolla], [bikeAsset, DEMO_ASSETS.mustang]] as const) {
        G.setAssetMedia(a.address, { kind: d.kind, title: d.title, photos: d.photos, spec: d.spec }, d.mediaRoot);
      }
      // Only the guardians stage has a Guard, so the stock demo (approve, then pay at once) is unchanged.
      if (stage === "guardians") G.setup(demoGuardianInput());
    });
    as("thabo", () => {
      const allowance = s.snap.rules.find((r) => r.startsNow && r.recurringAmount > 0n);
      if (allowance) executeScheduled(allowance.address, true);
    });
    if (stage === "funded") return;
    reportOwnerPassing();
    as("nomsa", attestDeath);
    as("david", attestDeath);
    finalizeUnlock(true);
    if (stage === "unlocked" || stage === "guardians") return;
    as("nomsa", () => listAsset(s.snap.assets[0].address, 7 * 86400, stage === "lowOffers" ? "low" : "both"));
  }

  /* ----- public API ----- */

  const mutate = async <T>(ms: number, fn: () => T): Promise<T> => {
    await wait(ms);
    const out = fn();
    save();
    return out;
  };

  const legacy = createMockLegacy({
    actor: () => actor, estate: est, snap: () => s.snap, created: () => s.created,
    wallets: { lerato: s.bind.lerato, sipho: s.bind.sipho, naledi: s.bind.naledi },
  });
  const { resetLegacy, ...legacyMethods } = legacy;

  return {
    mode: "mock",
    ...legacyMethods,

    setActor(a) {
      actor = a;
      if (!a) return;
      if (!(a.address in s.names)) {
        // A wallet the user created themselves: give it a name and demo funds.
        s.names[a.address] = a.label;
        if (!(a.address in s.balances)) s.balances[a.address] = a.role === "owner" ? toBase(25000) : a.role === "buyer" ? toBase(16000) : 0n;
        save();
      }
    },
    resetDemo(stage) { seed(stage); save(); resetLegacy(); },

    async reviewSend({ to, toLabel, amountUsdt }) {
      await wait(500);
      const from = me();
      const dest = to.trim();
      need(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest), "InvalidAddress", "That is not a valid Solana address.");
      const amount = toBase(amountUsdt);
      need(amount > 0n, "InvalidAmount", "Enter an amount above zero.");
      const balance = s.balances[from] ?? 0n;
      const known = dest in s.names;
      const warnings: string[] = [];
      if (dest === from) warnings.push("This is your own wallet. Sending to yourself only costs the fee.");
      if (!known) warnings.push("You have not sent to this address before. Check it carefully: transfers cannot be reversed.");
      if (!(dest in s.balances)) warnings.push("The recipient has no USD₮ account yet: it will be created, and Heirloom covers the cost.");
      const review: PaymentReview = {
        id: `pay_${rand(16, B58)}`, kind: "p2p", from, to: dest, toLabel: toLabel || name(dest), amount,
        token: { symbol: "USD₮", mint: est().usdtMint, verified: true },
        network: { name: "Solana devnet", cluster: "devnet" },
        // Like chain mode with the sponsor on: Heirloom's sponsor wallet pays the network fee, so families need no SOL.
        fee: { lamports: 10000, sol: 0.00001, payer: AGENT, sponsored: true },
        balances: { usdt: balance, sol: 0.5, sufficient: balance >= amount },
        warnings, simulated: true,
      };
      return review;
    },
    async confirmSend(review) {
      const existing = s.sends[review.id];
      if (existing) return { ...existing.receipt }; // idempotent: a retry never pays twice
      await wait(1200); // signing with the WDK wallet
      need(me() === review.from, "NotOwner", "This payment was prepared by a different wallet.");
      need((s.balances[review.from] ?? 0n) >= review.amount, "InsufficientFunds", "Your wallet does not hold that much USD₮.");
      s.balances[review.from] -= review.amount;
      const t = tx();
      const receipt: PaymentReceipt = { id: review.id, status: "pending", signature: t.signature, explorerUrl: t.explorerUrl, confirmations: 0, updatedAt: nowSecs() };
      s.sends[review.id] = { receipt, from: review.from, to: review.to, toLabel: review.toLabel, amount: review.amount, confirmAt: Date.now() + 2000 + Math.floor(Math.random() * 2000) };
      save();
      return { ...receipt };
    },
    async getReceipt(id) {
      await wait(350);
      return settle(id);
    },
    async listPendingReceipts() {
      await wait(200);
      return Object.keys(s.sends).map((id) => settle(id)!).filter((r) => r.status === "pending" || r.status === "submitted");
    },
    async savedRecipients() {
      await wait(150);
      const self = actor?.address;
      const out: SavedRecipient[] = s.created
        ? [
          ...s.snap.beneficiaries.map((b) => ({ label: b.label.replace(/\s*\(.*\)$/, ""), address: b.wallet, relationship: b.label.match(/\((.*)\)/)?.[1] })),
          ...est().verifiers.map((v, i) => ({ label: est().verifierNames[i], address: v, relationship: i === 0 ? "executor" : "trusted person" })),
          { label: est().ownerName, address: est().owner, relationship: "estate owner" },
        ]
        : DEMO_PERSONAS.filter((p) => p.role !== "buyer").map((p) => ({ label: p.label, address: p.address, relationship: p.relation.toLowerCase() }));
      return out.filter((r) => r.address !== self);
    },
    simulatePassing() {
      needCreated();
      need(est().status === "Active", "BadStatus", "A passing is already being confirmed.");
      reportOwnerPassing();
      for (const key of ["nomsa", "david"] as const) {
        if (est().status === "Active" && !est().death.attestations[est().verifiers.indexOf(s.bind[key])]) as(key, attestDeath);
      }
      save();
    },
    skipWait() { finalizeUnlock(true); save(); },
    makeDue() {
      needCreated();
      for (const r of s.snap.rules) if (r.recurringAmount > 0n && r.nextDue !== null) r.nextDue = nowSecs();
      save();
    },
    balanceOf(address) { return s.balances[address] ?? null; },

    setupDemoGuardians() {
      needCreated();
      as("thabo", () => G.setup(demoGuardianInput()));
      save();
    },
    simulateSeatApproval(index = 2) {
      needCreated();
      const holder = est().verifiers[index];
      need(!!holder && holder !== VACANT_KEY, "SeatVacant", "This seat is empty.");
      const unlocked = est().status === "Unlocked";
      // Lerato's university fees: after unlock the legacy rule, before it the living-plan rule.
      const rule = s.snap.rules.find((r) => r.category === "Tuition" && r.beneficiary === s.bind.lerato && (unlocked || r.startsNow))
        ?? fail("BadStatus", "There is no claim Lerato could make yet.");
      const payee = s.snap.payees.find((p) => p.kind === rule.allowedPayeeKind) ?? fail("BadStatus", "There is no approved institution.");
      let claim = s.snap.claims.find((c) => c.rule === rule.address && c.status === "Open" && !c.approvals[index]);
      if (!claim) {
        const amountUsdt = Math.min(3500, fromBase(rule.maxPerClaim));
        const r = report("claim", new File(["demo"], "fee-statement.pdf"), { amountUsdt, payee: payee.name, who: "Lerato Mokoena" });
        claim = as("lerato", () => submitClaim({ rule: rule.address, payee: payee.wallet, amountUsdt }, fakeHash(), r)).claim;
      }
      const target = claim.address;
      asAddr(holder, "verifier", name(holder), () => approveClaim(target));
      save();
    },
    simulateSeatPassing(index = 2) {
      needCreated();
      const st = G.seat(index);
      const holder = st.holder ?? fail("SeatVacant", "This seat is empty.");
      if (!st.succession) {
        // Reported by a monitor of the seat (Aunt Zodwa for Bongani), else by Lerato.
        const reporter = st.monitors[0] ?? s.bind.lerato;
        asAddr(reporter, "monitor", name(reporter), () =>
          G.reportSeatDeath(index, fakeHash(), report("seat-death", certificate(), { person: name(holder), who: name(reporter) })));
      }
      const sc = G.seat(index).succession;
      if (sc && !sc.confirmedBy) {
        const others = G.otherLivingHolders(index);
        const pool = others.length ? others : [st.backups[1], ...st.monitors].filter((w): w is Base58 => !!w);
        const confirmer = pool.find((w) => w !== sc.reportedBy && w !== st.backups[0]) ?? fail("NotConfirmer", "Nobody is left who can confirm this.");
        asAddr(confirmer, "verifier", name(confirmer), () => G.confirmSeatDeath(index));
      }
      save();
    },
    endObjectionWindow() { G.endObjectionWindow(); save(); },
    endSuccessionWait() { G.endSuccessionWait(); save(); },
    endFallbackWait() { G.endFallbackWait(); save(); },
    simulateAllSeatsVacant() {
      needCreated();
      G.vacateAllSeats();
      if (est().status === "Active") reportOwnerPassing();
      save();
    },

    async getEstate() {
      await wait(120);
      needCreated();
      return { ...structuredClone(s.snap), guardians: G.snapshot() };
    },
    async listEstatesFor(wallet) {
      await wait(80);
      if (!s.created) return [];
      const e = est();
      const monitor = !!s.guard?.enabled && s.guard.seats.some((x) => x.monitors.includes(wallet));
      const role = wallet === e.owner ? "owner" : e.verifiers.includes(wallet) ? "verifier" : s.snap.beneficiaries.some((b) => b.wallet === wallet) ? "beneficiary" : monitor ? "monitor" : "buyer";
      return [{ estate: e.address, role, ownerName: e.ownerName }];
    },
    async getFx() {
      await wait(60);
      return { usdtZar: DEMO_FX, source: "VALR (demo rate)", fetchedAt: nowSecs() };
    },

    async willChat(history) {
      await wait(1100);
      const { stage, draft } = draftFor(history);
      const firstName = draft.ownerName.split(" ")[0];
      const reply = stage <= 1
        ? `Thank you, ${firstName}. I've set that up as a plan in two parts. Starting now: Lerato's book allowance of 85 USD₮ (about R1,500) goes to the bookstore every month, and her university fees are paid to the university when you approve them. After you're gone: rent, school and university fees for all three carry on, paid straight to the institution, never in cash. You can switch any rule between "Now" and "After I'm gone" in the plan beside this chat.\n\nWho should confirm your passing when the time comes? Most people choose three: the executor named in their will, and two people the family trusts. Any two of them must agree.`
        : stage === 2
          ? `Good choices. Adv. Ndlovu, Ms. Pillay and your brother Bongani are now your three trusted people. Two of them must confirm before anything unlocks, and then a 30 day waiting period runs. You can cancel it with one tap if a report is ever wrong.\n\nLast thing: the car. What is the lowest price you would accept for the Corolla, and should that ever bend if one of the children is in real need?`
          : `Understood. The Corolla sells to the best offer at or above ${draft.assets[0]?.floorPriceUsdt.toLocaleString("en-ZA")} USD₮. Below that, only if one of your children proves hardship with a sworn affidavit and two trusted people agree, and never below ${draft.assets[0]?.hardshipFloorUsdt.toLocaleString("en-ZA")} USD₮. The money goes into the family vault.\n\nYour rules are ready. Please read them in plain language before you sign.`;
      return { reply, draft };
    },
    async reviewDocument({ file, purpose, context }) {
      await wait(1600);
      return report(purpose, file, { payee: context });
    },
    async valueCar({ make, model, year, mileageKm, condition }) {
      await wait(1700);
      const cond = /excellent/i.test(condition) ? 1.04 : /fair|poor/i.test(condition) ? 0.9 : 1;
      // Anchored on Thabo's 2017 Corolla 1.8 Exclusive at 124,455 km: about 13,500 USD₮ asking.
      const baseZar = Math.max(60000, (241000 + (year - 2017) * 12000 + (124455 - mileageKm) * 0.22) * cond);
      const round = (z: number) => Math.round(z / 100) * 100 - 100;
      const mid = Math.round(baseZar / DEMO_FX / 50) * 50;
      const out: CarValuation = {
        suggestedAskingUsdt: mid, lowUsdt: Math.round(mid * 0.92 / 50) * 50, highUsdt: Math.round(mid * 1.06 / 50) * 50,
        comparables: [
          { title: `${year} ${make} ${model}, ${(mileageKm + 9000).toLocaleString("en-ZA")} km, Johannesburg`, priceZar: round(baseZar * 0.97), source: "AutoTrader · demo example" },
          { title: `${year} ${make} ${model}, ${(mileageKm - 14000).toLocaleString("en-ZA")} km, Pretoria`, priceZar: round(baseZar * 1.05), source: "Cars.co.za · demo example" },
          { title: `${year + 1} ${make} ${model}, ${(mileageKm + 2000).toLocaleString("en-ZA")} km, Soweto`, priceZar: round(baseZar * 1.02), source: "WeBuyCars · demo example" },
        ],
        rationale: `Three similar ${make} ${model}s are advertised between R ${round(baseZar * 0.97).toLocaleString("en-ZA")} and R ${round(baseZar * 1.05).toLocaleString("en-ZA")}. Private sales usually close a little under the advertised price, so a fair asking price is about ${mid.toLocaleString("en-ZA")} USD₮. Your minimum price is yours to set; it is what the contract enforces.`,
      };
      return out;
    },
    async rankOffers(asset) {
      await wait(300);
      needCreated();
      return rank(asset).ranking;
    },

    async createEstateFromWill(draft) {
      const txs = await mutate(1500, () => createEstate(draft));
      return { estate: est().address, txs };
    },
    deposit: (_e, amountUsdt) => mutate(900, () => deposit(amountUsdt)),
    withdraw: (_e, amountUsdt) => mutate(900, () => withdraw(amountUsdt)),
    heartbeat: () => mutate(600, () => {
      needCreated(); needOwner();
      need(est().status === "Active" || est().status === "DeathPending", "BadStatus", "The estate has already unlocked.");
      est().lastHeartbeat = nowSecs();
      const t = tx();
      log("Heartbeat", `${first(me())} checked in: "I'm still here"`, t);
      return t;
    }),
    async registerAsset(_e, input) {
      const docHash = input.docFile ? await hashFile(input.docFile) : fakeHash();
      return mutate(1000, () => registerAsset(input, docHash));
    },
    addPayee: (_e, input) => mutate(700, () => {
      needCreated(); needOwner();
      need(est().status === "Active", "BadStatus", "Institutions can only be added while the estate is active.");
      need(input.name.length <= 64, "StringTooLong", "That name is too long.");
      s.snap.payees.push({ address: fakeAddr(), ...input });
      s.names[input.wallet] = input.name;
      const t = tx();
      log("PayeeAdded", `${input.name} added as an approved institution`, t);
      return t;
    }),
    addRule: (_e, input) => mutate(700, () => {
      needCreated(); needOwner();
      need(est().status === "Active", "BadStatus", "Rules cannot change once a passing is being confirmed.");
      need(input.maxPerClaimUsdt > 0 && input.maxPerClaimUsdt <= input.lifetimeCapUsdt, "InvalidAmount", "The per-claim limit must be above zero and within the total limit.");
      s.snap.rules.push({
        address: fakeAddr(), id: s.snap.rules.length, beneficiary: input.beneficiary, category: input.category, allowedPayeeKind: input.allowedPayeeKind,
        maxPerClaim: toBase(input.maxPerClaimUsdt), lifetimeCap: toBase(input.lifetimeCapUsdt), spentTotal: 0n, validUntil: input.validUntil,
        startsNow: input.startsNow,
        recurringAmount: input.recurring ? toBase(input.recurring.amountUsdt) : 0n,
        intervalSecs: input.recurring?.intervalSecs ?? 0,
        nextDue: input.recurring && input.startsNow ? input.recurring.firstDue : null,
        fixedPayee: input.recurring?.payee ?? null,
      });
      const t = tx();
      log("RuleAdded", `New ${input.category.toLowerCase()} rule added for ${first(input.beneficiary)}`, t);
      return t;
    }),
    ownerApproveClaim: (_e, claim) => mutate(900, () => ownerApproveClaim(claim)),
    executeScheduled: (_e, rule) => mutate(1000, () => executeScheduled(rule)),
    vetoDeath: () => mutate(800, vetoDeath),

    async submitDeathClaim(_e, certificate) {
      needCreated(); needBeneficiary();
      need(est().status === "Active", "BadStatus", "A passing has already been reported for this estate.");
      const hash = await hashFile(certificate);
      await wait(1900);
      const r = report("death", certificate, {});
      const t = submitDeath(hash, r.verdict === "approve");
      if (r.verdict === "approve") est().death.agentReport = r;
      save();
      return { tx: t, report: r };
    },
    async submitClaim(_e, input) {
      const hash = await hashFile(input.evidence);
      await wait(1900);
      const payee = s.snap.payees.find((p) => p.wallet === input.payee);
      const r = report("claim", input.evidence, { amountUsdt: input.amountUsdt, payee: payee?.name });
      const { t, claim } = submitClaim(input, hash, r);
      save();
      return { tx: t, claim: claim.address, report: r };
    },
    async submitHardship(_e, input) {
      const hash = await hashFile(input.evidence);
      await wait(1900);
      const r = report("hardship", input.evidence, {});
      const t = submitHardship(input.asset, hash, r);
      save();
      return { tx: t, report: r };
    },

    attestDeath: () => mutate(900, attestDeath),
    approveClaim: (_e, claim) => mutate(900, () => approveClaim(claim)),
    approveHardship: (_e, h) => mutate(900, () => approveHardship(h)),
    finalizeUnlock: () => mutate(800, () => finalizeUnlock()),
    executeClaim: (_e, claim) => mutate(1100, () => executeClaim(claim)),

    listAsset: (_e, asset, durationSecs) => mutate(900, () => listAsset(asset, durationSecs)),
    placeOffer: (_e, asset, amountUsdt) => mutate(1000, () => placeOffer(asset, amountUsdt)),
    withdrawOffer: (_e, asset) => mutate(800, () => withdrawOffer(asset)),
    async acceptBestOffer(_e, asset) {
      const { t, ranking } = await mutate(1600, () => acceptBest(asset));
      return { tx: t, ranking };
    },

    /* ----- guardians (docs/guardians-spec.md; rules in mock-guardians.ts) ----- */
    async getGuardians() {
      await wait(100);
      needCreated();
      return G.snapshot();
    },
    setupGuardians: (_e, input) => mutate(1400, () => G.setup(input)),
    setSeatBackups: (_e, index, backups) => mutate(800, () => {
      for (const b of backups) if (!(b.wallet in s.names)) s.names[b.wallet] = b.name;
      return G.setBackups(index, backups.map((b) => b.wallet));
    }),
    setSeatMonitors: (_e, index, monitors) => mutate(800, () => {
      for (const m of monitors) if (!(m.wallet in s.names)) s.names[m.wallet] = m.name;
      return G.setMonitors(index, monitors.map((m) => m.wallet));
    }),
    setFallback: (_e, recipients) => mutate(800, () => G.setFallback(recipients)),

    async reportSeatDeath(_e, index, certificate) {
      needCreated();
      const holder = G.seat(index).holder ?? fail("SeatVacant", "This seat is already empty.");
      const hash = await hashFile(certificate);
      await wait(1900);
      const r = report("seat-death", certificate, { person: name(holder) });
      const t = G.reportSeatDeath(index, hash, r);
      save();
      return { tx: t, report: r };
    },
    confirmSeatDeath: (_e, index) => mutate(900, () => G.confirmSeatDeath(index)),
    vetoSeatDeath: (_e, index) => mutate(800, () => G.vetoSeatDeath(index)),
    finalizeSuccession: (_e, index) => mutate(900, () => G.finalizeSuccession(index)),

    async raiseObjection(_e, input) {
      const reasonHash = await sha256Hex(input.reason.trim());
      return mutate(900, () => G.raiseObjection(input, reasonHash));
    },
    voteObjection: (_e, objection, uphold) => mutate(900, () => G.voteObjection(objection, uphold)),

    async reportFallbackDeath(_e, i, certificate) {
      needCreated();
      const person = s.guard?.fallback[i]?.name ?? fail("NoFallbackRecipient", "That fallback recipient does not exist.");
      const hash = await hashFile(certificate);
      await wait(1900);
      const r = report("fallback-death", certificate, { person });
      const t = G.reportFallbackDeath(i, hash, r);
      save();
      return { tx: t, report: r };
    },
    startFallback: () => mutate(900, () => G.startFallback()),
    lapseObjection: () => mutate(800, () => G.lapseObjection()),
    executeFallback: () => mutate(1200, () => G.executeFallback()),

    async getAssetMedia() {
      await wait(100);
      needCreated();
      return G.assetMedia();
    },
    async setAssetMedia(_e, asset, input) {
      const root = await mediaRootHex(input.photos, cleanSpec(specInputSchema.safeParse(input.spec).data));
      return mutate(900, () => G.setAssetMedia(asset, input, root));
    },
  };
}
