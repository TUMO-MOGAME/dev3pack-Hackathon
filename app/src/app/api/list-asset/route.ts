import { PublicKey } from "@solana/web3.js";
import { handler, HttpError, isChainMode, json, parseJson, rateLimitShared } from "@/lib/api/http";
import { listAssetBody } from "@/lib/agent/schemas";
import { listAsset } from "@/lib/chain/instructions";
import { agentAddress, agentSignAndSend, hasAgentWallet } from "@/lib/agent/agent-wallet";
import { spendAgentAllowance } from "@/lib/agent/budget";
import { mayAskForSale } from "@/lib/agent/sale";
import { invalidateProgramAccounts } from "@/lib/chain/reads";
import { assertServedEstate, verifyAction } from "@/lib/access/server";
import { actionBody } from "@/lib/access/messages";
import { loadPublicSnapshot } from "@/lib/server/estate";

export const maxDuration = 60;

/**
 * POST /api/list-asset { estate, asset, durationSecs }, signed by one of the estate's trusted people → the agent's
 * WDK wallet signs list_asset (so they need no SOL). At least an hour; an expired listing can be listed again.
 * While no seat has a holder, an active beneficiary may ask instead, as for the lone sale.
 */
export const POST = handler(async (req) => {
  await rateLimitShared(req, "list-asset", 5);
  const b = await parseJson(req, listAssetBody);
  if (!isChainMode()) throw new HttpError(409, "On-chain listing runs in chain mode only.");
  const wallet = await verifyAction(req, "list-asset", b.estate, actionBody.listAsset(b));
  if (!hasAgentWallet()) throw new HttpError(503, "The agent wallet is not configured (AGENT_SEED_PHRASE).");
  invalidateProgramAccounts(); // a seat filled or a member removed a second ago must count
  const snap = await loadPublicSnapshot(b.estate);
  if (!mayAskForSale(snap.estate.verifiers, snap.beneficiaries, wallet)) {
    throw new HttpError(403, "Only the estate's trusted people can list an asset.", "forbidden");
  }
  if (!snap.assets.some((a) => a.address === b.asset)) throw new HttpError(404, "Asset not found in this estate.", "not_found");
  const agent = await agentAddress();
  assertServedEstate(snap.estate, agent);
  await spendAgentAllowance("list-asset", wallet, b.estate);
  const tx = await agentSignAndSend([listAsset(new PublicKey(b.estate), new PublicKey(agent!), new PublicKey(b.asset), b.durationSecs)]);
  return json(tx);
});
