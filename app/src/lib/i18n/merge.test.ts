import { describe, expect, it } from "vitest";
import { landing } from "@/content/landing";
import { common } from "@/content/common";
import { screens } from "@/content/screens";
import { pay } from "@/content/pay";
import { assistant } from "@/content/assistant";
import { guardians } from "@/content/guardians";
import { assets } from "@/content/assets";
import { af } from "@/content/i18n/af";
import { st } from "@/content/i18n/st";
import { zu } from "@/content/i18n/zu";
import { mergeCopy } from "./merge";
import { isLocale } from "./locales";

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

/** Walks English and a translation side by side, yielding every translated string with its English original. */
function* pairs(en: unknown, tr: unknown, path = ""): Generator<[string, string, string]> {
  if (typeof en === "string" && typeof tr === "string") { yield [path, en, tr]; return; }
  if (en && tr && typeof en === "object" && typeof tr === "object") {
    for (const k of Object.keys(tr)) yield* pairs((en as Record<string, unknown>)[k], (tr as Record<string, unknown>)[k], `${path}.${k}`);
  }
}

describe("mergeCopy", () => {
  it("lays a partial translation over English and keeps untranslated slots", () => {
    const out = mergeCopy(screens.estate, af.screens.estate);
    expect(out.eyebrow).toBe("Boedel");
    expect(out.rate).toBe(screens.estate.rate);
    expect(out.scheduled.forWho).toBe(screens.estate.scheduled.forWho);
  });
  it("ignores empty strings and arrays of the wrong length", () => {
    expect(mergeCopy({ a: "x", b: ["1", "2"] }, { a: "", b: ["only"] })).toEqual({ a: "x", b: ["1", "2"] });
  });
  it("recognises the four locales only", () => {
    expect(["en", "zu", "st", "af"].every(isLocale)).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });
});

describe.each([["af", af], ["st", st], ["zu", zu]] as const)("%s translation", (_name, t) => {
  it("keeps every {placeholder} of the English copy", () => {
    const english = { landing, common, screens, pay, assistant, guardians, assets };
    const translated = { landing: t.landing, common: t.common, screens: t.screens, pay: t.pay, assistant: t.assistant, guardians: t.guardians, assets: t.assets };
    for (const [path, en, tr] of pairs(english, translated)) expect(placeholders(tr), path).toBe(placeholders(en));
  });

  it("translates every guardians and assets key, every contract error name and the newer common keys", () => {
    const missing: string[] = [];
    const walk = (en: unknown, tr: unknown, path: string) => {
      if (typeof en === "string") { if (typeof tr !== "string" || !tr.trim()) missing.push(path); return; }
      if (Array.isArray(en)) {
        if (!Array.isArray(tr) || tr.length !== en.length) missing.push(path);
        else en.forEach((x, i) => walk(x, tr[i], `${path}[${i}]`));
        return;
      }
      if (en && typeof en === "object") for (const k of Object.keys(en)) walk((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
    };
    walk(guardians, t.guardians, "guardians");
    walk(assets, t.assets, "assets");
    walk(common, t.common, "common");
    walk(screens.start.form.roles, t.screens.start?.form?.roles, "screens.start.form.roles");
    expect(missing).toEqual([]);
    // Unknown keys would be typos that silently show English.
    for (const k of Object.keys(t.guardians.errors)) expect(Object.keys(guardians.errors), k).toContain(k);
  });

  it("keeps brand names, USD₮ and numbers as they are in guardians and assets", () => {
    for (const [path, en, tr] of pairs({ guardians, assets }, { guardians: t.guardians, assets: t.assets })) {
      for (const keep of ["Heirloom", "USD₮", "Solana"]) if (en.includes(keep)) expect(tr, `${path} keeps ${keep}`).toContain(keep);
      // 6.4 and 6,4 are the same number (Afrikaans writes a decimal comma).
      const digits = (s: string) => (s.replace(/(\d),(\d)/g, "$1.$2").match(/\d+(?:\.\d+)?/g) ?? []).sort().join(",");
      expect(digits(tr), path).toBe(digits(en));
    }
  });

  it("translates the whole sidebar and chat home (only the agent-read drafts stay English)", () => {
    const missing: string[] = [];
    const walk = (en: unknown, tr: unknown, path: string) => {
      if (/composer\.(sendMoneyDraft|defaultMessage)/.test(path)) return;
      if (typeof en === "string") { if (typeof tr !== "string" || !tr) missing.push(path); return; }
      if (en && typeof en === "object") for (const k of Object.keys(en)) walk((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
    };
    walk(assistant.shell, t.assistant.shell, "shell");
    walk(assistant.home, t.assistant.home, "home");
    expect(missing).toEqual([]);
  });
});
