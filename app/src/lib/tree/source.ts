/**
 * Where the Trust Tree screen gets its data. When the service implements `TreeService` (tree-core adds `getTree`,
 * `setRelationship`, `removeRelationship` and `setHidden` to HeirloomService) the screen uses it; until then it uses
 * the fixture (lib/tree/fixture.ts), with relationship and hide changes kept in memory for this tab.
 *
 * AT MERGE: `treeSource(svc)` becomes `svc` (one line in components/tree/use-tree.ts), then delete this file's
 * fallback, lib/tree/fixture.ts (or keep it for tests) and lib/tree/timeline-local.ts.
 */
import type { HeirloomService } from "../service/types";
import type { Base58 } from "../types";
import type { Relationship, RelationshipInput, TreeService, TreeSnapshot } from "./types";

const local = new Map<Base58, TreeSnapshot>();

async function fixtureTree(estate: Base58, mode: "mock" | "chain"): Promise<TreeSnapshot> {
  const have = local.get(estate);
  if (have) return structuredClone(have);
  const { treeFixture } = await import("./fixture");
  const t = treeFixture(estate, mode);
  local.set(estate, t);
  return structuredClone(t);
}

/** The fixture-backed stand-in, acting as `viewer` (the signed-in wallet). */
function fixtureService(mode: "mock" | "chain", viewer: () => Base58 | null): TreeService {
  return {
    getTree: (estate) => fixtureTree(estate, mode),
    async setRelationship(estate, input: RelationshipInput) {
      const t = await fixtureTree(estate, mode);
      if (input.from === input.to) throw new Error("A relationship needs two different people.");
      const rel: Relationship = {
        id: `rel-${input.kind}-${Date.now().toString(36)}`, ...input, declaredBy: viewer() ?? "", declaredAt: Math.floor(Date.now() / 1000),
      };
      t.relationships.push(rel);
      local.set(estate, t);
      return rel;
    },
    async removeRelationship(estate, id) {
      const t = await fixtureTree(estate, mode);
      t.relationships = t.relationships.filter((r) => r.id !== id);
      local.set(estate, t);
    },
    async setHidden(estate, hidden) {
      const t = await fixtureTree(estate, mode);
      const me = viewer();
      const orig = (await import("./fixture")).treeFixture(estate, mode).people;
      t.people = t.people.map((p) => {
        if (!me || !p.wallets.includes(me)) return p;
        const named = orig.find((o) => o.id === p.id);
        return hidden ? { ...p, hidden: true, name: "", short: "" } : { ...p, hidden: false, name: named?.name || p.name, short: named?.short || p.short };
      });
      local.set(estate, t);
    },
  };
}

/** The service's tree methods when it has them, else the fixture stand-in. */
export function treeSource(svc: HeirloomService, viewer: () => Base58 | null): TreeService {
  const s = svc as HeirloomService & Partial<TreeService>;
  if (typeof s.getTree === "function" && s.setRelationship && s.removeRelationship && s.setHidden) return s as unknown as TreeService;
  return fixtureService(svc.mode, viewer);
}
