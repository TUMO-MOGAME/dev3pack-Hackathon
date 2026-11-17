"use client";
/**
 * The Trust Tree itself (loaded with next/dynamic only on /tree): the timeline, the map (wide screens) or the family
 * list (phones), the person cards, the owner's relationship sheet, what passed through the family, and the
 * fingerprint, legal line and Print. Nothing animates until this chunk has loaded after the page's first paint.
 */
import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";
import { CloudOff, Fingerprint, Info, Printer, UserRoundPlus } from "@/components/ui/icons";
import { Button, Card, EmptyState, Notice } from "@/components/ui/primitives";
import { TreeSkeleton } from "./skeleton";
import { Sheet } from "@/components/ui/client";
import { CopyValue } from "@/components/shell/proof-drawer";
import { useEstate } from "@/lib/hooks/estate";
import type { EstateSnapshot } from "@/lib/service";
import type { Role } from "@/lib/types";
import type { PersonId, Relationship, RelationshipInput, TreeSnapshot, TrustRole } from "@/lib/tree/types";
import { treeAtYear, yearOf } from "@/lib/tree/timeline";
import { TreeMap, travellersAt } from "./map";
import { TreeList } from "./list";
import { TimelineSlider } from "./slider";
import { PersonCardBody, RoleSwatch, cardTitle } from "./card";
import { RelationshipSheet } from "./owner-sheet";
import { useTree, useWide, useWidth } from "./use-tree";
import { assetStepText, assetText, fill, holderBefore, shortLabel, type Copy } from "./words";

const ROLE_ORDER: TrustRole[] = ["trustedPerson", "guardian", "heir", "beneficiary", "successor", "monitor", "fallback"];

/** Years in which something happens on the tree (Play lingers there so the motion can be seen). */
function eventYears(t: TreeSnapshot): Set<number> {
  const s = new Set<number>();
  t.people.forEach((p) => { s.add(p.since); if (p.passed) s.add(p.passed); });
  t.edges.forEach((e) => s.add(yearOf(e.fromTs)));
  t.assets.forEach((a) => a.steps.forEach((st) => { if (st.kind === "passedTo") s.add(yearOf(st.ts)); }));
  return s;
}

export default function TreeView({ copy, snap, role }: { copy: Copy; snap: EstateSnapshot; role: Role }) {
  const tree = useTree(snap.estate.address);
  if (tree.phase === "loading" || !tree.snap) {
    if (tree.phase === "error") {
      return <EmptyState icon={<CloudOff className="size-6" aria-hidden="true" />} title={copy.loadError} action={<Button onClick={() => void tree.reload()}>{copy.retry}</Button>} />;
    }
    return <TreeSkeleton label={copy.loading} />;
  }
  return <Tree copy={copy} t={tree.snap} role={role} reload={tree.reload} source={tree.source!} />;
}

function Tree({ copy, t, role, reload, source }: {
  copy: Copy; t: TreeSnapshot; role: Role; reload: () => Promise<void>; source: NonNullable<ReturnType<typeof useTree>["source"]>;
}) {
  const { session, run, busy } = useEstate();
  const viewer = session?.address ?? null;
  const reduced = !!useReducedMotion();
  const wideScreen = useWide();
  const [measure, width] = useWidth<HTMLDivElement>();
  const wide = wideScreen && width >= 720;
  const [year, setYear] = useState(() => Math.min(t.span.to, Math.max(t.span.from, t.today)));
  const [playing, setPlaying] = useState(false);
  const [openId, setOpenId] = useState<PersonId | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [printedAt] = useState(() => new Date());
  const at = useMemo(() => treeAtYear(t, year), [t, year]);
  const events = useMemo(() => eventYears(t), [t]);
  const mock = t.mode === "mock";
  const [reloading, setReloading] = useState(false);
  const again = async () => { setReloading(true); try { await reload(); } finally { setReloading(false); } };

  // Play: a year at a time, lingering on years where something happens; stops at the end.
  useEffect(() => {
    if (!playing) return;
    const next = year + 1;
    const delay = reduced ? 380 : events.has(next) ? 1500 : 420;
    const id = window.setTimeout(() => {
      if (next >= t.span.to) setPlaying(false);
      setYear(Math.min(next, t.span.to));
    }, delay);
    return () => window.clearTimeout(id);
  }, [playing, year, reduced, events, t.span.to]);

  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    if (year >= t.span.to) setYear(t.span.from);
    setPlaying(true);
  };

  const nameOf = (id: PersonId) => shortLabel(copy, at.people.find((p) => p.id === id) ?? t.people.find((p) => p.id === id), year);
  const travel = travellersAt(at, copy).map((tr) => fill(copy.map.travel, { asset: tr.label, name: nameOf(tr.to) })).join(" ");
  const roles = ROLE_ORDER.filter((r) => t.edges.some((e) => e.role === r));
  const owner = role === "owner";

  const add = async (input: RelationshipInput) => {
    const r = await run("tree.add", (_svc, estate) => source.setRelationship(estate, input), copy.owner.saved);
    if (r.ok) await reload();
    return r.ok;
  };
  const remove = async (rel: Relationship) => {
    const r = await run(`tree.remove.${rel.id}`, (_svc, estate) => source.removeRelationship(estate, rel.id), copy.owner.removed);
    if (r.ok) await reload();
  };
  const hide = async (hidden: boolean) => {
    const r = await run("tree.hide", (_svc, estate) => source.setHidden(estate, hidden), hidden ? copy.card.hidden : copy.card.shown);
    if (r.ok) await reload();
  };

  return (
    <div className="grid gap-5 *:min-w-0">
      <Notice tone={mock ? "warn" : "accent"} icon={<Info className="size-5" aria-hidden="true" />}>
        {mock ? fill(copy.demoNote, { today: t.today }) : copy.chainNote}
      </Notice>
      {t.partial && (
        <Notice icon={<Info className="size-5" aria-hidden="true" />}>
          {copy.partial}{" "}
          <Button variant="ghost" small className="-my-2 underline underline-offset-4" loading={reloading} onClick={() => void again()}>{copy.refresh}</Button>
        </Notice>
      )}

      <Card className="print-hide">
        <TimelineSlider
          copy={copy} year={year} from={t.span.from} to={t.span.to} today={t.today} imagined={mock}
          playing={playing} onYear={(y) => { setPlaying(false); setYear(y); }} onPlay={togglePlay}
        />
      </Card>
      <p className="hidden text-h3 print:block">{year}</p>
      <p className="sr-only" aria-live="polite">{travel}</p>

      <div ref={measure} className="min-w-0">
        {width === 0 ? null : wide ? (
          <Card className="overflow-hidden p-0! sm:p-0!">
            <TreeMap at={at} copy={copy} width={Math.floor(width) - 2} reduced={reduced} viewer={viewer} onOpen={setOpenId} />
          </Card>
        ) : (
          <TreeList at={at} copy={copy} reduced={reduced} viewer={viewer} onOpen={setOpenId} />
        )}
      </div>

      {roles.length > 0 && (
        <section aria-labelledby="tree-legend" className="print-avoid">
          <h2 id="tree-legend" className="text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.map.legend}</h2>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {roles.map((r) => <li key={r} className="inline-flex items-center gap-2 text-small"><RoleSwatch role={r} />{copy.roles[r]}</li>)}
            <li className="inline-flex items-center gap-2 text-small text-ink-2">
              <svg width="26" height="8" aria-hidden="true"><line x1="2" y1="4" x2="24" y2="4" stroke="var(--line-strong)" strokeWidth="1.25" /></svg>{copy.map.relationships}
            </li>
          </ul>
          <p className="mt-1.5 text-small text-ink-2">{copy.map.legendNote}</p>
        </section>
      )}

      <section aria-labelledby="tree-paths" className="print-avoid">
        <h2 id="tree-paths" className="text-h3">{copy.paths.title}</h2>
        <p className="mt-1 text-small text-ink-2">{copy.paths.body}</p>
        {at.assets.length === 0 ? <p className="mt-2 text-ink-2">{fill(copy.paths.empty, { year })}</p> : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {at.assets.map((a) => (
              <li key={a.id} className="rounded-lg border border-line bg-surface p-4">
                <p className="font-semibold">{assetText(copy, a)}</p>
                <ol className="mt-2 grid gap-1.5 border-l-2 border-line pl-3">
                  {a.steps.map((s, i) => (
                    <li key={`${s.kind}-${s.ts}-${i}`} className="text-small">
                      {assetStepText(copy, s, nameOf(holderBefore(a, i)), nameOf)}
                      {s.imagined && <span className="text-ink-2"> · {copy.card.imagined}</span>}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </section>

      {owner && (
        <Card className="print-hide">
          <h2 className="text-h3">{copy.owner.title}</h2>
          <p className="mt-1 text-small text-ink-2">{copy.owner.consentNote}</p>
          <Button variant="secondary" small className="mt-3" onClick={() => setOwnerOpen(true)}>
            <UserRoundPlus className="size-4" aria-hidden="true" />{copy.owner.add}
          </Button>
        </Card>
      )}

      <footer className="grid gap-3 border-t border-line pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-small font-semibold"><Fingerprint className="size-4 text-amber" aria-hidden="true" />{copy.footer.fingerprint}</p>
            <div className="print-hide"><CopyValue value={t.fingerprint} copyLabel={copy.footer.copy} copiedLabel={copy.footer.copied} /></div>
            <p className="hidden break-all font-mono text-[0.7rem] print:block">{t.fingerprint}</p>
          </div>
          <Button variant="secondary" small className="print-hide" onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden="true" />{copy.footer.print}
          </Button>
        </div>
        <p className="text-small text-ink-2">{copy.footer.fingerprintNote}</p>
        <p className="text-small font-medium">{copy.footer.legal}</p>
        <p className="hidden text-[0.75rem] text-ink-2 print:block">{fill(copy.footer.printed, { date: printedAt.toISOString().slice(0, 10) })}</p>
      </footer>

      <Sheet open={openId !== null} onClose={() => setOpenId(null)} title={openId ? cardTitle(at, openId, copy) : ""} closeLabel={copy.card.close}>
        {openId && <PersonCardBody at={at} id={openId} copy={copy} mock={mock} viewer={viewer} busy={busy === "tree.hide"} onHide={(h) => void hide(h)} />}
      </Sheet>
      {owner && (
        <RelationshipSheet
          open={ownerOpen} onClose={() => setOwnerOpen(false)} copy={copy} tree={t} viewer={viewer} busy={busy}
          onAdd={add} onRemove={(r) => void remove(r)}
        />
      )}
    </div>
  );
}
