import { describe, expect, it } from "vitest";
import { fullName, shortName } from "./names";
import { DEMO_PERSONAS } from "./wallet/personas";
import { DEMO_PERSONAS as CAST, DEMO_GUARDIANS } from "./service/mock";

describe("demo names", () => {
  it("shortens each title the same way everywhere", () => {
    expect(shortName("Adv. Thandi Ndlovu")).toBe("Adv. Ndlovu");
    expect(shortName("Ms. Anita Pillay (attorney)")).toBe("Ms. Pillay");
    expect(shortName("Adv. Priya Naidoo")).toBe("Adv. Naidoo");
    expect(shortName("Uncle Bongani Mokoena")).toBe("Uncle Bongani");
    expect(shortName("Aunt Zodwa Mokoena")).toBe("Aunt Zodwa");
    expect(shortName("Cousin Kagiso Mokoena")).toBe("Cousin Kagiso");
    expect(shortName("Lerato Mokoena (daughter)")).toBe("Lerato");
    expect(shortName("Kagiso")).toBe("Kagiso");
    expect(shortName("")).toBe("");
    expect(fullName("Thabo Mokoena (dad)")).toBe("Thabo Mokoena");
  });

  it("gives the wallet personas the same full names as the mock estate's cast", () => {
    expect(DEMO_PERSONAS.map((p) => fullName(p.label))).toEqual(CAST.map((c) => c.label));
  });

  it("uses the short forms the guided chat already uses for the three trusted people", () => {
    expect(CAST.filter((c) => c.role === "verifier").map((c) => shortName(c.label))).toEqual(["Adv. Ndlovu", "Ms. Pillay", "Uncle Bongani"]);
    expect(shortName(DEMO_GUARDIANS.kagiso.name)).toBe("Cousin Kagiso");
  });
});
