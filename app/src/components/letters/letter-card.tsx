"use client";
/**
 * One letter, as its reader sees it: from whom, the occasion, when it opened, the words, what it is about (→ the
 * asset's page), the gift it came with (with proof: Solana Explorer on devnet, "simulated" in the demo), who added a
 * letter about someone who has passed, the signature line and the not-part-of-the-will line. Print gives the
 * family a paper copy.
 */
import Link from "next/link";
import { CarFront, ExternalLink, HandHeart, Printer } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { explorerTx, shortAddress } from "@/lib/format";
import type { EstateSnapshot } from "@/lib/service";
import type { Locale } from "@/lib/i18n/locales";
import type { LetterView } from "@/lib/letters/types";
import { dateText, fill, letterWords, nameOf, recipientText, usdt, type Copy } from "./words";

const chip = "inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 text-small font-medium";

export function LetterCard({ letter: l, snap, copy, locale, mock, onPrint }: {
  letter: LetterView; snap: EstateSnapshot; copy: Copy; locale: Locale; mock: boolean; onPrint?: () => void;
}) {
  const words = letterWords(l, copy);
  const from = nameOf(snap, l.from);
  const asset = l.about ? snap.assets.find((a) => a.address === l.about!.asset) : undefined;
  const signedOn = dateText(Math.floor(l.signedAt / 1000), locale);
  return (
    <article id={l.id} aria-labelledby={`${l.id}-title`} className="print-avoid scroll-mt-20 rounded-lg border border-line bg-surface p-5 shadow-card sm:p-7">
      <header className="grid gap-1">
        <p className="text-small font-semibold uppercase tracking-[0.12em] text-ink-2">
          {fill(copy.read.from, { name: from })} · {recipientText(l, snap, copy)}
        </p>
        <h3 id={`${l.id}-title`} className="text-h3">{words.occasion || copy.list.untitled}</h3>
        {l.state === "open" && l.openedAt && <p className="text-small text-ink-2 tabular-nums">{fill(copy.read.opened, { date: dateText(l.openedAt, locale) })}</p>}
      </header>

      <div className="mt-4 max-w-prose whitespace-pre-wrap break-words text-body leading-relaxed" data-letter-text>{words.text}</div>

      {(asset || l.opens.kind === "payment" || l.demoKey === "mkhulu" || l.transcribed) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {asset && (
            <Link href="/car" className={`${chip} underline-offset-4 hover:underline`}>
              <CarFront className="size-4 text-amber" aria-hidden="true" />{fill(copy.read.about, { asset: asset.title })}
            </Link>
          )}
          {l.opens.kind === "payment" && l.hint.giftUsdt !== undefined && l.state === "open" && (
            <span className={chip}>
              <HandHeart className="size-4 text-amber" aria-hidden="true" />
              {fill(copy.read.gift, { amount: usdt(l.hint.giftUsdt), date: l.hint.paidAt ? dateText(l.hint.paidAt, locale) : l.openedAt ? dateText(l.openedAt, locale) : "" })}
              {l.hint.paidSig && (mock
                ? <span className="font-normal text-ink-2">({copy.read.giftSimulated})</span>
                : (
                  <a href={explorerTx(l.hint.paidSig)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-semibold underline underline-offset-4">
                    {copy.read.proof}<ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                ))}
            </span>
          )}
          {l.demoKey === "mkhulu" && <span className={chip}>{fill(copy.read.addedBy, { name: from, year: new Date(l.createdAt * 1000).getUTCFullYear() })}</span>}
          {l.transcribed && (
            <span className={chip}>{fill(copy.read.transcribedBy, { name: l.transcribed.person, year: l.transcribed.year, owner: from })}</span>
          )}
        </div>
      )}

      <footer className="mt-5 grid gap-2 border-t border-line pt-3">
        <p className="text-small text-ink-2" data-not-will>{copy.notWill}</p>
        <p className="break-words text-[0.75rem] text-ink-2">
          {l.sig ? fill(copy.read.signed, { name: from, date: signedOn, hash: shortAddress(l.hash, 4) }) : copy.read.demoSigned}
        </p>
        {onPrint && (
          <div className="print-hide">
            <Button variant="secondary" small onClick={onPrint}><Printer className="size-4" aria-hidden="true" />{copy.read.print}</Button>
          </div>
        )}
      </footer>
    </article>
  );
}
