import { z } from "zod";
import { handler, HttpError, isChainMode, json, parseJson, rateLimit } from "@/lib/api/http";
import { verifyAction } from "@/lib/access/server";
import { actionBody } from "@/lib/access/messages";
import { grantStarter } from "@/lib/starter/server";

export const maxDuration = 45;

const body = z.object({ wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) });

/** POST /api/starter { wallet }, signed by that wallet → devnet SOL for rent and test USD₮, once (lib/starter). */
export const POST = handler(async (req) => {
  rateLimit(req, "starter-minute", 3);
  if (!isChainMode()) throw new HttpError(503, "The demo needs no starter funds.", "unavailable");
  const { wallet } = await parseJson(req, body, 1_000);
  if (verifyAction(req, "starter", wallet, actionBody.starter()) !== wallet) {
    throw new HttpError(403, "A wallet can only ask for itself.", "forbidden");
  }
  // Per network, so one person can't empty the day's grants. Generous enough for a room on shared Wi-Fi.
  rateLimit(req, "starter-hour", 8, 60 * 60_000);
  return json(await grantStarter(wallet));
});
