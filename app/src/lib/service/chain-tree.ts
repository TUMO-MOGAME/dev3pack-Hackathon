/**
 * Trust Tree on Solana (chain mode, plan.md §15.5). Read-only on-chain: no new instruction, nothing is signed for the
 * chain.
 *
 * - History: the estate's full event history (lib/chain/reads fetchHistory: paged beyond the feed's 40 signatures,
 *   within an ~8 s budget, `partial` when cut short), decoded into value-free facts (lib/tree/events). The current
 *   snapshot (getEstate) fills in roles the chain has no event for, and any gap in a partial history.
 * - Child plans: a beneficiary who owns an estate of their own is linked below this one (a generation link).
 * - Names: the estate's name book (meta, guardians, this device's wallets) and, for the seeded demo estate, the
 *   default family (lib/chain/demo-estate.ts).
 * - Relationships and hidden flags: /api/tree (Supabase table family_links when configured, else server memory),
 *   plus this device's copy (localStorage), merged; writes are signed by the acting wallet.
 */
import type { Base58 } from "../types";
import type { EstateSnapshot } from "./types";
import type { AssetKind } from "../guardians/types";
import { sha256Hex } from "../agent/hash";
import { deriveTree, type TreeEstateInput } from "../tree/derive";
import { treeEventsFromChain, type RawChainEvent } from "../tree/events";
import {
  defaultPeople, defaultRelationships, mergeLinks, PERSON_ID, readLocalLinks, RELATIONSHIP_KINDS, relationshipId, treeBody, treeMessage, writeLocalLinks,
  type FamilyLinks, type LocalLinks, type TreeAction,
} from "../tree/links";
import type { GenerationLink, Relationship, TreeService } from "../tree/types";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export interface ChainTreeDeps {
  getEstate(estate: Base58): Promise<EstateSnapshot>;
  /** The estate's decoded history (lib/chain/reads fetchHistory), newest first. */
  history(estate: Base58): Promise<{ events: RawChainEvent[]; partial: boolean }>;
  /** The estate a wallet owns, if any (child plans). */
  findEstateOf?(wallet: Base58): Promise<Base58 | null>;
  /** Asset kinds by asset address (the photos' registered kind). */
  assetKinds?(estate: Base58): Promise<Record<Base58, AssetKind>>;
  /** Throws unless the active wallet owns the estate. */
  requireOwnerOf(estate: Base58): unknown;
  signer(): { address: Base58; signMessage(message: string): Promise<string> };
  /** Wallets saved on this device, with their labels (names of last resort). */
  deviceWallets?(): { address: Base58; label: string }[];
  fetch?: typeof fetch;
  /** null = no device storage. */
  storage?: Storage | null;
  /** Milliseconds. */
  now?(): number;
}

const browserStorage = (): Storage | null => {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
};

/** How long child plans may take to load (they are a nice-to-have next to the estate's own history). */
const CHILD_BUDGET_MS = 3_000;

export function createChainTree(d: ChainTreeDeps): TreeService {
  const f = d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const storage = d.storage === undefined ? browserStorage() : d.storage;
  const now = d.now ?? (() => Date.now());

  async function serverLinks(estate: Base58): Promise<FamilyLinks> {
    try {
      const res = await f(`/api/tree?estate=${estate}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as FamilyLinks;
      return { relationships: Array.isArray(data.relationships) ? data.relationships : [], hidden: Array.isArray(data.hidden) ? data.hidden : [] };
    } catch {
      // Server unreachable: the defaults and this device's copy still give a tree.
      return { relationships: defaultRelationships(estate), hidden: [] };
    }
  }

  async function links(estate: Base58): Promise<FamilyLinks> {
    return mergeLinks(await serverLinks(estate), readLocalLinks(storage, estate));
  }

  /** Signed POST /api/tree. Network trouble or no server store (503) leaves this device's copy standing; a refusal throws. */
  async function post(action: TreeAction, estate: Base58, fields: Record<string, unknown>, body: string): Promise<{ ok: boolean; refused?: Error; relationship?: Relationship }> {
    const signer = d.signer();
    const ts = now();
    const sig = await signer.signMessage(treeMessage(action, estate, signer.address, ts, await sha256Hex(body)));
    let res: Response;
    try {
      res = await f("/api/tree", {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, estate, wallet: signer.address, ts, sig, ...fields }),
      });
    } catch (e) {
      console.warn(`The family tree change is saved on this device only: ${(e as Error).message}`);
      return { ok: false };
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; relationship?: Relationship };
    if (res.ok) return { ok: true, relationship: data.relationship };
    if (res.status >= 500) { console.warn(`The family tree change is saved on this device only (${res.status}).`); return { ok: false }; }
    return { ok: false, refused: Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { code: data.code }) };
  }

  function local(estate: Base58, change: (l: LocalLinks) => LocalLinks) { writeLocalLinks(storage, estate, change); }

  /** Child plans: beneficiaries who own an estate of their own (best effort, within a short budget). */
  async function children(snap: EstateSnapshot): Promise<{ inputs: TreeEstateInput[]; links: GenerationLink[] }> {
    if (!d.findEstateOf) return { inputs: [], links: [] };
    const find = d.findEstateOf;
    const work = Promise.all(snap.beneficiaries.slice(0, 6).map(async (b) => {
      const child = await find(b.wallet).catch(() => null);
      if (!child || child === snap.estate.address) return null;
      const cs = await d.getEstate(child).catch(() => null);
      if (!cs) return null;
      const ts = cs.activity.find((a) => a.kind === "EstateCreated")?.ts ?? Math.min(...cs.activity.map((a) => a.ts), Math.floor(now() / 1000));
      return { input: { estate: child, owner: cs.estate.owner, snapshot: cs } as TreeEstateInput, link: { parentEstate: snap.estate.address, childEstate: child, person: b.wallet, ts } };
    }));
    const found = await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), CHILD_BUDGET_MS))]);
    const ok = (found ?? []).filter((x): x is NonNullable<typeof x> => !!x);
    return { inputs: ok.map((x) => x.input), links: ok.map((x) => x.link) };
  }

  return {
    async getTree(estate) {
      const [snap, hist, fam] = await Promise.all([
        d.getEstate(estate),
        d.history(estate).catch(() => ({ events: [] as RawChainEvent[], partial: true })),
        links(estate),
      ]);
      const assetKinds = d.assetKinds ? await d.assetKinds(estate).catch(() => ({})) : {};
      const history = treeEventsFromChain(hist.events, {
        estate, assetTitles: Object.fromEntries(snap.assets.map((a) => [a.address, a.title])), assetKinds,
      });
      const kids = await children(snap);
      return deriveTree({
        estate, mode: "chain",
        estates: [{ estate, owner: snap.estate.owner, snapshot: snap, history, partial: hist.partial }, ...kids.inputs],
        relationships: fam.relationships,
        hidden: fam.hidden,
        generations: kids.links,
        people: defaultPeople(estate),
        today: new Date(now()).getUTCFullYear(),
        nameSources: { wallets: d.deviceWallets?.() ?? [] },
        partial: hist.partial,
      });
    },

    async setRelationship(estate, input) {
      d.requireOwnerOf(estate);
      if (!RELATIONSHIP_KINDS.includes(input.kind)) throw new Error("Choose how the two people are related.");
      if (!PERSON_ID.test(input.from) || !PERSON_ID.test(input.to)) throw new Error("Choose two people from the tree.");
      if (input.from === input.to) throw new Error("Choose two different people.");
      const current = await links(estate);
      if (input.kind === "parentOf" && current.relationships.some((r) => r.id === relationshipId("parentOf", input.to, input.from))) {
        throw new Error("That would make someone their own grandparent.");
      }
      const id = relationshipId(input.kind, input.from, input.to);
      const rel: Relationship = current.relationships.find((r) => r.id === id)
        ?? { id, kind: input.kind, from: input.from, to: input.to, declaredBy: d.signer().address, declaredAt: Math.floor(now() / 1000) };
      const before = readLocalLinks(storage, estate);
      local(estate, (l) => ({ ...l, added: [...l.added.filter((r) => r.id !== id), rel], removed: l.removed.filter((x) => x !== id) }));
      const out = await post("relate", estate, { kind: input.kind, from: input.from, to: input.to }, treeBody({ action: "relate", ...input }));
      if (out.refused) { local(estate, () => before); throw out.refused; }
      return out.relationship ?? rel;
    },

    async removeRelationship(estate, id) {
      d.requireOwnerOf(estate);
      const before = readLocalLinks(storage, estate);
      local(estate, (l) => ({ ...l, added: l.added.filter((r) => r.id !== id), removed: [...l.removed.filter((x) => x !== id), id] }));
      const out = await post("unrelate", estate, { id }, treeBody({ action: "unrelate", id }));
      // 404: the server never had it (declared on this device only); removing it here is enough.
      if (out.refused && (out.refused as Error & { code?: string }).code !== "not_found") { local(estate, () => before); throw out.refused; }
    },

    async setHidden(estate, hidden) {
      const me = d.signer().address;
      const before = readLocalLinks(storage, estate);
      local(estate, (l) => ({ ...l, hidden: { ...l.hidden, [me]: hidden } }));
      const out = await post("hide", estate, { hidden }, treeBody({ action: "hide", hidden }));
      if (out.refused) { local(estate, () => before); throw out.refused; }
    },
  };
}
