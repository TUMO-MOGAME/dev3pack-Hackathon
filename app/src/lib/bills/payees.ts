/**
 * Saved bill payees (businesses and professionals) and the pieces both services share. Client-safe.
 * Payees live with the wallet that pays them (chain: this device's storage, per wallet; demo: the demo state),
 * never on-chain: they are an address book, not part of the plan.
 */
import { z } from "zod";
import type { Base58 } from "../types";
import { BILL_KINDS, type BillDetails, type BillPayee, type BillPayeeInput } from "./types";
import type { RecipientLike } from "../assistant/intent";

const base58 = z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "That is not a valid Solana address.");

export const billPayeeInputSchema = z.object({
  name: z.string().trim().min(2, "Give the payee a name.").max(64),
  wallet: base58,
  kind: z.enum(BILL_KINDS),
  reference: z.string().trim().max(40).optional().transform((v) => v || undefined),
});

export const billDetailsSchema = z.object({
  payee: z.string().trim().min(1).max(64),
  kind: z.enum(BILL_KINDS),
  reference: z.string().trim().max(40).nullable(),
  note: z.string().trim().max(120).nullable(),
  amountZar: z.number().positive().max(20_000_000).nullable(),
  invoiceSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  invoiceCheck: z.enum(["match", "mismatch", "unread"]).nullable(),
});

const id = () => `bp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Adds a payee, or updates the one with the same wallet (one entry per wallet). Returns the new list and the entry. */
export function upsertPayee(list: BillPayee[], input: BillPayeeInput): { list: BillPayee[]; payee: BillPayee } {
  const clean = billPayeeInputSchema.parse(input);
  const existing = list.find((p) => p.wallet === clean.wallet);
  const payee: BillPayee = { id: existing?.id ?? id(), ...clean };
  return { list: existing ? list.map((p) => (p.id === existing.id ? payee : p)) : [...list, payee], payee };
}

/** Bill payees as the wallet assistant's recipients: "Pay Ndlovu Attorneys R2 500" finds them by name or by kind. */
export function payeesAsRecipients(list: BillPayee[]): RecipientLike[] {
  return list.map((p) => ({ label: p.name, address: p.wallet, relationship: p.kind }));
}

/** One activity line, the same in both modes. */
export function billActivityText(payer: string, bill: BillDetails, amount: string): string {
  const what = [bill.note, bill.reference ? `ref ${bill.reference}` : null].filter(Boolean).join(", ");
  return `${payer} paid a bill: ${amount} to ${bill.payee}${what ? ` (${what})` : ""}`;
}

/* ---------- device store (chain mode) ---------- */

const KEY = "heirloom.billPayees.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function billPayeeStore(storage: Storage | null = typeof window === "undefined" ? null : window.localStorage) {
  let memory: Record<Base58, BillPayee[]> = {};
  const read = (): Record<Base58, BillPayee[]> => {
    if (!storage) return memory;
    try { return JSON.parse(storage.getItem(KEY) ?? "{}") as Record<Base58, BillPayee[]>; } catch { return memory; }
  };
  const write = (all: Record<Base58, BillPayee[]>) => {
    memory = all;
    try { storage?.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked: keep in memory */ }
  };
  return {
    list: (owner: Base58): BillPayee[] => read()[owner] ?? [],
    save(owner: Base58, input: BillPayeeInput): BillPayee {
      const all = read();
      const { list, payee } = upsertPayee(all[owner] ?? [], input);
      write({ ...all, [owner]: list });
      return payee;
    },
  };
}

/** Thabo's saved payees in the demo: his lawyer (the will), his plumber and Naledi's school. */
export const DEMO_BILL_PAYEES: BillPayee[] = [
  { id: "bp_ndlovu", name: "Ndlovu Attorneys", wallet: "NdLoVuAtToRnEyS2wiLLdRaFtiNg8uE6rAoPaYbiLL1", kind: "lawyer" },
  { id: "bp_plumber", name: "Soweto Plumbing", wallet: "SoWeToPLuMbiNg3PiPeSaNdGeYsERs8uE6rAoPaYbiL2", kind: "plumber" },
  { id: "bp_school", name: "Westerford High School", wallet: "WeSTeRFoRdHiGhSchooLTRiPs4uE6rAoPaYbiLL3xyz", kind: "school", reference: "NALEDI-M" },
];
