"use client";
import type { ReactNode } from "react";
import { CloudOff, ScrollText, UserRound, UsersRound } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import type { Role, WalletSession } from "@/lib/types";
import { useWallet } from "@/lib/hooks/wallet-source";
import { useEstate } from "@/lib/hooks/estate";
import { Button, ButtonLink, EmptyState, LoadingCards } from "@/components/ui/primitives";
import { fmt, useCopy } from "./copy";
import { fullName, shortName } from "@/lib/names";

interface GateProps {
  /** Roles allowed on this screen. Omit for everyone. */
  roles?: Role[];
  /** Render even when no estate exists yet (the will writer does). */
  allowEmpty?: boolean;
  children: (ctx: { snap: EstateSnapshot | null; session: WalletSession; role: Role }) => ReactNode;
}

/** Handles the states every screen shares: wallet loading, no wallet, wrong person, loading, error, no estate. */
export function Gate({ roles, allowEmpty = false, children }: GateProps) {
  const { common } = useCopy();
  const g = common.gate;
  const wallet = useWallet();
  const { phase, snap, session, refresh, loadError, isMock, resetDemo } = useEstate();

  if (!wallet.ready) return <LoadingCards label={g.walletLoading} />;
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
  if (phase === "loading") return <LoadingCards label={g.loading} />;
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
