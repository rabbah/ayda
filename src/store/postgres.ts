/**
 * Postgres-backed Store (platform-managed via astropods.yml `knowledge.db`).
 *
 * Reads the injected POSTGRES_* env (provider mode). `pg` is dynamically
 * imported in init() so this module still loads locally without the dep.
 */

import type { GithubTokenRecord, Store } from "./store.ts";

export class PostgresStore implements Store {
  private readonly env: NodeJS.ProcessEnv;
  private pool: {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  } | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async init(): Promise<void> {
    const pg = (await import("pg")).default as unknown as {
      Pool: new (cfg: Record<string, unknown>) => PostgresStore["pool"];
    };
    const e = this.env;
    this.pool = new pg.Pool({
      host: e.POSTGRES_HOST ?? e.KNOWLEDGE_DB_HOST,
      port: Number(e.POSTGRES_PORT ?? e.KNOWLEDGE_DB_PORT ?? 5432),
      user: e.POSTGRES_USER,
      password: e.POSTGRES_PASSWORD,
      database: e.POSTGRES_DB ?? e.POSTGRES_USER,
    });
    await this.q(`CREATE TABLE IF NOT EXISTS github_tokens (
      user_key text PRIMARY KEY,
      access_token text NOT NULL,
      refresh_token text,
      expires_at bigint,
      refresh_token_expires_at bigint,
      github_login text,
      github_user_id bigint,
      updated_at bigint NOT NULL
    )`);
    await this.q(`CREATE TABLE IF NOT EXISTS kv (
      ns text NOT NULL, k text NOT NULL, v jsonb NOT NULL, PRIMARY KEY (ns, k)
    )`);
  }

  private q(text: string, params?: unknown[]) {
    if (!this.pool) throw new Error("PostgresStore not initialized");
    return this.pool.query(text, params);
  }

  async getGithubToken(userKey: string): Promise<GithubTokenRecord | null> {
    const r = await this.q("SELECT * FROM github_tokens WHERE user_key=$1", [userKey]);
    const x = r.rows[0];
    if (!x) return null;
    return {
      accessToken: x.access_token as string,
      refreshToken: (x.refresh_token as string) ?? null,
      expiresAt: x.expires_at != null ? Number(x.expires_at) : null,
      refreshTokenExpiresAt: x.refresh_token_expires_at != null ? Number(x.refresh_token_expires_at) : null,
      githubLogin: (x.github_login as string) ?? null,
      githubUserId: x.github_user_id != null ? Number(x.github_user_id) : null,
      updatedAt: Number(x.updated_at),
    };
  }

  async putGithubToken(userKey: string, rec: GithubTokenRecord): Promise<void> {
    // TODO: encrypt rec.refreshToken (and accessToken) with a KMS data key here.
    await this.q(
      `INSERT INTO github_tokens
         (user_key, access_token, refresh_token, expires_at, refresh_token_expires_at, github_login, github_user_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_key) DO UPDATE SET
         access_token=$2, refresh_token=$3, expires_at=$4, refresh_token_expires_at=$5,
         github_login=$6, github_user_id=$7, updated_at=$8`,
      [userKey, rec.accessToken, rec.refreshToken, rec.expiresAt, rec.refreshTokenExpiresAt, rec.githubLogin, rec.githubUserId, rec.updatedAt],
    );
  }

  async deleteGithubToken(userKey: string): Promise<void> {
    await this.q("DELETE FROM github_tokens WHERE user_key=$1", [userKey]);
  }

  async kvGet(namespace: string, key: string): Promise<unknown | null> {
    const r = await this.q("SELECT v FROM kv WHERE ns=$1 AND k=$2", [namespace, key]);
    return r.rows[0] ? r.rows[0].v : null;
  }

  async kvPut(namespace: string, key: string, value: unknown): Promise<void> {
    await this.q(
      "INSERT INTO kv (ns,k,v) VALUES ($1,$2,$3) ON CONFLICT (ns,k) DO UPDATE SET v=$3",
      [namespace, key, JSON.stringify(value)],
    );
  }
}
