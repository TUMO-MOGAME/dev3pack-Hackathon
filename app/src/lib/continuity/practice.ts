/** Practice setup for the test network: who still needs a wallet, and the payees a plan's rules need. Pure. */
import type { PayeeKind, Role, WillDraft } from "../types";

export interface MissingPerson { key: string; name: string; role: Role }

export const personKey = (kind: "b" | "v", index: number) => `${kind}${index}`;

/** People in the plan with no wallet yet. `wallets` holds what the owner pasted or made, by key. */
export function missingPeople(draft: Pick<WillDraft, "beneficiaries" | "verifiers">, wallets: Record<string, string> = {}): MissingPerson[] {
  const out: MissingPerson[] = [];
  draft.beneficiaries.forEach((b, i) => {
    if (!b.wallet && !wallets[personKey("b", i)]) out.push({ key: personKey("b", i), name: b.label, role: "beneficiary" });
  });
  draft.verifiers.forEach((v, i) => {
    if (!v.wallet && !wallets[personKey("v", i)]) out.push({ key: personKey("v", i), name: v.name, role: "verifier" });
  });
  return out;
}

/** The draft with those wallets filled in: what is hashed and signed. */
export function withWallets(draft: WillDraft, wallets: Record<string, string>): WillDraft {
  return {
    ...draft,
    beneficiaries: draft.beneficiaries.map((b, i) => (!b.wallet && wallets[personKey("b", i)] ? { ...b, wallet: wallets[personKey("b", i)] } : b)),
    verifiers: draft.verifiers.map((v, i) => (!v.wallet && wallets[personKey("v", i)] ? { ...v, wallet: wallets[personKey("v", i)] } : v)),
  };
}

const PRACTICE_NAME: Record<PayeeKind, string> = {
  University: "Practice University",
  School: "Practice School",
  Landlord: "Practice Landlord",
  Other: "Practice Payee",
};

/**
 * The payees to create: each scheduled payee by the name the rule gives, and one per kind that no payee covers.
 * A name that is already an approved payee of that kind is left alone.
 */
export function practicePayees(rules: WillDraft["rules"], existing: { name: string; kind: PayeeKind }[] = []): { name: string; kind: PayeeKind }[] {
  const out: { name: string; kind: PayeeKind }[] = [];
  const all = () => [...existing, ...out];
  for (const r of rules) {
    if (!r.recurring) continue;
    const name = r.recurring.payeeName.trim().slice(0, 64);
    if (name && !all().some((p) => p.kind === r.allowedPayeeKind && p.name.toLowerCase() === name.toLowerCase())) {
      out.push({ name, kind: r.allowedPayeeKind });
    }
  }
  for (const r of rules) {
    if (!all().some((p) => p.kind === r.allowedPayeeKind)) out.push({ name: PRACTICE_NAME[r.allowedPayeeKind], kind: r.allowedPayeeKind });
  }
  return out;
}
