import { PublicKey } from "@solana/web3.js";
import { handler, HttpError, isChainMode, json, parseJson, rateLimit } from "@/lib/api/http";
import { acceptOfferBody } from "@/lib/agent/schemas";
import { rankOffers } from "@/lib/agent/offers";
import { acceptOffer } from "@/lib/chain/instructions";
import { chainCtx } from "@/lib/chain/client";
import { agentAddress, agentSignAndSend, hasAgentWallet } from "@/lib/agent/agent-wallet";
import { loadPublicSnapshot } from "@/lib/server/estate";
import { spendAgentAllowance } from "@/lib/agent/budget";
import { assertServedEstate, verifyAction } from "@/lib/access/server";
import { actionBody } from "@/lib/access/messages";

export const maxDuration = 60;

/**
 * POST /api/accept-offer { estate, asset }, signed by a trusted person who is not that buyer → the agent ranks the on-chain offers (floor / hardship floor) and its
 * WDK wallet signs accept_offer for the best eligible one: USD₮ and the car title swap in one transaction.
 * Returns { tx, ranking }. 409 if no offer is eligible (the contract would reject it anyway).
 */
export const POST = handler(async (req) => {
  rateLimit(req, "accept-offer", 5);
  const b = await parseJson(req, acceptOfferBody);
  if (!isChainMode()) throw new HttpError(409, "On-chain sale runs in chain mode only.");
  const wallet = verifyAction(req, "accept-offer", b.estate, actionBody.acceptOffer(b));
  if (!hasAgentWallet()) throw new HttpError(503, "The agent wallet is not configured (AGENT_SEED_PHRASE).");
  const snap = await loadPublicSnapshot(b.estate);
  if (!snap.estate.verifiers.includes(wallet)) throw new HttpError(403, "Only the estate's trusted people can settle a sale.", "forbidden");
  const asset = snap.assets.find((a) => a.address === b.asset);
  if (!asset) throw new HttpError(404, "Asset not found in this estate.");
  const offers = snap.offers.filter((o) => o.asset === asset.address);
  const ranking = rankOffers(asset, offers);
  const best = offers.find((o) => o.address === ranking.bestOffer);
  if (!best) return json({ tx: null, ranking, error: "No offer meets the floor price (or the hardship floor)." }, { status: 409 });

  if (best.buyer === wallet) throw new HttpError(403, "You cannot settle a sale to yourself. Ask another trusted person.", "own_offer");
  const agentKey = await agentAddress();
  assertServedEstate(snap.estate, agentKey);
  spendAgentAllowance("accept-offer", wallet, b.estate);
  const agent = new PublicKey(agentKey!);
  const recipient = new PublicKey(asset.hardshipBeneficiary ?? asset.proceedsTo);
  const tx = await agentSignAndSend([acceptOffer(chainCtx(), {
    estate: new PublicKey(b.estate), agent, asset: new PublicKey(asset.address), nftMint: new PublicKey(asset.nftMint),
    buyer: new PublicKey(best.buyer), recipient,
    hardshipBeneficiary: asset.hardshipBeneficiary ? new PublicKey(asset.hardshipBeneficiary) : null,
  })]);
  return json({ tx, ranking });
});
