import { describe, expect, it } from "vitest";
import { DEMO_WILL } from "./agent/canned";
import { screens } from "@/content/screens";
import { af } from "@/content/i18n/af";
import { planSummary, ruleKey, timingChanged, withOwnerSummary } from "./will-summary";
import type { WillDraft } from "./types";

const words = screens.will.review;
const f = {
  category: (c: string) => c, every: (e: string) => e, usd: (n: number) => `${n} USD₮`, need: 2,
};
/** The will screen's toggle: the owner's choice for one rule (by key), everything else as the agent drafted it. */
const toggle = (d: WillDraft, idx: number, now: boolean) => d.rules.map((r, i) => (i === idx ? { ...r, startsNow: now } : r));

describe("the review summary follows the Now / After toggles", () => {
  it("keeps the agent's summary while the owner changes nothing", () => {
    const { draft, edited } = withOwnerSummary(DEMO_WILL, DEMO_WILL.rules, words, f);
    expect(edited).toBe(false);
    expect(draft.plainLanguageSummary).toBe(DEMO_WILL.plainLanguageSummary);
  });

  it("rewrites the summary when a rule is switched from After to Now", () => {
    // Rule 0: Lerato's university fees, drafted as "after I'm gone".
    expect(DEMO_WILL.rules[0].startsNow).toBe(false);
    const { draft, edited } = withOwnerSummary(DEMO_WILL, toggle(DEMO_WILL, 0, true), words, f);
    expect(edited).toBe(true);
    expect(draft.rules[0].startsNow).toBe(true);
    const [now, later] = draft.plainLanguageSummary.split(" After you're gone");
    expect(now).toContain("Starting now, while you're here: Lerato (tuition)");
    expect(later).not.toContain("Lerato (tuition)");
    expect(later).toContain("Sipho (tuition)");
    expect(draft.plainLanguageSummary).toContain("once 2 trusted people confirm your passing and 14 days go by");
  });

  it("rewrites the summary when a rule is switched from Now to After, scheduled payments included", () => {
    // Rule 1: Lerato's residence rent, scheduled and drafted as "now".
    const { draft } = withOwnerSummary(DEMO_WILL, toggle(DEMO_WILL, 1, false), words, f);
    const later = draft.plainLanguageSummary.split(" After you're gone")[1];
    expect(later).toContain("Lerato (accommodation, 300 USD₮ every month)");
    expect(draft.plainLanguageSummary.split(" After you're gone")[0]).not.toContain("accommodation");
  });

  it("says when nothing starts now, or nothing waits", () => {
    const allLater = DEMO_WILL.rules.map((r) => ({ ...r, startsNow: false }));
    expect(planSummary({ ...DEMO_WILL, rules: allLater }, words, f)).toMatch(/^Nothing starts now\. After you're gone/);
    const allNow = DEMO_WILL.rules.map((r) => ({ ...r, startsNow: true }));
    expect(planSummary({ ...DEMO_WILL, rules: allNow }, words, f)).toContain("Nothing waits until you're gone: every rule starts now.");
  });

  it("names the car's floors", () => {
    expect(planSummary(DEMO_WILL, words, f)).toContain("2017 Toyota Corolla 1.8 Exclusive CVT is sold for at least 12500 USD₮, or at least 10500 USD₮");
  });

  it("counts a ready-made bill the agent never saw as a change", () => {
    const bill = { ...DEMO_WILL.rules[3], beneficiaryLabel: "Gogo", category: "General" as const };
    expect(timingChanged(DEMO_WILL.rules, [...DEMO_WILL.rules, bill])).toBe(true);
    expect(withOwnerSummary(DEMO_WILL, [...DEMO_WILL.rules, bill], words, f).draft.plainLanguageSummary).toContain("Gogo (general)");
  });

  it("switching a rule back restores the agent's summary", () => {
    const rules = toggle(DEMO_WILL, 0, true).map((r, i) => (i === 0 ? { ...r, startsNow: DEMO_WILL.rules[0].startsNow } : r));
    expect(timingChanged(DEMO_WILL.rules, rules)).toBe(false);
    expect(ruleKey(rules[0])).toBe("Lerato (daughter)|Tuition|claim");
  });

  it("has every summary line in Afrikaans with the same placeholders", () => {
    const afReview = af.screens!.will!.review as Record<string, string>;
    for (const k of ["summaryEdited", "summaryNow", "summaryNoneNow", "summaryLater", "summaryNoneLater", "summaryItem", "summaryItemRecurring", "summaryAsset"] as const) {
      expect(afReview[k], k).toBeTruthy();
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(ph(afReview[k]), k).toEqual(ph(words[k]));
    }
  });
});
