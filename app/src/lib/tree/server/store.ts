import "server-only";
/**
 * Family links (relationships and hidden flags) in Supabase (supabase/migrations/0006_family_links.sql), or in memory
 * when Supabase is not configured (then they last as long as the server instance; the browser that wrote them keeps
 * its own copy too, lib/tree/links.ts). The seeded devnet demo estate starts with default relationships; removing one
 * stores a tombstone (`removed`), so it stays removed.
 * Photos (plan.md §15.11) live beside them (supabase/migrations/0007_family_photos.sql, or memory): one 256×256 WebP
 * per person, at most 60 KB; removing one deletes the row.
 */
import { getSupabase } from "@/lib/supabase";
import type { Base58 } from "@/lib/types";
import type { Relationship, RelationshipKind } from "../types";
import { defaultRelationships, type FamilyLinks } from "../links";
import type { FamilyPhotos, StoredPhoto } from "../photos";

interface Row { estate: string; id: string; kind: string; from_id: string; to_id: string; created_by: string; created_at: number; removed: boolean }

const mem = {
  links: new Map<string, Map<string, Row>>(),
  hidden: new Map<string, Map<Base58, boolean>>(),
  photos: new Map<string, Map<string, StoredPhoto>>(),
};
/** Photos kept per estate (a family is far smaller; this bounds memory and the GET). */
const MAX_PHOTOS = 200;
const MAX_PER_ESTATE = 500;

function warn(what: string, err: { message: string } | null) {
  if (err) console.warn(`[family_links] ${what} failed: ${err.message}`);
}

const toRel = (r: Row): Relationship => ({ id: r.id, kind: r.kind as RelationshipKind, from: r.from_id, to: r.to_id, declaredBy: r.created_by, declaredAt: Number(r.created_at) });

/** Defaults, overridden by stored rows (a stored row with `removed` hides the default). */
function combine(estate: Base58, rows: Row[], hidden: Base58[]): FamilyLinks {
  const out = new Map(defaultRelationships(estate).map((r) => [r.id, r] as const));
  for (const r of rows) { if (r.removed) out.delete(r.id); else out.set(r.id, toRel(r)); }
  return { relationships: [...out.values()], hidden };
}

export async function getLinks(estate: Base58): Promise<FamilyLinks> {
  const sb = getSupabase();
  if (!sb) {
    const hidden = [...(mem.hidden.get(estate) ?? new Map()).entries()].filter(([, h]) => h).map(([w]) => w);
    return combine(estate, [...(mem.links.get(estate)?.values() ?? [])], hidden);
  }
  const [links, hidden] = await Promise.all([
    sb.from("family_links").select("*").eq("estate", estate).limit(MAX_PER_ESTATE),
    sb.from("family_hidden").select("wallet, hidden").eq("estate", estate).eq("hidden", true).limit(MAX_PER_ESTATE),
  ]);
  warn("getLinks", links.error);
  warn("getHidden", hidden.error);
  return combine(estate, (links.data ?? []) as Row[], ((hidden.data ?? []) as { wallet: string }[]).map((h) => h.wallet));
}

export async function putLink(estate: Base58, r: Relationship): Promise<void> {
  await write({ estate, id: r.id, kind: r.kind, from_id: r.from, to_id: r.to, created_by: r.declaredBy, created_at: r.declaredAt, removed: false });
}

export async function removeLink(estate: Base58, id: string, by: Base58, at: number, existing: Relationship): Promise<void> {
  await write({ estate, id, kind: existing.kind, from_id: existing.from, to_id: existing.to, created_by: by, created_at: at, removed: true });
}

async function write(row: Row): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    const m = mem.links.get(row.estate) ?? new Map<string, Row>();
    m.set(row.id, row);
    if (m.size > MAX_PER_ESTATE) m.delete(m.keys().next().value!);
    mem.links.set(row.estate, m);
    return;
  }
  const { error } = await sb.from("family_links").upsert(row, { onConflict: "estate,id" });
  warn("write", error);
  if (error) throw new Error("The relationship could not be saved. Please try again.");
}

export async function setHiddenFlag(estate: Base58, wallet: Base58, hidden: boolean, at: number): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    const m = mem.hidden.get(estate) ?? new Map<Base58, boolean>();
    m.set(wallet, hidden);
    mem.hidden.set(estate, m);
    return;
  }
  const { error } = await sb.from("family_hidden").upsert({ estate, wallet, hidden, updated_at: at }, { onConflict: "estate,wallet" });
  warn("setHidden", error);
  if (error) throw new Error("Your choice could not be saved. Please try again.");
}

/* ---------- photos ---------- */

interface PhotoRow { estate: string; person: string; data: string; created_by: string; created_at: number }

export async function getPhotos(estate: Base58): Promise<FamilyPhotos> {
  const sb = getSupabase();
  if (!sb) return { photos: Object.fromEntries(mem.photos.get(estate) ?? new Map()) };
  const { data, error } = await sb.from("family_photos").select("person, data, created_by, created_at").eq("estate", estate).limit(MAX_PHOTOS);
  warn("getPhotos", error);
  return { photos: Object.fromEntries(((data ?? []) as Omit<PhotoRow, "estate">[]).map((r) => [r.person, { src: r.data, by: r.created_by, at: Number(r.created_at) }])) };
}

export async function putPhoto(estate: Base58, person: string, photo: StoredPhoto): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    const m = mem.photos.get(estate) ?? new Map<string, StoredPhoto>();
    m.delete(person);
    m.set(person, photo);
    if (m.size > MAX_PHOTOS) m.delete(m.keys().next().value!);
    mem.photos.set(estate, m);
    return;
  }
  const row: PhotoRow = { estate, person, data: photo.src, created_by: photo.by, created_at: photo.at };
  const { error } = await sb.from("family_photos").upsert(row, { onConflict: "estate,person" });
  warn("putPhoto", error);
  if (error) throw new Error("The photo could not be saved. Please try again.");
}

export async function deletePhoto(estate: Base58, person: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) { mem.photos.get(estate)?.delete(person); return; }
  const { error } = await sb.from("family_photos").delete().eq("estate", estate).eq("person", person);
  warn("deletePhoto", error);
  if (error) throw new Error("The photo could not be removed. Please try again.");
}

/** Tests only. */
export function resetTreeMemory() { mem.links.clear(); mem.hidden.clear(); mem.photos.clear(); }
