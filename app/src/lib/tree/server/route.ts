import "server-only";
/**
 * /api/tree logic (app/api/tree/route.ts re-exports it): GET an estate's family links, POST a signed change.
 *
 * GET is open like /api/estate-meta and /api/asks (the tree itself is shown only to the family, by the UI).
 * POST needs a fresh, single-use ed25519 signature (lib/tree/links.ts treeMessage) from the acting wallet:
 *  - relate / unrelate: the wallet must own the estate (read from the chain);
 *  - hide: the signer hides or shows only themselves (the flag is stored for the signing wallet).
 * The demo (mock mode) keeps the tree in the browser, so writes are refused there.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { handler, HttpError, isChainMode, json, parseJson, rateLimit } from "@/lib/api/http";
import { verifyEd25519 } from "@/lib/legacy/server/auth";
import { fetchAccountRaw } from "@/lib/chain/reads";
import { key, type Raw } from "@/lib/chain/decoders";
import { PERSON_ID, RELATIONSHIP_KINDS, relationshipId, TREE_MAX_SKEW_MS, treeBody, treeMessage } from "../links";
import type { RelationshipKind } from "../types";
import { getLinks, putLink, removeLink, setHiddenFlag } from "./store";

const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const sig = z.string().regex(/^[0-9a-f]{128}$/);
const person = z.string().regex(PERSON_ID);
const signed = { estate: addr, wallet: addr, ts: z.number().int().positive(), sig };
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("relate"), ...signed, kind: z.enum(RELATIONSHIP_KINDS as [RelationshipKind, ...RelationshipKind[]]), from: person, to: person }),
  z.object({ action: z.literal("unrelate"), ...signed, id: z.string().min(1).max(200) }),
  z.object({ action: z.literal("hide"), ...signed, hidden: z.boolean() }),
]);
export type TreePost = z.infer<typeof body>;

export interface TreeRouteDeps {
  fetchRaw(type: "Estate", address: string): Promise<Raw | null>;
  now(): number;
  chain(): boolean;
}
const defaults: TreeRouteDeps = { fetchRaw: fetchAccountRaw, now: () => Date.now(), chain: isChainMode };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const seen = new Map<string, number>();

export function treeRoutes(deps: TreeRouteDeps = defaults) {
  const GET = handler(async (req) => {
    rateLimit(req, "tree", 60);
    const estate = addr.parse(new URL(req.url).searchParams.get("estate"));
    return json(await getLinks(estate));
  });

  const POST = handler(async (req) => {
    rateLimit(req, "tree-write", 30);
    if (!deps.chain()) throw new HttpError(503, "The demo keeps the family tree in the browser.", "unavailable");
    const b = await parseJson(req, body, 4_000);
    const now = deps.now();
    if (Math.abs(now - b.ts) > TREE_MAX_SKEW_MS) throw new HttpError(401, "This request is too old. Please try again.", "stale");
    const signedBody = b.action === "relate" ? treeBody({ action: b.action, kind: b.kind, from: b.from, to: b.to })
      : b.action === "unrelate" ? treeBody({ action: b.action, id: b.id }) : treeBody({ action: b.action, hidden: b.hidden });
    if (!verifyEd25519(b.wallet, treeMessage(b.action, b.estate, b.wallet, b.ts, sha(signedBody)), b.sig)) throw new HttpError(401, "The signature does not match this wallet.", "unauthorized");
    for (const [k, t] of seen) if (now - t > TREE_MAX_SKEW_MS * 2) seen.delete(k);
    if (seen.has(b.sig)) throw new HttpError(401, "This request was already used. Please try again.", "replay");
    seen.set(b.sig, now);

    const estate = await deps.fetchRaw("Estate", b.estate);
    if (!estate) throw new HttpError(404, "Estate not found on-chain.");
    const at = Math.floor(now / 1000);

    if (b.action === "hide") {
      await setHiddenFlag(b.estate, b.wallet, b.hidden, at);
      return json({ ok: true });
    }
    if (key(estate, "owner") !== b.wallet) throw new HttpError(403, "Only the estate owner can change the family's relationships.", "forbidden");

    if (b.action === "relate") {
      if (b.from === b.to) throw new HttpError(400, "Choose two different people.");
      const current = await getLinks(b.estate);
      if (b.kind === "parentOf" && current.relationships.some((r) => r.id === relationshipId("parentOf", b.to, b.from))) {
        throw new HttpError(409, "That would make someone their own grandparent.", "BadStatus");
      }
      const id = relationshipId(b.kind, b.from, b.to);
      const existing = current.relationships.find((r) => r.id === id);
      const rel = existing ?? { id, kind: b.kind, from: b.from, to: b.to, declaredBy: b.wallet, declaredAt: at };
      if (!existing) await putLink(b.estate, rel);
      return json({ ok: true, relationship: rel });
    }

    const current = await getLinks(b.estate);
    const existing = current.relationships.find((r) => r.id === b.id);
    if (!existing) throw new HttpError(404, "That relationship is not on the tree.", "not_found");
    await removeLink(b.estate, b.id, b.wallet, at, existing);
    return json({ ok: true });
  });

  return { GET, POST };
}
