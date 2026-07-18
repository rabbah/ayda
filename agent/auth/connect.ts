/**
 * Signed links for the chat-driven GitHub flows: a per-user "connect" link and
 * an operator "setup" link (App provisioning). Both are minted in the messaging
 * adapter after the relevant chat-side check (DM-only; setup also admin-only)
 * and clicked in a browser to complete the OAuth / App-Manifest round-trip.
 *
 * The browser frontend keys a user's GitHub token by the `bridge_uid` cookie.
 * Messaging users have no such cookie — the sidecar identifies them by
 * StreamOptions.userId instead. So a Slack user must connect GitHub under THAT
 * identity: the adapter hands them a link that carries their userId, signed so
 * it can't be forged to bind someone else's identity.
 *
 * The link points at the normal /auth/github/login with a `link` param; the
 * server verifies it and runs the same OAuth flow, but stores the resulting
 * token under the carried userId (see index.ts githubLogin). Signing uses an
 * auto-generated server secret persisted in the Store (no operator config),
 * with node:crypto to stay dependency-free.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store.ts";

const SECRET_NS = "server";
const SECRET_KEY = "hmac_secret";
const LINK_TTL_MS = 10 * 60 * 1000;

/** What a signed link authorizes: a per-user connect, or operator App setup. */
export type LinkKind = "connect" | "setup";

let cachedSecret: string | null = null;

/**
 * Load the server HMAC secret, generating and persisting one on first use.
 * Call once at boot so the secret is stable before any link is minted.
 */
export async function getServerSecret(store: Store): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const existing = (await store.kvGet(SECRET_NS, SECRET_KEY)) as string | null;
  if (existing) {
    cachedSecret = existing;
    return existing;
  }
  const secret = randomBytes(32).toString("hex");
  await store.kvPut(SECRET_NS, SECRET_KEY, secret);
  cachedSecret = secret;
  return secret;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Mint a signed, time-limited link token of a given kind, binding a userId. */
export function mintLink(kind: LinkKind, userId: string, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify({ k: kind, u: userId, e: Date.now() + LINK_TTL_MS })));
  const mac = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * Verify a link token: checks the HMAC, the expiry, AND that it was minted for
 * the expected kind — so a `connect` link can't be replayed at the `setup`
 * endpoint (which would let any user provision the App) or vice versa. Returns
 * the bound userId, or null.
 */
export function verifyLink(token: string | null | undefined, kind: LinkKind, secret: string): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  if (!safeEqual(mac, expected)) return null;
  try {
    const { k, u, e } = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
      k?: string;
      u?: string;
      e?: number;
    };
    if (k !== kind || typeof u !== "string" || typeof e !== "number" || e <= Date.now()) return null;
    return u;
  } catch {
    return null;
  }
}

function externalBase(env: NodeJS.ProcessEnv): string {
  return (env.ASTRO_EXTERNAL_AGENT_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/+$/, "");
}

/** Link a messaging user clicks to connect their own GitHub account. */
export function buildConnectUrl(userId: string, secret: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${externalBase(env)}/auth/github/login?link=${encodeURIComponent(mintLink("connect", userId, secret))}`;
}
