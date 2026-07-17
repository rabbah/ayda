/**
 * Persistent store abstraction.
 *
 * Holds per-user GitHub OAuth tokens (the reason we need durability — tokens
 * must survive restarts and be reused across a user's sessions) plus a general
 * kv for other per-interaction state.
 *
 * `userKey` is the stable client identity (the `bridge_uid` cookie), NOT a
 * single ephemeral bridge session — so a connected user stays connected across
 * reconnects and new sessions.
 *
 * SECURITY: refresh tokens (`ghr_`, 6-month) are the crown jewels. Today they're
 * stored as-is in the platform-managed Postgres (access-controlled). Encrypt at
 * rest before production — wrap put/get with a KMS data key (astro-infra already
 * uses KMS for the gateway dev keys). Marked TODO below.
 */

export interface GithubTokenRecord {
  accessToken: string; // ghu_...
  refreshToken: string | null; // ghr_...; null if the App disables token expiry
  expiresAt: number | null; // epoch ms; null if non-expiring
  refreshTokenExpiresAt: number | null; // epoch ms
  githubLogin: string | null;
  githubUserId: number | null;
  updatedAt: number; // epoch ms
}

export interface Store {
  init(): Promise<void>;
  getGithubToken(userKey: string): Promise<GithubTokenRecord | null>;
  /** TODO: encrypt refreshToken at rest (KMS) before persisting. */
  putGithubToken(userKey: string, rec: GithubTokenRecord): Promise<void>;
  deleteGithubToken(userKey: string): Promise<void>;
  kvGet(namespace: string, key: string): Promise<unknown | null>;
  kvPut(namespace: string, key: string, value: unknown): Promise<void>;
}

/** Non-durable fallback — used locally when no Postgres env is injected. */
export class InMemoryStore implements Store {
  private readonly tokens = new Map<string, GithubTokenRecord>();
  private readonly kv = new Map<string, unknown>();
  async init(): Promise<void> {}
  async getGithubToken(userKey: string): Promise<GithubTokenRecord | null> {
    return this.tokens.get(userKey) ?? null;
  }
  async putGithubToken(userKey: string, rec: GithubTokenRecord): Promise<void> {
    this.tokens.set(userKey, rec);
  }
  async deleteGithubToken(userKey: string): Promise<void> {
    this.tokens.delete(userKey);
  }
  async kvGet(namespace: string, key: string): Promise<unknown | null> {
    return this.kv.get(`${namespace}:${key}`) ?? null;
  }
  async kvPut(namespace: string, key: string, value: unknown): Promise<void> {
    this.kv.set(`${namespace}:${key}`, value);
  }
}
