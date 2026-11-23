import "server-only";
/**
 * Shared helpers for route handlers: JSON responses with bigint support, typed errors → status codes,
 * zod body parsing, client IP, and a per-IP rate limit: `rateLimit` (in memory, per instance) for ordinary routes,
 * `rateLimitShared` (also across instances when the shared store is there) where the agent signs or spends.
 */
import { z } from "zod";
import { AgentError } from "../agent/gemini";
import { UploadError } from "../evidence-file";
import { takeShared } from "../server/shared-store";

export function json(data: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new Response(body, { ...init, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...init.headers } });
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error", public retryAfterSecs?: number) { super(message); }
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const retryAfter = e.retryAfterSecs;
    return retryAfter === undefined
      ? json({ error: e.message, code: e.code }, { status: e.status })
      : json({ error: e.message, code: e.code, retryAfter }, { status: e.status, headers: { "retry-after": String(retryAfter) } });
  }
  if (e instanceof z.ZodError) return json({ error: "Invalid request", code: "invalid", issues: e.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  if (e instanceof UploadError) return json({ error: e.message, code: "upload" }, { status: 400 });
  if (e instanceof AgentError) return json({ error: e.message, code: e.code }, { status: e.code === "timeout" ? 504 : e.code === "not_configured" ? 503 : 502 });
  const msg = e instanceof Error ? e.message : "Unexpected error";
  console.error("[api]", msg);
  // An RPC URL can carry an API key: never echo one.
  return json({ error: msg.replace(/(https?|wss?):\/\/\S+/g, "[url]").slice(0, 300), code: "server" }, { status: 500 });
}

export async function parseJson<T>(req: Request, schema: z.ZodType<T>, maxBytes = 200_000): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new HttpError(413, "Request too large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request too large");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new HttpError(400, "Body must be JSON"); }
  return schema.parse(raw);
}

/**
 * The caller's network address, for limits. An IPv6 caller is counted by its /64 (the network one phone or one home is
 * given), or one device could pick a new address for every request.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = (fwd?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim().toLowerCase();
  if (!ip.includes(":") || /^::ffff:\d/.test(ip)) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

const windows = new Map<string, { start: number; count: number }>();

/** Fixed window: `limit` requests per `windowMs` per IP per bucket. Throws 429 when exceeded. */
export function rateLimit(req: Request, bucket: string, limit: number, windowMs = 60_000, now = Date.now()): void {
  const key = `${bucket}:${clientIp(req)}`;
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    return;
  }
  w.count++;
  if (w.count > limit) throw tooMany((w.start + windowMs - now) / 1000);
}

const tooMany = (secs: number) =>
  new HttpError(429, "Too many requests. Please wait a minute and try again.", "rate_limited", Math.max(1, Math.ceil(secs)));

/** `rateLimit`, and the same allowance across instances when the shared store is there. Always await it. */
export async function rateLimitShared(req: Request, bucket: string, limit: number, windowMs = 60_000): Promise<void> {
  rateLimit(req, bucket, limit, windowMs);
  const taken = await takeShared([{ key: `rate:${bucket}:${clientIp(req)}`, max: limit, windowSecs: windowMs / 1000 }]);
  if (taken && !taken.ok) throw tooMany(taken.retryAfterSecs);
}

/** Wraps a handler with uniform error handling. */
export function handler(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    try { return await fn(req); } catch (e) { return errorResponse(e); }
  };
}

export const isChainMode = () => process.env.NEXT_PUBLIC_DATA_MODE === "chain";
