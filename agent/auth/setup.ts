/**
 * GitHub App provisioning via GitHub's App-Manifest flow — chat-driven.
 *
 * An admin runs `/setup-github` in a DM (see messaging/adapter.ts); the adapter
 * checks isAdmin() and hands back a signed setup link (auth/connect.ts). Opening
 * it hits GET /api/setup/github/start, which renders a page that POSTs a
 * pre-filled manifest to GitHub. GitHub creates the App and redirects to
 * /api/setup/github/callback with a code we exchange for the App's credentials.
 *
 * Access control: authorization happens in chat (isAdmin on the sidecar userId)
 * before a setup link is ever minted. The browser hops are then protected by
 * signatures keyed on the auto-generated server secret (auth/connect.ts):
 *   - the setup link is a kind-bound token (verifyLink(…, "setup", …)), so a
 *     per-user connect link can't be replayed to provision the App;
 *   - the manifest round-trip carries an HMAC-signed `state` (signState /
 *     verifyState) so the callback can't be driven without a real start.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { GithubAppCreds } from "./app-config.ts";

const STATE_TTL_MS = 15 * 60 * 1000; // allows for time spent on GitHub's create screen

/** Whether a messaging userId is allowed to provision the App (ADMIN_USER_IDS). */
export function isAdmin(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = (env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 && list.includes(userId);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function externalBase(env: NodeJS.ProcessEnv): string {
  return (env.ASTRO_EXTERNAL_AGENT_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/+$/, "");
}

/** Mint an HMAC-signed, time-limited `state` for the manifest round-trip. */
export function signState(secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify({ n: randomUUID(), e: Date.now() + STATE_TTL_MS })));
  const mac = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

/** Verify a `state` came from signState (correct HMAC) and hasn't expired. */
export function verifyState(state: string | null | undefined, secret: string): boolean {
  if (!state) return false;
  const dot = state.lastIndexOf(".");
  if (dot < 0) return false;
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  if (!safeEqual(mac, expected)) return false;
  try {
    const { e } = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
      e?: number;
    };
    return typeof e === "number" && e > Date.now();
  } catch {
    return false;
  }
}

export interface ManifestResult {
  /** JSON string the browser POSTs to GitHub as the `manifest` form field. */
  manifest: string;
  /** GitHub URL to POST the manifest to (carries the signed `state`). */
  manifestUrl: string;
}

/**
 * Build the App manifest + the GitHub URL to submit it to. Permissions mirror
 * what Ayda's agent needs through the user token (Contents + Pull requests);
 * no webhook/private-key machinery since Ayda only uses user-to-server OAuth.
 * `org` scopes the App to an organization instead of the personal account.
 */
export function buildManifest(secret: string, org?: string, env: NodeJS.ProcessEnv = process.env): ManifestResult {
  const base = externalBase(env);
  const manifest = {
    name: "Ayda",
    url: base,
    redirect_url: `${base}/api/setup/github/callback`,
    callback_urls: [`${base}/auth/github/callback`],
    setup_url: `${base}/`,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    },
  };
  const q = `?state=${encodeURIComponent(signState(secret))}`;
  const manifestUrl = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new${q}`
    : `https://github.com/settings/apps/new${q}`;
  return { manifest: JSON.stringify(manifest), manifestUrl };
}

/**
 * HTML page that auto-POSTs the manifest to GitHub. Required because GitHub's
 * App-Manifest creation is a form POST (not a GET redirect), so the flow needs
 * a browser page to submit it. Served by GET /api/setup/github/start.
 */
export function renderManifestForm(manifest: string, manifestUrl: string): string {
  const value = manifest
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Creating GitHub App…</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Redirecting to GitHub…</h1>
<p>Creating the GitHub App. If you are not redirected automatically, click the button.</p>
<form id="f" method="post" action="${manifestUrl}">
  <input type="hidden" name="manifest" value="${value}">
  <button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("f").submit();</script>
</body></html>`;
}

/**
 * Exchange the temporary manifest code for the created App's credentials. We
 * keep only client_id/client_secret (+ slug for display) — the private key and
 * webhook secret GitHub also returns are unused by the OAuth-only flow.
 */
export async function convertManifestCode(code: string, fetchImpl: typeof fetch = fetch): Promise<GithubAppCreds> {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "ada-setup" },
  });
  if (!res.ok) {
    throw new Error(`manifest conversion failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { client_id?: string; client_secret?: string; slug?: string };
  if (!data.client_id || !data.client_secret) {
    throw new Error("manifest conversion returned no credentials");
  }
  return { clientId: data.client_id, clientSecret: data.client_secret, slug: data.slug ?? null };
}
