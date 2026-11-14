import { PublicKey } from "@solana/web3.js";
import { handler, HttpError, isChainMode, json, rateLimit } from "@/lib/api/http";
import { reviewFields } from "@/lib/agent/schemas";
import { reviewDocument } from "@/lib/agent/review";
import { MAX_UPLOAD_BYTES, storeEvidence } from "@/lib/storage";
import { recordEvidence, saveReport } from "@/lib/db";
import { fetchAccountRaw, findRecentEvent } from "@/lib/chain/reads";
import { hex, key } from "@/lib/chain/decoders";
import { reviewClaim, reviewDeath, reviewFallbackDeath, reviewHardship, reviewSeatDeath } from "@/lib/chain/instructions";
import { guardPda, seatPda } from "@/lib/chain/pda";
import { getIdl } from "@/lib/chain/idl";
import { agentSignAndSend, hasAgentWallet, agentAddress } from "@/lib/agent/agent-wallet";

export const maxDuration = 90;

/**
 * POST /api/review (multipart: file, purpose=death|claim|hardship|seat-death|fallback-death, estate, context, subject?,
 * index?, preview?=1). seat-death: `index` = seat 0..2; fallback-death: `index` = fallback recipient 0..3; the context
 * names the person whose death is reported (the reviewer checks the certificate against that name, not the owner).
 * 1. validate + store the file (private bucket), hash it
 * 2. chain mode: the hash must equal the evidence hash already on-chain (death claim / claim / hardship)
 * 3. Gemini DocumentReviewer → AgentReport (reportHash = sha256 of canonical JSON)
 * 4. the agent's WDK wallet signs review_* with approve = verdict !== "reject". "needs_human" is forwarded to the
 *    human verifiers (who must still approve on-chain) with the red flags attached; only "reject" blocks.
 * Returns { report, evidence: { sha256 }, tx: { signature, explorerUrl } | null, onChain: string }.
 */
export const POST = handler(async (req) => {
  rateLimit(req, "review", 8);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64_000) throw new HttpError(413, "The file is larger than 10 MB.");
  const form = await req.formData().catch(() => { throw new HttpError(400, "Expected a form upload with the document as `file`."); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Attach the document as `file`.");
  const fields = reviewFields.parse({
    purpose: form.get("purpose"), estate: form.get("estate"), context: form.get("context") ?? "", subject: form.get("subject") ?? undefined,
    index: form.get("index") ?? undefined,
  });
  const deathOf = fields.purpose === "seat-death" || fields.purpose === "fallback-death";
  if (deathOf && fields.index === undefined) throw new HttpError(400, "index is required for this review.");
  if (fields.purpose === "seat-death" && fields.index! > 2) throw new HttpError(400, "There are only three seats.");
  // A trusted person's or fallback recipient's certificate is stored and logged as a death certificate.
  const storePurpose: "death" | "claim" | "hardship" = fields.purpose === "seat-death" || fields.purpose === "fallback-death" ? "death" : fields.purpose;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const stored = await storeEvidence(bytes, file.type, storePurpose);

  // On-chain integrity: the uploaded file must be the one whose hash the family member submitted.
  let onChainTarget:
    | { kind: "death" } | { kind: "claim"; claim: string; rule: string } | { kind: "hardship"; hardship: string; asset: string }
    | { kind: "seat-death"; index: number } | { kind: "fallback-death"; index: number } | null = null;
  const preview = form.get("preview") === "1"; // review only: no on-chain hash check and no agent tx
  if (isChainMode() && !preview) {
    if (fields.purpose === "death") {
      const est = await fetchAccountRaw("Estate", fields.estate);
      if (!est) throw new HttpError(404, "Estate not found on-chain.");
      if (hex(est, "death_cert_hash") !== stored.sha256) throw new HttpError(409, "This file does not match the death certificate hash submitted on-chain.");
      onChainTarget = { kind: "death" };
    } else if (fields.purpose === "seat-death") {
      const programId = getIdl().address;
      const seat = await fetchAccountRaw("Seat", seatPda(programId, fields.estate, fields.index!).toBase58());
      if (!seat) throw new HttpError(404, "This trusted person's seat was not found on-chain.");
      if (hex(seat, "death_cert_hash") !== stored.sha256) throw new HttpError(409, "This file does not match the death certificate hash submitted on-chain.");
      onChainTarget = { kind: "seat-death", index: fields.index! };
    } else if (fields.purpose === "fallback-death") {
      const programId = getIdl().address;
      const guardAddr = guardPda(programId, fields.estate).toBase58();
      if (!(await fetchAccountRaw("Guard", guardAddr))) throw new HttpError(404, "This estate has no fallback plan on-chain.");
      // The Guard keeps no certificate hash: the report's hash is in its FallbackDeathReported event.
      const i = fields.index!;
      const reported = await findRecentEvent(guardAddr, "FallbackDeathReported", (d) => Number(d.index) === i && hex(d, "cert_hash") === stored.sha256);
      if (!reported) throw new HttpError(409, "This file does not match a death certificate reported on-chain for this person.");
      onChainTarget = { kind: "fallback-death", index: fields.index! };
    } else {
      if (!fields.subject) throw new HttpError(400, "subject (claim or hardship address) is required.");
      const type = fields.purpose === "claim" ? "Claim" : "Hardship";
      const acc = await fetchAccountRaw(type, fields.subject);
      if (!acc) throw new HttpError(404, `${type} not found on-chain.`);
      if (hex(acc, "evidence_hash") !== stored.sha256) throw new HttpError(409, `This file does not match the ${type.toLowerCase()} evidence hash on-chain.`);
      onChainTarget = fields.purpose === "claim"
        ? { kind: "claim", claim: fields.subject, rule: key(acc, "rule") }
        : { kind: "hardship", hardship: fields.subject, asset: key(acc, "asset") };
    }
  }

  const report = await reviewDocument({ bytes, mime: stored.mime, purpose: fields.purpose, context: fields.context, evidenceSha256: stored.sha256 });
  await recordEvidence(stored.path, stored.sha256, storePurpose, stored.mime, stored.size);

  let tx: { signature: string; explorerUrl: string } | null = null;
  let onChain = preview ? "skipped (preview)" : "skipped (mock mode)";
  if (onChainTarget) {
    if (!hasAgentWallet()) onChain = "skipped (AGENT_SEED_PHRASE not set)";
    else {
      const agent = new PublicKey((await agentAddress())!);
      const estate = new PublicKey(fields.estate);
      const approve = report.verdict !== "reject";
      const t = onChainTarget;
      const ixs = t.kind === "death"
        ? [reviewDeath(estate, agent, approve, report.reportHash)]
        : t.kind === "claim"
          ? [reviewClaim(estate, agent, new PublicKey(t.claim), new PublicKey(t.rule), approve, report.reportHash)]
          : t.kind === "hardship"
            ? [reviewHardship(estate, agent, new PublicKey(t.asset), new PublicKey(t.hardship), approve, report.reportHash)]
            : t.kind === "seat-death"
              ? [reviewSeatDeath(estate, agent, t.index, approve, report.reportHash)]
              : [reviewFallbackDeath(estate, agent, t.index, approve, report.reportHash)];
      tx = await agentSignAndSend(ixs);
      onChain = !approve ? "agent rejected on-chain"
        : t.kind === "fallback-death" ? "agent approved on-chain; the recipient is skipped in the fallback order"
          : "agent approved on-chain; waiting for human verifiers";
    }
  }

  await saveReport({
    reportHash: report.reportHash, purpose: storePurpose, estate: fields.estate, subject: fields.subject ?? null,
    evidencePath: stored.path, evidenceSha256: stored.sha256, report, txSignature: tx?.signature ?? null,
  });
  return json({ report, evidence: { sha256: stored.sha256, storage: stored.backend }, tx, onChain });
});
