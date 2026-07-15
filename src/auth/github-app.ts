/**
 * GitHub App user-to-server OAuth (per-user, interactive).
 *
 * Uses ONLY client_id/client_secret (the App private key is for installation
 * tokens, which we don't use). No `scope` param — the App's configured
 * permissions govern access, and the App must be INSTALLED on the target repos
 * for the resulting user token to reach them.
 *
 * Token lifetimes (with "Expire user authorization tokens" enabled): access
 * `ghu_` = 8h, refresh `ghr_` = 6mo. Refresh ROTATES both tokens and invalidates
 * the old pair — so getValidToken() persists the rotated record before returning.
 */

import type { GithubTokenRecord, Store } from "../store/store.ts";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh when <5 min of access-token life remains

export function githubConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET);
}

function clientId(env: NodeJS.ProcessEnv): string {
  const v = env.GITHUB_APP_CLIENT_ID;
  if (!v) throw new Error("GITHUB_APP_CLIENT_ID is not set");
  return v;
}
function clientSecret(env: NodeJS.ProcessEnv): string {
  const v = env.GITHUB_APP_CLIENT_SECRET;
  if (!v) throw new Error("GITHUB_APP_CLIENT_SECRET is not set");
  return v;
}

export function callbackUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.ASTRO_EXTERNAL_AGENT_URL ?? `http://localhost:${env.PORT ?? 8080}`;
  return `${base.replace(/\/+$/, "")}/auth/github/callback`;
}

/** The authorize URL to redirect the user to. `state` is a CSRF nonce. */
export function authorizeUrl(state: string, env: NodeJS.ProcessEnv = process.env): string {
  const params = new URLSearchParams({
    client_id: clientId(env),
    redirect_uri: callbackUrl(env),
    state,
    // no `scope` — GitHub Apps use configured permissions
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<GithubTokenRecord> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(`GitHub token request failed (${res.status}): ${data.error_description ?? data.error ?? "no access_token"}`);
  }
  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
    refreshTokenExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null,
    githubLogin: null,
    githubUserId: null,
    updatedAt: now,
  };
}

/** Exchange an authorization code for a user token record (+ user identity). */
export async function exchangeCode(
  code: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubTokenRecord> {
  const rec = await postToken(
    { client_id: clientId(env), client_secret: clientSecret(env), code, redirect_uri: callbackUrl(env) },
    fetchImpl,
  );
  return attachUser(rec, fetchImpl);
}

export async function refresh(
  refreshToken: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubTokenRecord> {
  return postToken(
    { client_id: clientId(env), client_secret: clientSecret(env), grant_type: "refresh_token", refresh_token: refreshToken },
    fetchImpl,
  );
}

async function attachUser(rec: GithubTokenRecord, fetchImpl: typeof fetch): Promise<GithubTokenRecord> {
  try {
    const res = await fetchImpl(USER_URL, {
      headers: {
        Authorization: `Bearer ${rec.accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "claude-code-agui-bridge",
      },
    });
    if (res.ok) {
      const u = (await res.json()) as { login?: string; id?: number };
      rec.githubLogin = u.login ?? null;
      rec.githubUserId = u.id ?? null;
    }
  } catch {
    /* best-effort identity enrichment */
  }
  return rec;
}

/**
 * Return a currently-valid access token for the user, refreshing (and
 * persisting the rotated tokens) when the access token is expiring. Returns
 * null if the user hasn't connected, or the refresh token is gone/expired
 * (caller should prompt a reconnect).
 */
export async function getValidToken(
  store: Store,
  userKey: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const rec = await store.getGithubToken(userKey);
  if (!rec) return null;

  const expiring = rec.expiresAt != null && rec.expiresAt - Date.now() < REFRESH_BUFFER_MS;
  if (!expiring) return rec.accessToken;
  if (!rec.refreshToken) return rec.accessToken; // App configured non-expiring
  if (rec.refreshTokenExpiresAt != null && rec.refreshTokenExpiresAt < Date.now()) return null; // must reconnect

  const refreshed = await refresh(rec.refreshToken, env, fetchImpl);
  refreshed.githubLogin = rec.githubLogin;
  refreshed.githubUserId = rec.githubUserId;
  // Persist the rotated pair BEFORE returning — the old refresh token is now dead.
  await store.putGithubToken(userKey, refreshed);
  return refreshed.accessToken;
}
