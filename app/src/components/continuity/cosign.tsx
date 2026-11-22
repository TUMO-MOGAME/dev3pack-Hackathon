"use client";
/**
 * The sale's co-signature (plan §18.4 U4, R12, R19): the trusted person reads the buyer and the exact amount, then
 * signs that. An offer that changed in the meantime is shown again and is never signed on the old reading.
 */
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { PenLine, Gavel } from "@/components/ui/icons";
import type { EstateSnapshot, HeirloomService } from "@/lib/service";
import type { Asset, Base58, Offer, OfferRanking } from "@/lib/types";
import { hasLivingSeat, isHeld } from "@/lib/guardians/decisions";
import { useEstate } from "@/lib/hooks/estate";
import { fromBase } from "@/lib/format";
import { Button } from "@/components/ui/primitives";
import { Blocked } from "@/components/shell/blocked";
import { fmt, useCopy } from "@/components/shell/copy";
import { useWho } from "@/components/guardians/decision";

/** Every decimal there is: what is signed is what is read. */
export const exactUsdt = (base: bigint) => `${fromBase(base).toLocaleString("en-ZA", { maximumFractionDigits: 6 })} USD₮`;

interface Seen { offer: Base58; amount: bigint }
type SettleWith = (estate: Base58, asset: Base58, seen: Seen) => ReturnType<HeirloomService["acceptBestOffer"]>;
/** The mock checks `seen` itself. The service's type has no such argument yet, so it is also re-read just before signing. */
const settleSeen = (s: HeirloomService): SettleWith => (s.acceptBestOffer as SettleWith).bind(s);
const changed = () => Object.assign(new Error("OfferChanged: the offer changed after it was shown."), { code: "OfferChanged" });

export function CoSign({ snap, asset, ranking, body, cta, working, done, refusalExtra }: {
  snap: EstateSnapshot;
  asset: Asset;
  ranking: OfferRanking | null;
  body: string;
  cta: string;
  working: string;
  done: string;
  refusalExtra?: ReactNode;
}) {
  const t = useCopy().guardians.rules.sale;
  const { session, run, busy } = useEstate();
  const who = useWho(snap);
  const id = useId();
  const [seen, setSeen] = useState<Seen | null>(null);
  const [moved, setMoved] = useState(false);
  const [blocked, setBlocked] = useState<{ code: string; message: string } | null>(null);
  const e = snap.estate;
  const me = session?.address;
  const mine = snap.offers.filter((o) => o.asset === asset.address);
  const best: Offer | undefined = mine.find((o) => o.address === ranking?.bestOffer);
  const staffed = hasLivingSeat(e);
  const holder = isHeld(me) && e.verifiers.includes(me);
  const ownOffer = holder && !!best && best.buyer === me;

  if (seen && (seen.offer !== best?.address || seen.amount !== best.amount)) {
    // A change is shown and has to be read again.
    setSeen(best ? { offer: best.address, amount: best.amount } : null);
    setMoved(true);
  }

  const sign = async (agreed: Seen | null) => {
    setBlocked(null);
    const res = await run("settle", async (s, est) => {
      if (!agreed) return s.acceptBestOffer(est, asset.address);
      const [latest, now] = await Promise.all([s.rankOffers(asset.address), s.getEstate(est)]);
      if (latest.bestOffer !== agreed.offer || now.offers.find((o) => o.address === agreed.offer)?.amount !== agreed.amount) throw changed();
      return settleSeen(s)(est, asset.address, agreed);
    }, done, true);
    if (res.ok) { setSeen(null); setMoved(false); return; }
    if (res.code === "OfferChanged") setMoved(true);
    else setBlocked({ code: res.code, message: res.message });
  };

  if (ownOffer) return <p className="mt-2 text-small font-semibold">{t.ownOffer}</p>;

  const to = asset.hardshipBeneficiary ?? asset.proceedsTo;
  return (
    <>
      <p className="mt-1 text-ink-2">{staffed ? body : t.noSeats}</p>
      {moved && <p role="alert" className="mt-3 border-l-4 border-ink pl-2 text-small font-semibold">{best ? t.changed : t.noOffer}</p>}
      {seen && best ? (
        <div role="group" aria-labelledby={`${id}-title`} className="mt-3 rounded-md border-2 border-ink p-3">
          <p id={`${id}-title`} className="font-semibold">{staffed ? t.title : t.settleTitle}</p>
          <dl className="mt-2 grid gap-2 text-small">
            <div className="min-w-0">
              <dt className="text-ink-2">{t.buyer}</dt>
              <dd className="font-semibold">{best.buyerName ?? who(best.buyer)}</dd>
              <dd className="break-all font-mono text-[0.75rem] text-ink-2">{best.buyer}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-2">{t.amount}</dt>
              <dd className="break-words text-h3 font-semibold tabular-nums">{exactUsdt(seen.amount)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-2">{t.to}</dt>
              <dd className="font-semibold">{to === e.address ? t.vault : who(to)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-small text-ink-2">{staffed ? t.body : t.noSeats}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="ghost" autoFocus onClick={() => { setSeen(null); setMoved(false); }}>{t.back}</Button>
            <Button className="flex-1" loading={busy === "settle"} disabled={!!busy} onClick={() => void sign(seen)}>
              <PenLine className="size-5 shrink-0" aria-hidden="true" />{busy === "settle" ? working : fmt(staffed ? t.sign : t.settle, { amount: exactUsdt(seen.amount) })}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          className="mt-3" loading={busy === "settle" || (mine.length > 0 && !ranking)} disabled={!!busy || mine.length === 0}
          // With no offer that can win there is nothing to read: asking shows the contract's refusal and why.
          onClick={() => {
            setMoved(false);
            if (best) { setBlocked(null); setSeen({ offer: best.address, amount: best.amount }); } else void sign(null);
          }}
        >
          <Gavel className="size-5" aria-hidden="true" />{busy === "settle" ? working : best ? t.review : cta}
        </Button>
      )}
      {blocked && <div className="mt-4"><Blocked code={blocked.code} message={blocked.message}>{refusalExtra}</Blocked></div>}
    </>
  );
}
