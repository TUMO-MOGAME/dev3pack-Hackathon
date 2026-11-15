"use client";
/**
 * The bill-template form (plan.md §13.3), opened from the plan builder or the signed plan. Every field comes
 * pre-filled from the template (lib/everyday/templates.ts) and stays editable; "Add to my plan" either adds a
 * will-draft rule (before signing) or sends addPayee (when needed) + addRule (signed plan, estate Active).
 * Loaded on demand (next/dynamic), so /will does not carry it until a template is picked.
 */
import { useId, useState, type ChangeEvent } from "react";
import clsx from "clsx";
import { Hourglass, Plus, Zap } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import type { PayeeKind } from "@/lib/types";
import { formatZar, toBase } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { Button, Field, Notice, inputClass } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/client";
import { fmt, useCopy } from "@/components/shell/copy";
import { BILL_TEMPLATES, checkBill, templateForm, toAddRule, toDraftRule, type BillForm, type Every, type TemplateKey } from "@/lib/everyday/templates";
import type { WillDraft } from "@/lib/types";

type Copy = ScreensCopy["bills"];
export interface Option { value: string; label: string }
const NEW = "__new__";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const demoWallet = () => Array.from(crypto.getRandomValues(new Uint8Array(44)), (b) => B58[b % B58.length]).join("");

export type BillTarget =
  | { mode: "draft"; beneficiaries: Option[]; onAdd: (rule: WillDraft["rules"][number]) => void }
  | { mode: "signed"; beneficiaries: Option[]; payees: (Option & { kind: PayeeKind })[]; estateUsdt: number };

export default function BillSheet({ copy, template, target, onClose }: { copy: Copy; template: TemplateKey | null; target: BillTarget; onClose: () => void }) {
  return (
    <Sheet open={template !== null} onClose={onClose} title={template ? copy.templates[template].name : ""} description={copy.form.description} closeLabel={copy.form.cancel}>
      {template && <BillFormView key={template} copy={copy} template={template} target={target} onDone={onClose} />}
    </Sheet>
  );
}

function BillFormView({ copy, template, target, onDone }: { copy: Copy; template: TemplateKey; target: BillTarget; onDone: () => void }) {
  const f = copy.form;
  const { common } = useCopy();
  const { fx, run, busy, isMock } = useEstate();
  const id = useId();
  const signed = target.mode === "signed";
  const [now] = useState(() => Date.now());
  const [form, setForm] = useState<BillForm>(() => {
    const kind = BILL_TEMPLATES[template].payeeKind;
    const payee = target.mode === "signed"
      ? (BILL_TEMPLATES[template].newPayee ? undefined : target.payees.find((p) => p.kind === kind)?.value) ?? NEW
      : copy.templates[template].payee;
    return templateForm(template, { now, beneficiary: target.beneficiaries[0]?.value, payee, estateUsdt: target.mode === "signed" ? target.estateUsdt : null });
  });
  const [newName, setNewName] = useState<string>(copy.templates[template].payee);
  // Demo: a made-up wallet, so a new payee is still two taps (nothing real is paid in the demo).
  const [newWallet, setNewWallet] = useState(() => (isMock ? demoWallet() : ""));
  const [tried, setTried] = useState(false);
  const set = <K extends keyof BillForm>(k: K, v: BillForm[K]) => setForm((x) => ({ ...x, [k]: v }));

  const payees = signed ? target.payees.filter((p) => p.kind === form.payeeKind) : [];
  const isNew = signed && form.scheduled && form.payee === NEW;
  const errors = checkBill(isNew ? { ...form, payee: newName } : form, now);
  const walletBad = isNew && !BASE58.test(newWallet.trim());
  const show = (k: keyof typeof errors) => (tried && errors[k] ? f.errors[k] : null);
  const rate = fx?.usdtZar ?? null;
  const zar = (n: number) => (rate && Number.isFinite(n) && n > 0 ? fmt(f.rand, { zar: formatZar(toBase(n), rate) }) : undefined);
  const room = form.amountUsdt > 0 && form.capUsdt >= form.amountUsdt ? Math.floor(form.capUsdt / form.amountUsdt) : 0;
  const name = copy.templates[template].name;

  const submit = async () => {
    setTried(true);
    if (Object.keys(errors).length || walletBad) return;
    if (target.mode === "draft") {
      target.onAdd(toDraftRule(form, `${name}: ${copy.templates[template].hint}`));
      onDone();
      return;
    }
    const wallet = newWallet.trim();
    const res = await run("bill", async (svc, estate) => {
      if (isNew) await svc.addPayee(estate, { wallet, kind: form.payeeKind, name: newName.trim().slice(0, 64) });
      return svc.addRule(estate, toAddRule(isNew ? { ...form, payee: wallet } : form, { now: Date.now(), demo: isMock }));
    }, fmt(f.added, { name }));
    if (res.ok) onDone();
  };

  const num = (k: "amountUsdt" | "capUsdt") => (e: ChangeEvent<HTMLInputElement>) => set(k, e.target.value === "" ? Number.NaN : Number(e.target.value));
  const described = (k: string, err: string | null, hint?: boolean) => (err ? `${id}-${k}-error` : hint ? `${id}-${k}-hint` : undefined);

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label={f.forWho} htmlFor={`${id}-who`} hint={f.forWhoHint} error={show("beneficiary")}>
        <select id={`${id}-who`} value={form.beneficiary} onChange={(e) => set("beneficiary", e.target.value)} className={inputClass} aria-describedby={described("who", show("beneficiary"), true)}>
          {target.beneficiaries.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
      </Field>

      {form.scheduled && !signed && (
        <Field label={f.payee} htmlFor={`${id}-payee`} hint={f.payeeHint} error={show("payee")}>
          <input id={`${id}-payee`} value={form.payee} maxLength={64} onChange={(e) => set("payee", e.target.value)} className={inputClass} aria-invalid={!!show("payee")} aria-describedby={described("payee", show("payee"), true)} />
        </Field>
      )}
      {form.scheduled && signed && (
        <>
          <Field label={f.payee} htmlFor={`${id}-payee`} hint={payees.length ? f.payeeHint : f.payeeNone}>
            <select id={`${id}-payee`} value={form.payee} onChange={(e) => set("payee", e.target.value)} className={inputClass} aria-describedby={`${id}-payee-hint`}>
              {payees.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              <option value={NEW}>{f.newPayee}</option>
            </select>
          </Field>
          {isNew && (
            <div className="grid gap-4 rounded-md border border-line p-3">
              <Field label={f.newPayeeName} htmlFor={`${id}-pname`} error={show("payee")}>
                <input id={`${id}-pname`} value={newName} maxLength={64} onChange={(e) => setNewName(e.target.value)} className={inputClass} aria-invalid={!!show("payee")} aria-describedby={described("pname", show("payee"))} />
              </Field>
              <Field label={f.newPayeeWallet} htmlFor={`${id}-pwallet`} hint={isMock ? f.demoWallet : undefined} error={tried && walletBad ? f.errors.wallet : null}>
                <input id={`${id}-pwallet`} value={newWallet} onChange={(e) => setNewWallet(e.target.value)} className={clsx(inputClass, "font-mono text-small")} autoComplete="off" spellCheck={false} aria-invalid={tried && walletBad} aria-describedby={tried && walletBad ? `${id}-pwallet-error` : isMock ? `${id}-pwallet-hint` : undefined} />
              </Field>
            </div>
          )}
        </>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={form.scheduled ? f.amount : f.amountClaim} htmlFor={`${id}-amount`} hint={zar(form.amountUsdt)} error={show("amount")}>
          <input id={`${id}-amount`} type="number" inputMode="decimal" min={1} step="any" value={Number.isFinite(form.amountUsdt) ? form.amountUsdt : ""} onChange={num("amountUsdt")} className={clsx(inputClass, "tabular-nums")} aria-invalid={!!show("amount")} aria-describedby={described("amount", show("amount"), !!zar(form.amountUsdt))} />
        </Field>
        {form.scheduled && (
          <Field label={f.every} htmlFor={`${id}-every`}>
            <select id={`${id}-every`} value={form.every} onChange={(e) => set("every", e.target.value as Every)} className={inputClass}>
              {(Object.keys(f.everyOptions) as Every[]).map((k) => <option key={k} value={k}>{f.everyOptions[k]}</option>)}
            </select>
          </Field>
        )}
        <Field label={f.cap} htmlFor={`${id}-cap`} hint={form.scheduled && room > 0 ? fmt(f.capHint, { count: room }) : zar(form.capUsdt)} error={show("cap")}>
          <input id={`${id}-cap`} type="number" inputMode="decimal" min={1} step="any" value={Number.isFinite(form.capUsdt) ? form.capUsdt : ""} onChange={num("capUsdt")} className={clsx(inputClass, "tabular-nums")} aria-invalid={!!show("cap")} aria-describedby={described("cap", show("cap"), true)} />
        </Field>
        <Field label={f.until} htmlFor={`${id}-until`} error={show("until")}>
          <input id={`${id}-until`} type="date" value={form.until} onChange={(e) => set("until", e.target.value)} className={inputClass} aria-invalid={!!show("until")} aria-describedby={described("until", show("until"))} />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-small font-semibold">{f.starts}</legend>
        <div className="flex rounded-full bg-surface p-0.5 ring-1 ring-line-strong">
          {[true, false].map((now) => (
            <label key={String(now)} className={clsx("flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2 text-small font-semibold transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]", form.startsNow === now ? (now ? "bg-accent text-accent-ink" : "bg-ink text-bg") : "text-ink-2")}>
              <input type="radio" name={`${id}-starts`} className="sr-only" checked={form.startsNow === now} onChange={() => set("startsNow", now)} />
              {now ? <Zap className="size-4" aria-hidden="true" /> : <Hourglass className="size-4" aria-hidden="true" />}
              {now ? f.now : f.later}
            </label>
          ))}
        </div>
      </fieldset>

      {template === "legal" && <Notice>{signed && target.estateUsdt > 0 ? f.executorNote : f.executorNoteDraft}</Notice>}
      {!form.scheduled && <p className="text-small text-ink-2">{f.claimNote}</p>}
      {form.scheduled && !signed && !isMock && <p className="text-small text-ink-2">{f.draftPayeeNote}</p>}
      <p className="text-[0.75rem] text-ink-2">{common.status.category[form.category]} · {common.status.payeeKind[form.payeeKind]}</p>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onDone}>{f.cancel}</Button>
        <Button type="submit" loading={busy === "bill"}><Plus className="size-5" aria-hidden="true" />{busy === "bill" ? f.adding : f.add}</Button>
      </div>
    </form>
  );
}
