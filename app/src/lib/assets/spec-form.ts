/**
 * The spec sheet edit form's model: every field as text (what the inputs hold) and back. Accepts South African
 * number input: spaces or commas as thousands separators in whole numbers ("124 455"), and a decimal comma in
 * one-decimal fields ("6,4").
 */
import { CONDITION_CATEGORIES, DRIVES, FUELS, SERVICE_HISTORIES, SPEC_LAYOUT, specInputSchema, TRANSMISSIONS, type AssetSpec, type SpecKey } from "./spec";

export type SpecDraft = Record<SpecKey, string>;

export const INT_FIELDS: readonly SpecKey[] = ["mileageKm", "engineCc", "year", "seats", "doors", "topSpeedKmh", "powerKw", "fuelTankL", "gears"];
export const DECIMAL_FIELDS: readonly SpecKey[] = ["consumptionL100", "zeroTo100S"];
export const CHOICES: Partial<Record<SpecKey, readonly string[]>> = {
  transmission: TRANSMISSIONS, fuel: FUELS, serviceHistory: SERVICE_HISTORIES, conditionCategory: CONDITION_CATEGORIES, drive: DRIVES,
  spareKey: ["yes", "no"],
};
export const LONG_TEXT_FIELDS: readonly SpecKey[] = ["roadworthyNotes"];

const ALL_KEYS = Object.values(SPEC_LAYOUT).flat() as SpecKey[];

export function specToDraft(spec?: AssetSpec): SpecDraft {
  const out = {} as SpecDraft;
  for (const k of ALL_KEYS) {
    const v = spec?.[k];
    out[k] = v === undefined ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
  }
  return out;
}

/** Text → spec sheet. Returns the keys that are not valid (empty list = ok); blanks are left out. */
export function draftToSpec(draft: Partial<SpecDraft>): { spec?: AssetSpec; invalid: SpecKey[] } {
  const raw: Record<string, unknown> = {};
  const invalid = new Set<SpecKey>();
  for (const k of ALL_KEYS) {
    const t = (draft[k] ?? "").trim();
    if (!t) continue;
    if (INT_FIELDS.includes(k)) {
      const n = /^\d[\d\s,]*$/.test(t) ? Number(t.replace(/[\s,]/g, "")) : Number.NaN;
      if (Number.isFinite(n)) raw[k] = n; else invalid.add(k);
    } else if (DECIMAL_FIELDS.includes(k)) {
      const n = /^\d+([.,]\d+)?$/.test(t) ? Number(t.replace(",", ".")) : Number.NaN;
      if (Number.isFinite(n)) raw[k] = n; else invalid.add(k);
    } else if (k === "spareKey") {
      raw[k] = t === "yes";
    } else {
      raw[k] = t;
    }
  }
  const parsed = specInputSchema.safeParse(raw);
  if (!parsed.success) for (const issue of parsed.error.issues) if (typeof issue.path[0] === "string") invalid.add(issue.path[0] as SpecKey);
  if (invalid.size) return { invalid: ALL_KEYS.filter((k) => invalid.has(k)) };
  const data = parsed.data ?? {};
  return { spec: Object.keys(data).length ? data : undefined, invalid: [] };
}

/** A starting draft for a new vehicle from the valuation fields the owner already typed. */
export function draftFromVehicle(v: { make?: string; model?: string; year?: string; mileage?: string }): SpecDraft {
  return { ...specToDraft(), make: v.make ?? "", model: v.model ?? "", year: v.year ?? "", mileageKm: v.mileage ?? "" };
}
