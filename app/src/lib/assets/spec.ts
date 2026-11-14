/**
 * Richer assets for sale (15 Nov 2026): labelled photos and a spec sheet, both kept off-chain with the photos and
 * bound to the on-chain AssetMedia.photos_root through `mediaRootHex`. Shared by the browser, the photo API, the
 * mock service (the contract's twin) and the chain service, so all of them compute the same root.
 *
 * Media root (32 bytes, hex):
 *   - no photos and an empty spec sheet → 32 zero bytes (the program's default);
 *   - otherwise SHA-256( 0x02 ‖ photo SHA-256 digests in display order (32 bytes each)
 *                        ‖ one label byte per photo (index in PHOTO_LABELS, 0xff = no label)
 *                        ‖ SHA-256 of the spec sheet as canonical JSON (32 zero bytes when empty) ).
 *   The leading 0x02 keeps it apart from the first version (photos only). Changing, adding, removing or
 *   reordering a photo, relabelling one or editing any spec value changes the root.
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../agent/hash";
import type { AssetKind } from "../guardians/types";

/* ---------- photo labels ---------- */

export const PHOTO_LABELS = ["Front", "Rear", "Side", "Interior", "Dashboard", "Engine", "Boot", "Wheels", "Damage", "Other"] as const;
export type PhotoLabel = (typeof PHOTO_LABELS)[number];
export const isPhotoLabel = (v: unknown): v is PhotoLabel => typeof v === "string" && (PHOTO_LABELS as readonly string[]).includes(v);

/* ---------- spec sheet ---------- */

export const TRANSMISSIONS = ["Manual", "Automatic"] as const;
export const FUELS = ["Petrol", "Diesel", "Hybrid", "Electric", "Other"] as const;
export const SERVICE_HISTORIES = ["Full", "Partial", "None"] as const;
export const CONDITION_CATEGORIES = ["A", "B", "C", "D"] as const;
export const DRIVES = ["FWD", "RWD", "AWD", "4WD"] as const;
/** Condition of anything that is not a vehicle (vehicles use the inspection rating A–D). */
export const CONDITIONS = ["Excellent", "Good", "Fair", "NeedsRepair"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const dec = (max: number) => z.number().min(0).max(max).multipleOf(0.1);

/** Every field is optional: an owner fills what they know. Bounds are generous but stop nonsense. */
export const specSchema = z.object({
  // key facts
  mileageKm: int(0, 2_000_000).optional(),
  driveType: text(20).optional(),            // "4x2", "4x4"
  transmission: z.enum(TRANSMISSIONS).optional(),
  fuel: z.enum(FUELS).optional(),
  consumptionL100: dec(50).optional(),       // litres per 100 km
  engineCc: int(1, 10_000).optional(),
  // details
  make: text(40).optional(),
  model: text(40).optional(),
  variant: text(60).optional(),
  year: int(1900, 2100).optional(),
  bodyType: text(30).optional(),             // "Sedan", "Road bike"
  colour: text(30).optional(),
  seats: int(1, 60).optional(),
  doors: int(0, 10).optional(),
  // condition
  serviceHistory: z.enum(SERVICE_HISTORIES).optional(),
  conditionCategory: z.enum(CONDITION_CATEGORIES).optional(),
  spareKey: z.boolean().optional(),
  roadworthyNotes: text(400).optional(),
  // performance
  zeroTo100S: dec(60).optional(),
  topSpeedKmh: int(1, 500).optional(),
  powerKw: int(1, 2_000).optional(),
  fuelTankL: int(1, 500).optional(),
  cylinderLayout: text(20).optional(),       // "I4", "V6"
  gears: int(1, 12).optional(),
  drive: z.enum(DRIVES).optional(),
  // furniture, jewellery, electronics, other (15 Nov 2026: a spec sheet for every kind, each in its own form)
  brand: text(40).optional(),
  material: text(60).optional(),             // "Solid oak", "Leather"
  dimensionsCm: text(40).optional(),         // "180 x 90 x 76"
  weightKg: dec(10_000).optional(),
  pieces: int(1, 500).optional(),            // "a table and six chairs" = 7
  metal: text(30).optional(),                // "Yellow gold"
  purity: text(20).optional(),               // "18 ct", "925"
  weightG: dec(100_000).optional(),
  stones: text(120).optional(),              // "One 0.5 ct diamond"
  certificate: z.boolean().optional(),       // valuation or grading certificate
  keySpecs: text(200).optional(),            // "65-inch 4K, 3 HDMI"
  includes: text(200).optional(),            // "Remote, original box, charger"
  warrantyUntil: text(30).optional(),        // "March 2027"
  condition: z.enum(CONDITIONS).optional(),
  proofOfPurchase: z.boolean().optional(),
  knownFaults: text(400).optional(),
}).strict();

export type AssetSpec = z.infer<typeof specSchema>;
export type SpecKey = keyof AssetSpec;

export type SpecSection = "keyFacts" | "details" | "condition" | "performance";
export const SPEC_SECTIONS: readonly SpecSection[] = ["keyFacts", "details", "condition", "performance"];
export type SpecLayout = Partial<Record<SpecSection, readonly SpecKey[]>>;

/** The vehicle sheet (cars and motorbikes): a key-facts row, then Details, Condition and Performance. */
export const SPEC_LAYOUT = {
  keyFacts: ["mileageKm", "driveType", "transmission", "fuel", "consumptionL100", "engineCc"],
  details: ["make", "model", "variant", "year", "bodyType", "colour", "seats", "doors"],
  condition: ["serviceHistory", "conditionCategory", "spareKey", "roadworthyNotes"],
  performance: ["zeroTo100S", "topSpeedKmh", "powerKw", "fuelTankL", "cylinderLayout", "gears", "drive"],
} as const satisfies SpecLayout;

/** Each kind of asset has its own sheet; a field appears at most once per sheet. */
export const SPEC_LAYOUTS: Record<AssetKind, SpecLayout> = {
  Car: SPEC_LAYOUT,
  Motorbike: SPEC_LAYOUT,
  Furniture: {
    keyFacts: ["material", "dimensionsCm", "pieces", "condition"],
    details: ["brand", "colour", "year", "weightKg"],
    condition: ["proofOfPurchase", "knownFaults"],
  },
  Jewellery: {
    keyFacts: ["metal", "purity", "weightG", "stones"],
    details: ["brand", "colour", "year"],
    condition: ["condition", "certificate", "proofOfPurchase", "knownFaults"],
  },
  Electronics: {
    keyFacts: ["brand", "model", "year", "condition"],
    details: ["keySpecs", "colour", "dimensionsCm", "includes"],
    condition: ["warrantyUntil", "proofOfPurchase", "knownFaults"],
  },
  Other: {
    keyFacts: ["brand", "model", "year", "condition"],
    details: ["material", "colour", "dimensionsCm", "weightKg", "includes"],
    condition: ["proofOfPurchase", "knownFaults"],
  },
};

export const specKeysFor = (kind: AssetKind): SpecKey[] => SPEC_SECTIONS.flatMap((s) => [...(SPEC_LAYOUTS[kind][s] ?? [])]);

/** Fields filled in that do not belong on this kind's sheet (a motorbike has no "metal"); empty = fine. */
export function foreignSpecKeys(kind: AssetKind, spec?: AssetSpec | null): SpecKey[] {
  const allowed = new Set(specKeysFor(kind));
  return (Object.keys(cleanSpec(spec) ?? {}) as SpecKey[]).filter((k) => !allowed.has(k));
}

/** Drops empty values (blank text, missing numbers); returns undefined for a sheet with nothing in it. */
export function cleanSpec(spec: AssetSpec | Record<string, unknown> | null | undefined): AssetSpec | undefined {
  if (!spec || typeof spec !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (typeof v === "number" && !Number.isFinite(v))) continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return Object.keys(out).length ? (out as AssetSpec) : undefined;
}

/** What the API and the services accept: blanks are dropped first (forms send ""), then the sheet is checked. */
export const specInputSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) ? cleanSpec(v as Record<string, unknown>) ?? {} : v),
  specSchema,
);

/** Cleans and validates a spec sheet (throws a ZodError on bad input); undefined when empty. */
export function parseSpec(raw: unknown): AssetSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  return cleanSpec(specInputSchema.parse(raw));
}

export const hasSpec = (spec?: AssetSpec | null) => !!cleanSpec(spec);

/* ---------- hashes ---------- */

const ZERO = "0".repeat(64);
/** Root stored on-chain when an asset has no photos and no spec sheet. */
export const EMPTY_MEDIA_ROOT = ZERO;

/** SHA-256 of the spec sheet as canonical JSON (keys sorted, no whitespace); zeros when empty. */
export async function specHashHex(spec?: AssetSpec | null): Promise<string> {
  const clean = cleanSpec(spec);
  return clean ? sha256Hex(canonicalJson(clean)) : ZERO;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const hexInto = (out: Uint8Array, at: number, hex: string) => {
  if (!HEX64.test(hex)) throw new Error("Each hash must be a 64-character SHA-256 hex string.");
  for (let j = 0; j < 32; j++) out[at + j] = Number.parseInt(hex.slice(j * 2, j * 2 + 2), 16);
};

/** The asset's media root (see the header). Browser and Node (WebCrypto). */
export async function mediaRootHex(photos: readonly { sha256: string; label?: PhotoLabel | null }[], spec?: AssetSpec | null): Promise<string> {
  const specHash = await specHashHex(spec);
  if (photos.length === 0 && specHash === ZERO) return ZERO;
  const n = photos.length;
  const bytes = new Uint8Array(1 + n * 32 + n + 32);
  bytes[0] = 0x02;
  photos.forEach((p, i) => hexInto(bytes, 1 + i * 32, p.sha256));
  photos.forEach((p, i) => { bytes[1 + n * 32 + i] = p.label && isPhotoLabel(p.label) ? PHOTO_LABELS.indexOf(p.label) : 0xff; });
  hexInto(bytes, 1 + n * 33, specHash);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A copy of a photo (or draft) with its label set, or removed when `label` is empty. */
export function withLabel<T extends { label?: PhotoLabel }>(x: T, label?: PhotoLabel | "" | null): T {
  const out = { ...x };
  if (label) out.label = label; else delete out.label;
  return out;
}

/* ---------- gallery grouping ---------- */

/** Photos grouped by label, in PHOTO_LABELS order; unlabelled photos count as "Other". Keeps each photo's index. */
export function groupByLabel<T extends { label?: PhotoLabel | null }>(photos: readonly T[]): { label: PhotoLabel; items: { photo: T; index: number }[] }[] {
  return PHOTO_LABELS
    .map((label) => ({ label, items: photos.map((photo, index) => ({ photo, index })).filter(({ photo }) => (photo.label ?? "Other") === label) }))
    .filter((g) => g.items.length > 0);
}
