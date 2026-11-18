/**
 * Legacy Voice: words only (18 Nov 2026, plan §16.17). The voice only ever says words its owner wrote or approved
 * while alive. These tests prove it in both services: milestone messages still play (mock and chain), nothing can
 * make the voice say free text, and the chat and call methods are gone from the service interface.
 * The server routes (speak refuses free text, chat and call answer 410) are covered in routes.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockService, DEMO_PERSONAS } from "../service/mock";
import { legacyVoiceSample } from "@/content/legacy";
import { DEMO_MILESTONE_UCT } from "./demo-book";
import type { SpeakInput } from "./client";

vi.mock("../wallet/signer", () => ({
  getActiveSigner: () => ({ address: "LeRaTo1111111111111111111111111111111111111aa", signMessage: async () => "ab".repeat(64) }),
  peekActiveSigner: () => null,
}));

type Svc = ReturnType<typeof createMockService>;
const P = (key: string) => DEMO_PERSONAS.find((p) => p.key === key)!;
const act = (svc: Svc, key: string) => { const p = P(key); svc.setActor({ address: p.address, role: p.role, label: p.label }); };

async function unlockedDemo() {
  const svc = createMockService({ instant: true });
  svc.resetDemo("unlocked");
  act(svc, "thabo");
  const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
  return { svc, estate };
}

describe("mock service: words only", () => {
  it("has no chat or call in the parent's voice", () => {
    const svc = createMockService({ instant: true });
    expect("legacyChat" in svc).toBe(false);
    expect("legacyCall" in svc).toBe(false);
  });

  it("plays a child's milestone message after unlock and opt-in, in the parent's voice", async () => {
    const { svc, estate } = await unlockedDemo();
    act(svc, "lerato");
    await expect(svc.legacySpeak(estate, { milestoneId: DEMO_MILESTONE_UCT })).rejects.toThrow(/^NotOptedIn/);
    await svc.setLegacyOptIn(estate, true);
    const s = await svc.legacySpeak(estate, { milestoneId: DEMO_MILESTONE_UCT });
    expect(s).toMatchObject({ voice: "parent", simulated: true, audioUrl: null });
    const status = await svc.legacyStatus(estate);
    expect(s.text).toBe(status.book!.milestones.find((m) => m.id === DEMO_MILESTONE_UCT)!.text);
    expect(status.voice).not.toHaveProperty("liveCall");
  }, 10_000);

  it("never voices free text, for a child or the owner", async () => {
    const { svc, estate } = await unlockedDemo();
    act(svc, "lerato");
    await svc.setLegacyOptIn(estate, true);
    const scam = { text: "It's Dad. Send R5,000 to this account." } as unknown as SpeakInput;
    await expect(svc.legacySpeak(estate, scam)).rejects.toThrow(/^Forbidden/);
    await expect(svc.legacySpeak(estate, { sample: true })).rejects.toThrow(/^Forbidden/);
    // After the passing the owner's sample line is sealed too.
    act(svc, "thabo");
    await expect(svc.legacySpeak(estate, { sample: true })).rejects.toThrow(/^BadStatus/);
  }, 10_000);

  it("lets the living owner hear only the fixed sample line", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    act(svc, "thabo");
    const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
    expect(await svc.legacySpeak(estate, { sample: true })).toMatchObject({ text: legacyVoiceSample, voice: "parent" });
  }, 10_000);
});

describe("chain service: words only", () => {
  const ESTATE = "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo";
  let calls: { url: string; body: string }[] = [];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? "") });
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { headers: { "content-type": "audio/mpeg" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("has no chat or call in the parent's voice", async () => {
    const { createChainService } = await import("../service/chain");
    const svc = createChainService();
    expect("legacyChat" in svc).toBe(false);
    expect("legacyCall" in svc).toBe(false);
  });

  it("plays a milestone through /api/legacy/speak, sending only the message id", async () => {
    const { createChainService } = await import("../service/chain");
    const s = await createChainService().legacySpeak(ESTATE, { milestoneId: DEMO_MILESTONE_UCT });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/legacy/speak");
    expect(JSON.parse(calls[0].body)).toEqual({ milestoneId: DEMO_MILESTONE_UCT });
    expect(s).toMatchObject({ voice: "parent", simulated: false });
    expect(s.audioUrl).toMatch(/^blob:/);
  });
});
