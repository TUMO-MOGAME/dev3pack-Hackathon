import { describe, expect, it } from "vitest";
import { draftFromVehicle, draftToSpec, specToDraft } from "./spec-form";
import { DEMO_ASSETS } from "../service/demo-asset-photos";

describe("spec sheet form model", () => {
  it("round-trips the demo sheets", () => {
    for (const a of Object.values(DEMO_ASSETS)) expect(draftToSpec(specToDraft(a.spec))).toEqual({ spec: a.spec, invalid: [] });
  });

  it("reads South African number input", () => {
    const { spec } = draftToSpec({ mileageKm: "124 455", engineCc: "1,798", consumptionL100: "6,4", zeroTo100S: "10.2" });
    expect(spec).toEqual({ mileageKm: 124455, engineCc: 1798, consumptionL100: 6.4, zeroTo100S: 10.2 });
  });

  it("leaves blanks out and keeps 'no spare key'", () => {
    expect(draftToSpec({ make: "  ", spareKey: "no" })).toEqual({ spec: { spareKey: false }, invalid: [] });
    expect(draftToSpec({})).toEqual({ spec: undefined, invalid: [] });
  });

  it("names every invalid field, in form order", () => {
    expect(draftToSpec({ mileageKm: "lots", year: "1800", consumptionL100: "6.45", gears: "6.5", make: "x".repeat(41) }).invalid)
      .toEqual(["mileageKm", "consumptionL100", "make", "year", "gears"]);
  });

  it("starts a vehicle's sheet from the valuation fields", () => {
    expect(draftFromVehicle({ make: "Toyota", model: "Corolla", year: "2017", mileage: "124455" })).toMatchObject({ make: "Toyota", year: "2017", mileageKm: "124455", colour: "" });
  });
});
