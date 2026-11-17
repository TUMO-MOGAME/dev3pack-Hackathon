/**
 * TEMPORARY (tree-ui): a local `treeAtYear` with the signature from lib/tree/types.ts, until tree-core's
 * lib/tree/timeline.ts lands. At merge, delete this file and import `treeAtYear` from "./timeline" instead
 * (components/tree/use-tree.ts is the only caller).
 */
import type { TreeAtYear, TreeSnapshot } from "./types";

/** The calendar year (UTC) of a unix-seconds timestamp. */
export const yearOf = (ts: number) => new Date(ts * 1000).getUTCFullYear();

export function treeAtYear(snapshot: TreeSnapshot, year: number): TreeAtYear {
  const people = snapshot.people
    .filter((p) => p.since <= year)
    .map((p) => {
      const gone = p.passed !== undefined && p.passed <= year;
      return { ...p, passed: gone ? p.passed : undefined, alive: !gone };
    });
  const present = new Set(people.map((p) => p.id));
  const kept = snapshot.kept.filter((k) => yearOf(k.firstTs) <= year);
  const edges = snapshot.edges
    .filter((e) => yearOf(e.fromTs) <= year && present.has(e.from) && present.has(e.to))
    .map((e) => ({
      ...e,
      toTs: e.toTs !== undefined && yearOf(e.toTs) <= year ? e.toTs : undefined,
      keptCount: kept.filter((k) => k.by === e.to && k.estate === e.estate && k.kind !== "challengeUpheld").reduce((n, k) => n + k.count, 0),
    }));
  return {
    year,
    people,
    relationships: snapshot.relationships.filter((r) => present.has(r.from) && present.has(r.to)),
    edges,
    kept,
    assets: snapshot.assets
      .map((a) => ({ ...a, steps: a.steps.filter((s) => yearOf(s.ts) <= year) }))
      .filter((a) => a.steps.length > 0),
  };
}
