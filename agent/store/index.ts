/** Store factory: Postgres when the platform injects it, else in-memory. */

import { InMemoryStore, type Store } from "./store.ts";
import { PostgresStore } from "./postgres.ts";

export type { Store, GithubTokenRecord } from "./store.ts";

export async function createStore(env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  const usePostgres = Boolean(env.POSTGRES_HOST ?? env.KNOWLEDGE_DB_HOST);
  const store: Store = usePostgres ? new PostgresStore(env) : new InMemoryStore();
  await store.init();
  console.log(`[bridge] store: ${usePostgres ? "postgres" : "in-memory (no POSTGRES_* injected)"}`);
  return store;
}
