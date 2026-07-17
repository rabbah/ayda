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
 * Builds the environment for the spawned `claude` process. Talks to Anthropic
 * directly: sets ANTHROPIC_API_KEY (from injected secrets) and ANTHROPIC_MODEL,
 * and deliberately does NOT set ANTHROPIC_BASE_URL. The gateway swap adds the
 * base URL here and nowhere else.
 */
export function claudeSpawnEnv(
  model: ResolvedModel,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Precedence: explicit ANTHROPIC_BASE_URL > Astro managed gateway (ASTRO_GATEWAY_*) > direct key.
  
  // Astro's gateway is a Bifrost proxy whose `/anthropic` endpoint accepts
  // native Anthropic requests and routes them to its Bedrock model_list — so
  // Claude Code can use the gateway base URL directly (it appends /v1/messages).
  // No personal Anthropic key; the tenant virtual key authenticates and drives
  // per-key spend. IMPORTANT: model.id must match a gateway model_name
  // (claude-opus-4-8 / claude-sonnet-4-6 / claude-haiku-4-5), NOT a dated id.
  // (`drop_params: true` on the gateway may silently drop Bedrock-unsupported
  // fields — validate thinking/tool-use over a real gateway; see README.)
  const astroGatewayUrl = `${env.ASTRO_GATEWAY_URL}/anthropic`;
  const baseUrl = env.ANTHROPIC_BASE_URL ?? astroGatewayUrl;
  const authToken = env.ANTHROPIC_AUTH_TOKEN ?? (astroGatewayUrl ? env.ASTRO_GATEWAY_API_KEY : undefined);
  const apiKey = env.ANTHROPIC_API_KEY;

  if (baseUrl) {
    // `||` so empty strings fall through to the next credential source.
    const token = authToken || apiKey;
    if (!token) {
      throw new Error(
        "Gateway configured (ANTHROPIC_BASE_URL / ASTRO_GATEWAY_URL) but no non-empty credential — provide ANTHROPIC_AUTH_TOKEN, ASTRO_GATEWAY_API_KEY, or ANTHROPIC_API_KEY.",
      );
    }
    const childEnv: NodeJS.ProcessEnv = { ...env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: model.id };
    childEnv.ANTHROPIC_AUTH_TOKEN = token; // Authorization: Bearer (so the SDK has a credential)
    delete childEnv.ANTHROPIC_API_KEY; // never send x-api-key
    // The Astro gateway is Bifrost, which reads the virtual key ONLY from the
    // `x-bf-vk` header — it ignores Authorization/x-api-key (probed: both return
    // "virtual key is required"; x-bf-vk returns "virtual key not found" for a
    // bad value, i.e. it's the header actually read). Claude Code sends the
    // credential as Authorization: Bearer, so also surface it as x-bf-vk via
    // ANTHROPIC_CUSTOM_HEADERS, which the SDK-spawned child applies to every
    // request. Only for the Astro gateway path, not an explicit ANTHROPIC_BASE_URL.
    if (!env.ANTHROPIC_BASE_URL && env.ASTRO_GATEWAY_URL) {
      childEnv.ANTHROPIC_CUSTOM_HEADERS = `x-bf-vk: ${token}`;
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
  return { ...env, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_MODEL: model.id };
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
