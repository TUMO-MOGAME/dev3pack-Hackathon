import "server-only";
/**
 * Off-chain metadata in Supabase Postgres (schema: supabase/migrations/0001_init.sql): display names,
 * will drafts, agent reports (full JSON; the chain has only the hash), evidence index, chat/voice
 * transcripts. Every function falls back to an in-memory store when Supabase is not configured.
 */
import { getSupabase } from "./supabase";
import type { AgentReport, WillDraft } from "./types";
import type { SpecialistName } from "./voice/types";
import { chainConfig } from "./chain/config";
import { DEVNET_DEMO_META, DEVNET_FIRST_META, DEVNET_PREV_META } from "./chain/demo-estate";

export interface EstateMeta {
  estate: string;
  ownerWallet: string;
  ownerName: string;
  verifierNames: [string, string, string];
  assetTitles: Record<string, string>;
  buyerNames: Record<string, string>;
  /** Milliseconds: when the owner saved these names. A save names the one it was built on (lib/estate-meta). */
  updatedAt?: number;
}

export interface ReportRow {
  reportHash: string;
  purpose: "death" | "claim" | "hardship" | "valuation" | "offers";
  estate: string | null;
  subject: string | null;
  evidencePath: string | null;
  evidenceSha256: string | null;
  report: AgentReport;
  txSignature: string | null;
}

export interface TranscriptRow {
  sessionId: string;
  channel: "text" | "voice";
  persona: string | null;
  estate: string | null;
  role: "user" | "agent";
  specialist: SpecialistName | null;
  text: string;
}

const mem = {
  estates: new Map<string, EstateMeta>(),
  reports: new Map<string, ReportRow>(),
  drafts: [] as { ownerWallet: string | null; draft: WillDraft; willHash: string }[],
  transcripts: [] as TranscriptRow[],
  evidence: new Map<string, { sha256: string; purpose: string; mime: string; size: number }>(),
};
// Devnet without Supabase: keep the seeded demo family's names across restarts (fictional people; see demo-estate.ts).
if (chainConfig.cluster === "devnet") for (const m of [DEVNET_DEMO_META, DEVNET_PREV_META, DEVNET_FIRST_META]) mem.estates.set(m.estate, m);

function warn(what: string, err: { message: string } | null) {
  if (err) console.warn(`[db] ${what} failed: ${err.message}`);
}

/** False while names live only in this server's memory (no Supabase): a restart loses them. */
export const metaIsDurable = (): boolean => getSupabase() !== null;

/**
 * Stores names only if what is stored is still `prev` (null: nothing stored), so an older copy can never replace a
 * newer one, even across instances. Returns false when it changed meanwhile; throws when the store fails.
 */
export async function saveEstateMeta(m: EstateMeta, prev: EstateMeta | null): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) {
    const held = mem.estates.get(m.estate) ?? null;
    if (!held !== !prev || (held?.updatedAt ?? 0) !== (prev?.updatedAt ?? 0)) return false;
    mem.estates.set(m.estate, m);
    return true;
  }
  const row = {
    estate: m.estate, owner_wallet: m.ownerWallet, owner_name: m.ownerName, verifier_names: m.verifierNames,
    asset_titles: m.assetTitles, buyer_names: m.buyerNames, updated_at: new Date(m.updatedAt ?? Date.now()).toISOString(),
  };
  const table = sb.from("estate_meta");
  const at = prev?.updatedAt ?? 0;
  const { data, error } = prev
    // A millisecond range: Postgres keeps microseconds, JavaScript doesn't.
    ? await table.update(row).eq("estate", m.estate).gte("updated_at", new Date(at).toISOString()).lt("updated_at", new Date(at + 1).toISOString()).select("estate")
    : await table.upsert(row, { onConflict: "estate", ignoreDuplicates: true }).select("estate");
  if (error) throw new Error(`Could not save the names: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** `strict` throws when the store can't be read, so "couldn't read" is never taken for "nothing saved". */
export async function getEstateMeta(estate: string, opts: { strict?: boolean } = {}): Promise<EstateMeta | null> {
  const sb = getSupabase();
  if (!sb) return mem.estates.get(estate) ?? null;
  const { data, error } = await sb.from("estate_meta").select("*").eq("estate", estate).maybeSingle();
  if (error && opts.strict) throw new Error(`Could not read the names: ${error.message}`);
  warn("getEstateMeta", error);
  if (!data) return null;
  return {
    estate: data.estate, ownerWallet: data.owner_wallet, ownerName: data.owner_name, verifierNames: data.verifier_names,
    assetTitles: data.asset_titles ?? {}, buyerNames: data.buyer_names ?? {},
    updatedAt: data.updated_at ? Date.parse(data.updated_at) : 0,
  };
}

export async function saveWillDraft(ownerWallet: string | null, draft: WillDraft, willHash: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) { mem.drafts.push({ ownerWallet, draft, willHash }); return; }
  const { error } = await sb.from("will_drafts").insert({ owner_wallet: ownerWallet, draft, will_hash: willHash });
  warn("saveWillDraft", error);
}

export async function saveReport(r: ReportRow): Promise<void> {
  const sb = getSupabase();
  if (!sb) { mem.reports.set(r.reportHash, r); return; }
  const { error } = await sb.from("agent_reports").upsert({
    report_hash: r.reportHash, purpose: r.purpose, estate: r.estate, subject: r.subject, evidence_path: r.evidencePath,
    evidence_sha256: r.evidenceSha256, report: r.report, tx_signature: r.txSignature,
  });
  warn("saveReport", error);
}

/** With `estate`, only reports made for that estate: hashes are public on-chain, the reports are not. */
export async function getReports(hashes: string[], estate?: string): Promise<Record<string, AgentReport>> {
  const out: Record<string, AgentReport> = {};
  if (hashes.length === 0) return out;
  const sb = getSupabase();
  if (!sb) {
    for (const h of hashes) { const r = mem.reports.get(h); if (r && (!estate || r.estate === estate)) out[h] = r.report; }
    return out;
  }
  let query = sb.from("agent_reports").select("report_hash, report").in("report_hash", hashes);
  if (estate) query = query.eq("estate", estate);
  const { data, error } = await query;
  warn("getReports", error);
  for (const row of data ?? []) out[row.report_hash as string] = row.report as AgentReport;
  return out;
}

export async function recordEvidence(path: string, sha256: string, purpose: string, mime: string, size: number): Promise<void> {
  const sb = getSupabase();
  if (!sb) { mem.evidence.set(path, { sha256, purpose, mime, size }); return; }
  const { error } = await sb.from("evidence").upsert({ path, sha256, purpose, mime, size });
  warn("recordEvidence", error);
}

export async function saveTranscript(rows: TranscriptRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sb = getSupabase();
  if (!sb) { mem.transcripts.push(...rows); if (mem.transcripts.length > 2000) mem.transcripts.splice(0, 1000); return; }
  const { error } = await sb.from("transcripts").insert(rows.map((r) => ({
    session_id: r.sessionId, channel: r.channel, persona: r.persona, estate: r.estate, role: r.role, specialist: r.specialist, text: r.text,
  })));
  warn("saveTranscript", error);
}
