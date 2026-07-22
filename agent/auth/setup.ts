/**
 * GitHub App provisioning via GitHub's App-Manifest flow — web-driven.
 *
 * An admin opens the web UI and clicks "Set up GitHub App", which hits GET
 * /api/setup/github/start. That endpoint renders a page that POSTs a pre-filled
 * manifest to GitHub; GitHub creates the App and redirects to
 * /api/setup/github/callback with a code we exchange for the App's credentials.
 *
 * Access control: authorization is by verified email (isAdmin / ADMIN_EMAILS)
 * resolved from the ALB identity — chat can't do this (it has no email). The
 * manifest round-trip carries an HMAC-signed `state` (signState / verifyState)
 * so the callback can't be driven without a real start.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { GithubAppCreds } from "./app-config.ts";

const STATE_TTL_MS = 15 * 60 * 1000; // allows for time spent on GitHub's create screen

function parseAdminEmails(env: NodeJS.ProcessEnv): string[] {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether a verified email is on the admin allowlist (ADMIN_EMAILS).
 * Email is the admin key because it's the only human-knowable identity the
 * platform gives us — the opaque platform user id isn't something a deployer can
 * put in config ahead of time. Comparison is case-insensitive. Only the web
 * surface has a verified email (from the ALB); chat can't check admin (no email).
 */
export function isAdmin(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const want = (email ?? "").trim().toLowerCase();
  if (!want) return false;
  return parseAdminEmails(env).includes(want);
}

/** True when an explicit admin allowlist is configured (ADMIN_EMAILS non-empty). */
export function adminListConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseAdminEmails(env).length > 0;
}

/**
 * Whether this request may provision (set up) the GitHub App.
 * - ADMIN_EMAILS set   -> restricted to those emails (admins may also re-provision).
 * - ADMIN_EMAILS unset -> open to any authorized user, but only for the INITIAL
 *   setup: once the App is configured, provisioning is locked so a random user
 *   can't overwrite it and invalidate everyone's tokens. Set ADMIN_EMAILS to
 *   re-enable admin (re-)provisioning.
 */
export function canProvision(
  email: string,
  opts: { allowed: boolean; configured: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!opts.allowed) return false;
  return adminListConfigured(env) ? isAdmin(email, env) : !opts.configured;
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
    // PUBLIC so any teammate can install it on THEIR repos and connect. A private
    // App can only be installed by the account that owns it, so other users hit
    // `/apps/<slug>/installations/new` and get bounced to the App's landing page —
    // they can't connect. (Public only means "installable by others"; each install
    // is still explicit and repo-scoped, and the client secret stays secret.)
    public: true,
    // Installing the App also runs the OAuth authorize in one flow, so a single
    // install grants repo selection + write (contents/pull_requests) AND returns
    // the user token via the callback. Without this, install and OAuth are separate.
    request_oauth_on_install: true,
    setup_on_update: true,
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
