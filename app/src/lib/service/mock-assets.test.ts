/**
 * Richer assets in the mock service (the contract's twin): Thabo's seeded Corolla and motorbike, up to 24 labelled
 * photos, the spec sheet in the media root, and buyers' escrowed offers on any asset.
 */
import { describe, expect, it } from "vitest";
import { createMockService, DEMO_PERSONAS } from "./mock";
import { DEMO_ASSETS } from "./demo-asset-photos";
import { mediaRootHex } from "../assets/spec";
import { fromBase } from "../format";
import type { DemoStage } from "./mock";

type Svc = ReturnType<typeof createMockService>;
const P = (key: string) => DEMO_PERSONAS.find((p) => p.key === key)!;
const act = (svc: Svc, key: string) => { const p = P(key); svc.setActor({ address: p.address, role: p.role, label: p.label }); };

async function start(stage: DemoStage) {
  const svc = createMockService({ instant: true });
  svc.resetDemo(stage);
  act(svc, "thabo");
  const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
  const snap = () => svc.getEstate(estate);
  const [car, bike] = (await snap()).assets;
  return { svc, estate, snap, car, bike };
}
const photo = (i: number, label?: "Front" | "Engine") => ({ sha256: i.toString(16).padStart(64, "0"), url: `/p/${i}.webp`, width: 1280, height: 960, bytes: 100_000, ...(label ? { label } : {}) });

describe("seeded demo assets", () => {
  it.each(["funded", "unlocked", "listed", "lowOffers", "guardians"] as const)("%s: Thabo's Corolla and motorbike, at Tumo's prices", async (stage) => {
    const { car, bike } = await start(stage);
    expect(car.title).toBe("2017 Toyota Corolla 1.8 Exclusive CVT");
    expect([car.askingPrice, car.floorPrice, car.hardshipFloor].map(fromBase)).toEqual([13500, 12500, 10500]);
    expect(bike.title).toBe("2025 Big Boy Mustang 250");
    expect([bike.askingPrice, bike.floorPrice, bike.hardshipFloor].map(fromBase)).toEqual([2000, 1800, 1500]);
  });

  it("both have labelled photos and a spec sheet, recorded with their media root", async () => {
    const { svc, estate, car, bike } = await start("funded");
    const media = await svc.getAssetMedia(estate);
    const c = media.find((m) => m.asset === car.address)!, b = media.find((m) => m.asset === bike.address)!;
    expect(c).toMatchObject({ kind: "Car", spec: DEMO_ASSETS.corolla.spec });
    expect(b).toMatchObject({ kind: "Motorbike", spec: DEMO_ASSETS.mustang.spec });
    expect(c.photos).toHaveLength(16);
    expect(b.photos).toHaveLength(9);
    expect(c.photosRoot).toBe(await mediaRootHex(c.photos, c.spec));
    expect(b.photosRoot).toBe(await mediaRootHex(b.photos, b.spec));
  });

  it("fresh: nothing is seeded", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("fresh");
    act(svc, "thabo");
    expect(await svc.listEstatesFor(P("thabo").address)).toEqual([]);
  });
});

describe("asset media rules", () => {
  it("accepts 24 photos and refuses 25", async () => {
    const { svc, estate, car } = await start("funded");
    const many = Array.from({ length: 25 }, (_, i) => photo(i + 1));
    await expect(svc.setAssetMedia(estate, car.address, { kind: "Car", title: "c", photos: many })).rejects.toThrow(/^InvalidAmount/);
    await svc.setAssetMedia(estate, car.address, { kind: "Car", title: "c", photos: many.slice(0, 24) });
    expect((await svc.getAssetMedia(estate)).find((m) => m.asset === car.address)!.photos).toHaveLength(24);
  });

  it("refuses an unknown label or an invalid spec sheet", async () => {
    const { svc, estate, car } = await start("funded");
    await expect(svc.setAssetMedia(estate, car.address, { kind: "Car", title: "c", photos: [{ ...photo(1), label: "Roof" as never }] })).rejects.toThrow(/^InvalidSpec/);
    await expect(svc.setAssetMedia(estate, car.address, { kind: "Car", title: "c", photos: [], spec: { year: 1700 } })).rejects.toThrow(/^InvalidSpec/);
    await expect(svc.setAssetMedia(estate, car.address, { kind: "Car", title: "c", photos: [], spec: { owner: "x" } as never })).rejects.toThrow(/^InvalidSpec/);
  });

  it("an edited spec sheet changes the recorded root; blanks are dropped", async () => {
    const { svc, estate, car } = await start("funded");
    const photos = [photo(1, "Front"), photo(2, "Engine")];
    const read = async () => (await svc.getAssetMedia(estate)).find((m) => m.asset === car.address)!;
    await svc.setAssetMedia(estate, car.address, { kind: "Car", title: "c", photos, spec: { make: "Toyota", colour: "" as never } });
    const first = await read();
    expect(first.spec).toEqual({ make: "Toyota" });
    expect(first.photosRoot).toBe(await mediaRootHex(photos, { make: "Toyota" }));
    await svc.setAssetMedia(estate, car.address, { kind: "Car", title: "c", photos, spec: { make: "Toyota", mileageKm: 125000 } });
    expect((await read()).photosRoot).not.toBe(first.photosRoot);
  });

  it("every kind has its own sheet: furniture details are kept, a vehicle field on furniture is refused", async () => {
    const { svc, estate, car } = await start("funded");
    const read = async () => (await svc.getAssetMedia(estate)).find((m) => m.asset === car.address)!;
    await svc.setAssetMedia(estate, car.address, { kind: "Furniture", title: "Oak table", photos: [], spec: { material: "Solid oak", pieces: 7, dimensionsCm: "180 x 90 x 76" } });
    expect((await read()).spec).toEqual({ material: "Solid oak", pieces: 7, dimensionsCm: "180 x 90 x 76" });
    await expect(svc.setAssetMedia(estate, car.address, { kind: "Furniture", title: "Oak table", photos: [], spec: { material: "Oak", mileageKm: 5 } })).rejects.toThrow(/^InvalidSpec/);
    await expect(svc.setAssetMedia(estate, car.address, { kind: "Jewellery", title: "Ring", photos: [], spec: { metal: "Gold", weightG: 4.25 } })).rejects.toThrow(/^InvalidSpec/);
  });

  it("only the owner (while active) can change photos or the spec sheet", async () => {
    const { svc, estate, car } = await start("funded");
    act(svc, "zanele");
    await expect(svc.setAssetMedia(estate, car.address, { kind: "Car", title: "c", photos: [], spec: { make: "x" } })).rejects.toThrow(/^NotOwner/);
  });
});

describe("selling after Thabo's passing (escrowed offers, any asset)", () => {
  it("listed: the Corolla sells to the best offer at or above 12,500; the one below is blocked", async () => {
    const { svc, estate, car } = await start("listed");
    const offers = (await svc.getEstate(estate)).offers.filter((o) => o.asset === car.address);
    expect(offers.map((o) => fromBase(o.amount)).sort()).toEqual([11650, 12700]);
    act(svc, "zanele");
    await svc.placeOffer(estate, car.address, 13000); // Pieter has enough USD₮ for it
    act(svc, "nomsa");
    const { ranking } = await svc.acceptBestOffer(estate, car.address);
    expect(ranking.ineligible.map((x) => fromBase(offers.find((o) => o.address === x.offer)?.amount ?? 0n))).toContain(11650);
    const sold = (await svc.getEstate(estate)).assets.find((a) => a.address === car.address)!;
    expect(sold.status).toBe("Sold");
  });

  it("lowOffers: no offer reaches the minimum, so the sale is blocked", async () => {
    const { svc, estate, car } = await start("lowOffers");
    act(svc, "nomsa");
    await expect(svc.acceptBestOffer(estate, car.address)).rejects.toThrow(/^BelowFloor/);
  });

  it("the motorbike can be listed and sold the same way", async () => {
    const { svc, estate, bike } = await start("unlocked");
    act(svc, "nomsa");
    await svc.listAsset(estate, bike.address, 7 * 86400); // the demo's rival buyers bid 1,650 (blocked) and 1,850
    act(svc, "zanele");
    await svc.placeOffer(estate, bike.address, 1700);
    let ranking = await svc.rankOffers(bike.address);
    const mine = () => (svc.getEstate(estate)).then((s) => s.offers.find((o) => o.asset === bike.address && o.buyer === P("zanele").address)!.address);
    expect(ranking.ineligible.map((x) => x.offer)).toContain(await mine()); // under the 1,800 minimum
    await svc.placeOffer(estate, bike.address, 1900);
    ranking = await svc.rankOffers(bike.address);
    expect(ranking.bestOffer).toBe(await mine());
    act(svc, "nomsa");
    await svc.acceptBestOffer(estate, bike.address);
    const after = await svc.getEstate(estate);
    expect(after.assets.find((a) => a.address === bike.address)!.status).toBe("Sold");
    expect(after.activity.some((a) => a.kind === "AssetSold" && a.text.includes("Pieter") && a.amount !== undefined && fromBase(a.amount) === 1900)).toBe(true);
  });
});
