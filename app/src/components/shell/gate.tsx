"use client";
import type { ReactNode } from "react";
import { CloudOff, ScrollText, UserRound, UsersRound } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import type { Role, WalletSession } from "@/lib/types";
import { useWallet } from "@/lib/hooks/wallet-source";
import { useEstate } from "@/lib/hooks/estate";
import { Button, ButtonLink, EmptyState, LoadingCards, PageHeader, Skeleton } from "@/components/ui/primitives";
import { fmt, useCopy } from "./copy";
import { fullName, shortName } from "@/lib/names";

interface GateProps {
  /** Roles allowed on this screen. Omit for everyone. */
  roles?: Role[];
  /** Render even when no estate exists yet (the will writer does). */
  allowEmpty?: boolean;
  children: (ctx: { snap: EstateSnapshot | null; session: WalletSession; role: Role }) => ReactNode;
  /**
   * The page's static frame (heading, empty boxes, the chat composer...), shown while the wallet and estate load,
   * so the server-rendered first screen is the page itself rather than a placeholder. Content that depends on the
   * wallet or the estate stays out of it. Omit for the plain loading cards.
   */
  frame?: ReactNode;
}

/** Handles the states every screen shares: wallet loading, no wallet, wrong person, loading, error, no estate. */
export function Gate({ roles, allowEmpty = false, children, frame }: GateProps) {
  const { common } = useCopy();
  const g = common.gate;
  const wallet = useWallet();
  const { phase, snap, session, refresh, loadError, isMock, resetDemo } = useEstate();

  // The frame keeps the same place in the tree as the page, so a page that renders the same component in both
  // (the chat home) is not re-mounted when the wallet arrives.
  const pending = (label: string) => frame
    ? <>{frame}<span role="status" aria-live="polite" className="sr-only">{label}</span></>
    : <LoadingCards label={label} />;

  if (!wallet.ready) return pending(g.walletLoading);
  if (!session) {
    return <EmptyState level={1} icon={<UserRound className="size-6" aria-hidden="true" />} title={g.noWalletTitle} body={g.noWalletBody} action={<ButtonLink href="/start">{g.noWalletCta}</ButtonLink>} />;
  }
  if (roles && !roles.includes(session.role)) {
    const other = wallet.sessions.find((s) => roles.includes(s.role));
    return (
      <EmptyState level={1}
        icon={<UsersRound className="size-6" aria-hidden="true" />}
        title={fmt(g.wrongRoleTitle, { roles: roles.map((r) => common.persona.groups[r].toLowerCase()).join(", ") })}
        body={fmt(g.wrongRoleBody, { name: fullName(session.label), role: common.roles[session.role].toLowerCase() })}
        action={
          <>
            {other && <Button onClick={() => wallet.switchTo(other.address)}>{fmt(common.demo.switchTo, { name: shortName(other.label) })}</Button>}
            <ButtonLink href="/estate" variant="secondary">{g.backToEstate}</ButtonLink>
          </>
        }
      />
    );
  }
  if (phase === "loading") return pending(g.loading);
  if (phase === "error") {
    return (
      <EmptyState level={1}
        icon={<CloudOff className="size-6" aria-hidden="true" />} title={g.errorTitle} body={g.errorBody}
        action={<Button onClick={() => void refresh()}>{g.retry}</Button>}
      />
    );
  }
  if (!snap && !allowEmpty) {
    const owner = session.role === "owner";
    return (
      <EmptyState level={1}
        icon={<ScrollText className="size-6" aria-hidden="true" />} title={g.noEstateTitle}
        body={`${owner ? g.noEstateOwner : fmt(g.noEstateOther, { name: shortName(session.label) })}${isMock ? ` ${g.noEstateDemoHint}` : ""}`}
        action={(owner || isMock) ? (
          <>
            {owner && <ButtonLink href="/will">{g.noEstateCta}</ButtonLink>}
            {/* Demo only: jump to the "funded" stage, where Thabo's Corolla and motorbike are on the estate. */}
            {isMock && <Button variant={owner ? "secondary" : "primary"} onClick={() => void resetDemo("funded")}>{g.noEstateDemo}</Button>}
          </>
        ) : undefined}
      />
    );
  }
  void loadError;
  return <>{children({ snap, session, role: session.role })}</>;
}

/** A page's frame for <Gate frame>: its own heading (static copy) above empty boxes, in the page's column width. */
export function HeaderFrame({ width, eyebrow, title, body }: { width: string; eyebrow?: string; title: string; body?: string }) {
  return (
    <div className={`mx-auto ${width}`}>
      <PageHeader eyebrow={eyebrow} title={title} body={body} />
      <div className="grid gap-4" aria-hidden="true">
        <Skeleton className="h-36 w-full rounded-lg!" />
        <Skeleton className="h-24 w-full rounded-lg!" />
      </div>
    </div>
  );
}
