/**
 * Resolved GitHub App OAuth credentials (single source of truth).
 *
 * Credentials come from exactly one place: the in-app setup flow (App-Manifest,
 * auth/setup.ts) mints a fresh GitHub App and stores its client_id/client_secret
 * in the Store's kv. There is no env-var path — an admin (ADMIN_EMAILS)
 * provisions the App from the web UI's "Set up GitHub App" button.
 *
 * loadAppCreds() runs once at boot to seed the in-memory cache from the DB;
 * saveAppCreds() updates both DB and cache when setup completes, so the OAuth
 * routes pick up a freshly-provisioned App with no restart. Everything else
 * reads getAppCreds().
 *
 * SECURITY: client_secret is stored plaintext in kv today, same posture as the
 * refresh tokens in store.ts. Encrypt at rest (KMS) before production — TODO
 * tracked alongside the token-encryption TODO in store.ts.
 */

import type { Store } from "../store/store.ts";

export interface GithubAppCreds {
  clientId: string;
  clientSecret: string;
  /** App slug, for display only (null when supplied via env). */
  slug?: string | null;
}

const KV_NS = "github_app";
const KV_KEY = "config";

let creds: GithubAppCreds | null = null;

/** The credentials the OAuth flow should use, or null if unconfigured. */
export function getAppCreds(): GithubAppCreds | null {
  return creds;
}

/** True once an App is configured (via setup or env). */
export function githubConfigured(): boolean {
  return creds != null;
}

/**
 * Seed the in-memory cache at boot from the self-provisioned App in the DB.
 * Safe to call before any request; leaves creds null until setup runs.
 */
export async function loadAppCreds(store: Store): Promise<void> {
  const stored = (await store.kvGet(KV_NS, KV_KEY)) as GithubAppCreds | null;
  creds =
    stored?.clientId && stored?.clientSecret
      ? { clientId: stored.clientId, clientSecret: stored.clientSecret, slug: stored.slug ?? null }
      : null;
}

/** Persist newly-provisioned App credentials and refresh the live cache. */
export async function saveAppCreds(store: Store, next: GithubAppCreds): Promise<void> {
  await store.kvPut(KV_NS, KV_KEY, next);
  creds = next;
}
