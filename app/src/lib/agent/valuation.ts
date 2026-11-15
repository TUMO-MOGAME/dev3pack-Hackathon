import "server-only";
/**
 * CarBroker valuation: Gemini with Google Search grounding finds public SA listings (ZAR), a second
 * structured call extracts comparables, then plain TS turns them into a USD₮ range with the live FX rate.
 */
import type { CarValuation } from "../types";
import { generate, generateJson, hasGemini } from "./gemini";
import { CAR_BROKER } from "./prompts";
import { comparablesSchema } from "./schemas";
import { cannedValuation } from "./canned";
import { getUsdtZar } from "../fx";
import type { AssetKind } from "../guardians/types";
import { DEMO_FX, estimateValuation } from "../service/mock-valuation";

export interface CarInput { make: string; model: string; year: number; mileageKm: number; condition: string; kind?: AssetKind }

/** Median-based range; trims outliers so one silly listing can't move the price much. */
export function summarize(pricesZar: number[], usdtZar: number): { suggested: number; low: number; high: number } {
  const p = [...pricesZar].filter((x) => x > 0).sort((a, b) => a - b);
  if (p.length === 0) throw new Error("No comparable prices found");
  const q = (f: number) => p[Math.min(p.length - 1, Math.max(0, Math.round(f * (p.length - 1))))];
  const toUsdt = (zar: number) => Math.round(zar / usdtZar / 50) * 50; // round to 50 USD₮
  return { suggested: toUsdt(q(0.5)), low: toUsdt(q(0.2)), high: toUsdt(q(0.8)) };
}

export async function valueCar(car: CarInput): Promise<CarValuation> {
  const bike = car.kind === "Motorbike";
  // Without a key: the fixed car example, or for a motorbike the demo estimate (a Corolla's price would be absurd).
  const example = () => (bike ? estimateValuation(car, DEMO_FX) : cannedValuation());
  if (!hasGemini()) return example();
  const fx = await getUsdtZar();
  const vehicle = bike ? "used motorbike" : "used-car";
  const query = `${car.year} ${car.make} ${car.model}, about ${car.mileageKm.toLocaleString("en-ZA")} km, condition: ${car.condition || "good"}`;

  const searched = await generate({
    system: CAR_BROKER,
    thinking: "low",
    timeoutMs: 45_000,
    config: { tools: [{ googleSearch: {} }] },
    contents: [{ role: "user", parts: [{ text: `Find 4-8 current ${vehicle} listings in South Africa for: ${query}. For each give title, asking price in rand, the site, and the URL.` }] }],
  });
  const sources = (searched.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web).filter((w): w is { uri?: string; title?: string } => Boolean(w?.uri));

  const parsed = await generateJson(comparablesSchema, {
    system: `Extract ${vehicle} comparables from the research notes. Use only prices explicitly stated in rand. Do not invent listings.`,
    thinking: "low",
    contents: [{ role: "user", parts: [{ text: `${bike ? "Motorbike" : "Car"}: ${query}\n\nResearch notes:\n${searched.text ?? ""}\n\nSource URLs:\n${sources.map((s) => `${s.title ?? ""} ${s.uri}`).join("\n")}` }] }],
  });

  if (parsed.comparables.length === 0) {
    const fallback = example();
    return { ...fallback, rationale: `No live listings could be confirmed, so these are example figures. ${fallback.rationale}` };
  }
  const s = summarize(parsed.comparables.map((c) => c.priceZar), fx.usdtZar);
  return {
    suggestedAskingUsdt: s.suggested, lowUsdt: s.low, highUsdt: s.high,
    comparables: parsed.comparables,
    rationale: `${parsed.rationale} Converted at R${fx.usdtZar.toFixed(2)} per USD₮ (${fx.source}). The owner's floor price still binds.`,
  };
}
