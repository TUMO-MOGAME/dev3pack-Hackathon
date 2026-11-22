import "server-only";
/**
 * /api/tree/photo logic (app/api/tree/photo/route.ts re-exports it): GET an estate's tree photos, POST a signed change
 * (plan.md §15.11).
 *
 * GET is for members only, with a read pass (lib/access). POST needs a fresh, single-use
 * ed25519 signature (lib/tree/links.ts treeMessage, action "photo") from the acting wallet over the person and the
 * photo, then:
 *  - the photo is a WebP data URL of at most 60 KB (lib/tree/photos.ts checkPhoto; 415 / 413 otherwise);
 *  - consent (photoConsent): a living adult sets or removes only their own photo; the estate's owner (read from the
 *    chain) does it for a child, someone who has passed, someone without a wallet or an organisation. What the
 *    server knows of a person (born, passed, organisation) is the family the estate declared (the seeded devnet demo
 *    estate's), so anyone else counts as a living adult; a hidden person gets no photo.
 * The demo (mock mode) keeps photos in the browser, so writes are refused there (503), like /api/tree.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { handler, HttpError, isChainMode, json, parseJson, rateLimit } from "@/lib/api/http";
import { verifyEd25519 } from "@/lib/legacy/server/auth";
import { fetchAccountRaw } from "@/lib/chain/reads";
import { key, type Raw } from "@/lib/chain/decoders";
import { DEVNET_DEMO_ESTATE, DEVNET_DEMO_FALLBACK_KINDS } from "@/lib/chain/demo-estate";
import { defaultPeople, PERSON_ID, TREE_MAX_SKEW_MS, treeBody, treeMessage } from "../links";
import { checkPhoto, PHOTO_MAX_BODY, photoConsent, type PhotoSubject } from "../photos";
import { getLinks, getPhotos, putPhoto } from "./store";
import { requireMember, type MemberCheck } from "@/lib/access/server";

const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const body = z.object({
  action: z.literal("photo"),
  estate: addr, wallet: addr, ts: z.number().int().positive(), sig: z.string().regex(/^[0-9a-f]{128}$/),
  person: z.string().regex(PERSON_ID),
  /** A WebP data URL, or null to remove the photo. Checked by checkPhoto below for a clear 413 / 415. */
  photo: z.string().nullable(),
});
export type TreePhotoPost = z.infer<typeof body>;

export interface PhotoRouteDeps {
  member?: MemberCheck;
  fetchRaw(type: "Estate", address: string): Promise<Raw | null>;
  now(): number;
  chain(): boolean;
}
const defaults: PhotoRouteDeps = { fetchRaw: fetchAccountRaw, now: () => Date.now(), chain: isChainMode };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const seen = new Map<string, number>();

/** What the server knows of a person on this estate's tree: the declared family (demo estate) and hidden flags. */
async function subjectOf(estate: string, person: string): Promise<PhotoSubject> {
  const d = defaultPeople(estate).find((p) => p.id === person);
  const hidden = (await getLinks(estate)).hidden.includes(person);
  const org = !!d?.org || (estate === DEVNET_DEMO_ESTATE && DEVNET_DEMO_FALLBACK_KINDS[person] === "charity");
  return {
    id: person, wallets: d?.wallets ?? (person.startsWith("local:") ? [] : [person]),
    born: d?.born, passed: d?.passed, hidden, org,
  };
}

export function photoRoutes(deps: PhotoRouteDeps = defaults) {
  const GET = handler(async (req) => {
    rateLimit(req, "tree-photo", 60);
    const estate = addr.parse(new URL(req.url).searchParams.get("estate"));
    await requireMember(req, estate, deps.member);
    return json(await getPhotos(estate));
  });

  const POST = handler(async (req) => {
    rateLimit(req, "tree-photo-write", 30);
    if (!deps.chain()) throw new HttpError(503, "The demo keeps the family's photos in the browser.", "unavailable");
    const b = await parseJson(req, body, PHOTO_MAX_BODY + 1_000);
    const now = deps.now();
    if (Math.abs(now - b.ts) > TREE_MAX_SKEW_MS) throw new HttpError(401, "This request is too old. Please try again.", "stale");
    const signed = treeBody({ action: "photo", person: b.person, photo: b.photo });
    if (!verifyEd25519(b.wallet, treeMessage("photo", b.estate, b.wallet, b.ts, sha(signed)), b.sig)) throw new HttpError(401, "The signature does not match this wallet.", "unauthorized");
    for (const [k, t] of seen) if (now - t > TREE_MAX_SKEW_MS * 2) seen.delete(k);
    if (seen.has(b.sig)) throw new HttpError(401, "This request was already used. Please try again.", "replay");
    seen.set(b.sig, now);

    if (b.photo !== null) {
      const why = checkPhoto(b.photo);
      if (why === "size") throw new HttpError(413, "The photo is larger than 60 KB.", "too_large");
      if (why === "type") throw new HttpError(415, "The photo must be a WebP image.", "wrong_type");
    }

    const estate = await deps.fetchRaw("Estate", b.estate);
    if (!estate) throw new HttpError(404, "Estate not found on-chain.");
    const today = new Date(now).getUTCFullYear();
    const subject = await subjectOf(b.estate, b.person);
    if (!photoConsent(subject, b.wallet, key(estate, "owner") === b.wallet, today)) {
      throw new HttpError(403, subject.hidden ? "This person chose to hide from the tree." : "Only they can change their own photo, or the estate owner for a child, someone who has passed or an organisation.", "forbidden");
    }

    // A removal is kept as an empty photo, so it also hides a default drawing (the devnet demo family's) everywhere.
    if (b.photo === null) await putPhoto(b.estate, b.person, { src: "", by: b.wallet, at: Math.floor(now / 1000) });
    else await putPhoto(b.estate, b.person, { src: b.photo, by: b.wallet, at: Math.floor(now / 1000) });
    return json({ ok: true });
  });

  return { GET, POST };
}
