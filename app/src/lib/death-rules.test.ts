import { describe, expect, it } from "vitest";
import { eligibleSeats, isCurrentClaim, quorum, refuteWait, replaceableAt, reviewedHold } from "./death-rules";

const [A, B, C] = ["A", "B", "C"];

describe("quorum", () => {
  const base = { verifiers: [A, B, C], votes: [true, false, false], threshold: 2, verdict: "Approved" as const };
  it("needs the threshold", () => expect(quorum(base)).toEqual({ needed: 2, got: 1, met: false }));
  it("falls to the living seats", () => expect(quorum({ ...base, verifiers: [A, null, null] }).met).toBe(true));
  it("a referral needs two", () => expect(quorum({ ...base, threshold: 1, verdict: "Referred" }).needed).toBe(2));
  it("nobody votes in their own favour", () => expect(quorum({ ...base, threshold: 1, interested: A }).met).toBe(false));
  it("zero eligible never passes", () => expect(quorum({ ...base, verifiers: [A, null, null], interested: A }).met).toBe(false));
  it("the all-zero key is an empty seat", () => expect(eligibleSeats(["11111111111111111111111111111111", B])).toEqual([1]));
});

describe("replaceable reports", () => {
  const base = { verdict: "Pending" as const, reportedAt: 1_000, reporter: A, who: B, waitingSecs: 120, hold: reviewedHold(120) };
  it("unreviewed: one grace", () => expect(replaceableAt(base)).toBe(1_120));
  it("the reporter waits one longer", () => expect(replaceableAt({ ...base, who: A })).toBe(1_240));
  it("reviewed: two waits", () => expect(replaceableAt({ ...base, verdict: "Approved" })).toBe(1_240));
  it("the grace is clamped", () => {
    expect(replaceableAt({ ...base, waitingSecs: 1 })).toBe(1_060);
    expect(replaceableAt({ ...base, waitingSecs: 9_999_999 })).toBe(87_400);
  });
  it("refuting always has a minute", () => expect(refuteWait(0)).toBe(60));
});

describe("reused rule slots", () => {
  it("tells a claim of the earlier rule apart", () => {
    expect(isCurrentClaim(3, 5)).toBe(true);
    expect(isCurrentClaim(3, 65_536)).toBe(false);
    expect(isCurrentClaim(65_536, 65_537)).toBe(true);
  });
});
