/**
 * Model resolution + pricing — the ISOLATED swap seam.
 *
 * Everything about "which model, which credentials, what does a token cost"
 * lives here. Today it talks to Anthropic directly (no base URL, no gateway).
 * When we later route through a gateway, THIS is the only module that changes:
 * `resolveModel()` grows a gateway branch and `claudeSpawnEnv()` sets a base
 * URL — the supervisor, translator, and telemetry are untouched.
 *
 * NB: never log the resolved secret. `claudeSpawnEnv()` returns the child env
 * but callers must not print it; `describeAuth()` gives a redacted summary.
 */

export interface ResolvedModel {
  /** Model id passed to `claude --model` and used for pricing lookups. */
  id: string;
  /** Provider from astropod.yaml `models.anthropic.provider`. */
  provider: string;
}

/**
 * Reads the astropod.yaml model declaration as projected into the pod env.
 * Precedence: explicit ANTHROPIC_MODEL wins, else fall back to a sane default.
 * (The astropod loader is expected to surface `models.anthropic.*` as env;
 * a real impl may parse a mounted astropod.yaml instead — contained here.)
 */
export function resolveModel(env: NodeJS.ProcessEnv = process.env): ResolvedModel {
  const provider = env.ASTROPOD_MODEL_PROVIDER ?? "anthropic";
  const id = env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
  return { id, provider };
}

/**
 * Non-secret host vars the spawned agent genuinely needs to run: find its
 * binaries (node/git/gh/rg/bash) via PATH, locate config via HOME, write temp
 * files, and reach the model API (incl. through a corporate proxy / custom CA).
 * EVERYTHING ELSE in the host env is dropped (see claudeSpawnEnv) so neither the
 * model nor the tools it runs (e.g. `bash` -> `env`) can read host secrets like
 * AWS / DB / Astro credentials. The only host secrets forwarded are the model
 * credential (unavoidable — the CLI reads it from its env to call the API) and,
 * layered on by the caller, the user's GH_TOKEN.
 */
const PASSTHROUGH_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TZ",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "TEMP", "TMP",
  // networking / TLS — needed to reach the model API in some deployments
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  // Build-tool config (non-secret paths + limits). Forwarded so the sandbox's
  // baked Go/npm/pip tuning — caches on the /data volume, GOMEMLIMIT/GOMAXPROCS
  // to fit the small container — actually reaches the `go`/npm/pip processes the
  // agent spawns. Without these on the allowlist the tuning is stripped here and
  // builds run unbounded (→ OOM) with ephemeral caches (→ re-download every run).
  "GOMODCACHE", "GOCACHE", "GOFLAGS", "GOMEMLIMIT", "GOMAXPROCS", "GOPATH", "GOTOOLCHAIN",
  "npm_config_cache", "PIP_CACHE_DIR",
] as const;

/** A clean base env: only the allowlisted non-secret essentials from the host. */
function sandboxBaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) if (env[key] != null) base[key] = env[key];
  return base;
}

/**
 * Builds the SANDBOXED environment for the spawned `claude` process: a clean base
 * (sandboxBaseEnv) plus the model/auth vars only — NOT the full host env, which
 * the SDK would otherwise hand straight to the child and every tool the model
 * runs. Direct mode sets ANTHROPIC_API_KEY + ANTHROPIC_MODEL and deliberately
 * does NOT set ANTHROPIC_BASE_URL; the gateway swap adds the base URL here and
 * nowhere else.
 */
export function claudeSpawnEnv(
  model: ResolvedModel,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Precedence: explicit ANTHROPIC_BASE_URL > direct ANTHROPIC_API_KEY (opt-out) >
  // Astro managed gateway (ASTRO_GATEWAY_*).
  //
  // Astro's gateway is a Bifrost proxy whose `/anthropic` endpoint accepts native
  // Anthropic requests and routes to its Bedrock model_list (model.id is bedrock/-
  // prefixed below). Supplying your own ANTHROPIC_API_KEY OPTS OUT of the gateway
  // and talks to Anthropic directly with that key (bare model id). An explicit
  // ANTHROPIC_BASE_URL still wins over both.
  const apiKey = env.ANTHROPIC_API_KEY;
  // Use the Astro gateway only when it's injected AND no personal key was provided.
  const astroGatewayUrl =
    env.ASTRO_GATEWAY_URL && !apiKey ? `${env.ASTRO_GATEWAY_URL}/anthropic` : undefined;
  const baseUrl = env.ANTHROPIC_BASE_URL ?? astroGatewayUrl;
  const authToken = env.ANTHROPIC_AUTH_TOKEN ?? (astroGatewayUrl ? env.ASTRO_GATEWAY_API_KEY : undefined);

  if (baseUrl) {
    // `||` so empty strings fall through to the next credential source.
    const token = authToken || apiKey;
    if (!token) {
      throw new Error(
        "Gateway configured (ANTHROPIC_BASE_URL / ASTRO_GATEWAY_URL) but no non-empty credential — provide ANTHROPIC_AUTH_TOKEN, ASTRO_GATEWAY_API_KEY, or ANTHROPIC_API_KEY.",
      );
    }
    const childEnv: NodeJS.ProcessEnv = { ...sandboxBaseEnv(env), ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: model.id };
    childEnv.ANTHROPIC_AUTH_TOKEN = token; // Authorization: Bearer (so the SDK has a credential)
    delete childEnv.ANTHROPIC_API_KEY; // defensive: the sandboxed base never carries it — never send x-api-key
    // The Astro gateway is Bifrost, which reads the virtual key ONLY from the
    // `x-bf-vk` header — it ignores Authorization/x-api-key (probed: both return
    // "virtual key is required"; x-bf-vk returns "virtual key not found" for a
    // bad value, i.e. it's the header actually read). Claude Code sends the
    // credential as Authorization: Bearer, so also surface it as x-bf-vk via
    // ANTHROPIC_CUSTOM_HEADERS, which the SDK-spawned child applies to every
    // request. Only for the Astro gateway path, not an explicit ANTHROPIC_BASE_URL.
    if (!env.ANTHROPIC_BASE_URL && env.ASTRO_GATEWAY_URL) {
      childEnv.ANTHROPIC_CUSTOM_HEADERS = `x-bf-vk: ${token}`;
      // Bifrost (Bedrock-backed) serves Claude under `bedrock/<short-name>` ids and
      // the virtual key is scoped to those exact names. Verified: bare `claude-*`
      // AND fully-qualified `bedrock/anthropic.claude-*` both 401 ("virtual key not
      // found"); `bedrock/claude-opus-4-8` / `-sonnet-4-6` / `-haiku-4-5` return 200.
      // So prefix the main model, and pin Claude Code's background tiers (it also
      // calls a haiku/sonnet model) to served names. All overridable via env.
      childEnv.ANTHROPIC_MODEL = model.id.startsWith("bedrock/") ? model.id : `bedrock/${model.id}`;
      childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "bedrock/claude-haiku-4-5";
      childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "bedrock/claude-sonnet-4-6";
    }
    // The gateway is Bedrock-backed. Claude Code otherwise sends first-party-only
    // pre-release `anthropic-beta` flags (e.g. context-management, advanced-tool-use)
    // that Bedrock rejects with `400 invalid beta flag`. Anthropic's gateway
    // guidance is to disable these at the CLIENT, not strip them at the proxy.
    // Overridable; defaults on in gateway mode. (Direct mode keeps full betas.)
    childEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS =
      env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ?? "1";
    return childEnv;
  }

  // DIRECT MODE: talk to Anthropic directly with a personal/org key.
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set (expected from secrets/identity injection), and no gateway (ANTHROPIC_BASE_URL / ASTRO_GATEWAY_URL) is configured.",
    );
  }
  return { ...sandboxBaseEnv(env), ANTHROPIC_API_KEY: apiKey, ANTHROPIC_MODEL: model.id };
}

/** Redacted, log-safe description of the auth situation. Never returns the secret. */
export function describeAuth(env: NodeJS.ProcessEnv = process.env): string {
  const m = resolveModel(env);
  const gateway = env.ANTHROPIC_BASE_URL ?? env.ASTRO_GATEWAY_URL;
  if (gateway) {
    const tok = env.ANTHROPIC_AUTH_TOKEN ?? env.ASTRO_GATEWAY_API_KEY ?? env.ANTHROPIC_API_KEY;
    const tokDesc = tok ? `set (****${tok.slice(-4)})` : "MISSING";
    return `provider=${m.provider} model=${m.id} gateway=${gateway} auth=${tokDesc}`;
  }
  const k = env.ANTHROPIC_API_KEY;
  const src = k ? `set (${k.length} chars, ****${k.slice(-4)})` : "MISSING";
  return `provider=${m.provider} model=${m.id} apiKey=${src} (direct)`;
}

/* ---------------- Pricing ----------------
 * USD per 1M tokens. PIN + MAINTAIN: prices change; keep in sync with the
 * model catalog. Cache write ≈ 1.25× input, cache read ≈ 0.1× input.
 * Cost is normally taken from Claude's `result.total_cost_usd`; this table is
 * the FALLBACK when that field is absent, and the basis under a gateway.
 */
export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number; // 5m TTL write
  cacheReadPerMTok: number;
}

const PRICING: Record<string, Price> = {
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
};

export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Compute cost from token usage + pricing table. Returns null if we have no
 * price for the model (caller should then rely on Claude's reported cost).
 */
export function computeCostUsd(modelId: string, usage: UsageLike): number | null {
  const p = PRICING[modelId];
  if (!p) return null;
  const m = 1_000_000;
  const cost =
    ((usage.input_tokens ?? 0) * p.inputPerMTok +
      (usage.output_tokens ?? 0) * p.outputPerMTok +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWritePerMTok +
      (usage.cache_read_input_tokens ?? 0) * p.cacheReadPerMTok) /
    m;
  return Math.round(cost * 1e6) / 1e6;
}
