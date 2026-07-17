/**
 * Manual authorization for the browser frontend — the access check the
 * messaging sidecar runs for us, reproduced in-process.
 *
 * A frontend agent (agent.interfaces.frontend) has no sidecar, but the platform
 * still issues the same credentials, so we replicate the contract:
 *   1. Read the signed-in user's platform id from `x-amzn-oidc-identity` (the
 *      ALB injects it after OIDC login; it strips any client-sent copy, so we
 *      trust it without verifying a signature — see the doc's caveat).
 *   2. Call GET {iss}/api/v1/deployments/authorize?adapter=web with that
 *      identity, authenticated by the ASTRO_AUTHZ_TOKEN deploy token. `iss` is
 *      read from that token's payload (no separate URL env var).
 *   3. Use the returned `user_id` as the identity — this is the SAME platform
 *      user id the sidecar keys chat on (StreamOptions.userId), so a GitHub
 *      token connected in chat resolves for the same person in the browser.
 *   4. Cache the decision ~60s per identity so page navigation doesn't pay a
 *      round-trip per request.
 *   5. Fail closed on error (deny), matching the sidecar.
 *
 * Local dev (`ast project start`): no ASTRO_AUTHZ_TOKEN and no ALB headers, so
 * we return allowed with no userId and let callers fall back to the bridge_uid
 * cookie — devs aren't blocked. See docs.astropods.com/manual-authz.
 */

import type { IncomingMessage } from "node:http";

export interface AuthzResult {
  /** Final decision. Deny → the caller should 403 (or, for status, report anonymous). */
  allowed: boolean;
  /** Resolved platform user id, when the server could resolve one. */
  userId?: string;
}

const AUTHZ_PATH = "/api/v1/deployments/authorize";
const CACHE_TTL_MS = 60_000; // match the sidecar's ~60s grant cache
const REQUEST_TIMEOUT_MS = 5_000; // platform default

/** Decode a JWT payload segment without verifying the signature. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Header value as a single string (Node lower-cases header names). */
function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * The signed-in user's platform id, injected by the ALB after OIDC login.
 * Empty in local dev or for a request that didn't pass through the ALB.
 */
export function oidcIdentity(req: IncomingMessage): string {
  return header(req, "x-amzn-oidc-identity");
}

/**
 * The signed-in user's verified email, decoded from the ALB's identity JWT
 * (`x-amzn-oidc-data`). The authorize endpoint never returns email, so this
 * header is the only source. Empty if absent or unverified.
 */
export function oidcEmail(req: IncomingMessage): string {
  const data = header(req, "x-amzn-oidc-data");
  if (!data) return "";
  const claims = decodeJwtPayload(data);
  if (!claims) return "";
  return claims.email_verified ? ((claims.email as string) ?? "") : "";
}

export class Authorizer {
  private readonly token: string;
  private readonly issuer: string;
  private readonly cache = new Map<string, { result: AuthzResult; expires: number }>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.token = env.ASTRO_AUTHZ_TOKEN ?? "";
    const payload = this.token ? decodeJwtPayload(this.token) : null;
    this.issuer = (payload?.iss as string) ?? "";
  }

  /** True when the platform injected a deploy token (i.e. a real deployment). */
  get enabled(): boolean {
    return Boolean(this.token && this.issuer);
  }

  /**
   * Authorize a web request's identity. `identityId` comes from
   * `x-amzn-oidc-identity` (empty = anonymous, only allowed with an `anyone`
   * grant). Returns { allowed, userId }. Fails closed on error.
   */
  async authorize(identityId: string): Promise<AuthzResult> {
    // Dev fallback: no platform token locally, so don't block.
    if (!this.enabled) return { allowed: true };

    const now = Date.now();
    const cached = this.cache.get(identityId);
    if (cached && cached.expires > now) return cached.result;

    const url = new URL(this.issuer.replace(/\/+$/, "") + AUTHZ_PATH);
    url.searchParams.set("adapter", "web");
    if (identityId) {
      // identity_type and identity_id must be supplied together (else 400).
      url.searchParams.set("identity_type", "user");
      url.searchParams.set("identity_id", identityId);
    } // else: anonymous — server allows only if the adapter has an `anyone` grant

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 4xx = malformed input (don't retry); 5xx = transient. Either way we
    // fail closed here rather than retrying — the caller treats a throw as deny.
    if (!res.ok) throw new Error(`authz: ${res.status}`);
    const body = (await res.json()) as { allowed: boolean; user_id?: string };
    const result: AuthzResult = { allowed: body.allowed, userId: body.user_id };

    this.cache.set(identityId, { result, expires: now + CACHE_TTL_MS });
    return result;
  }
}
