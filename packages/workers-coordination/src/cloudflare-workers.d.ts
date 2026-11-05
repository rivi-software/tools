// What the package uses of the Workers runtime module. A Worker has the whole module, from
// `wrangler types` or @cloudflare/workers-types; this stands in for the package's own check.
// `tests/types` checks the package against the real module, and `vitest.config.ts` points the
// tests that run in Node at `tests/cloudflare-workers.ts`.
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: {
      readonly storage: {
        readonly kv: {
          get<T>(key: string): T | undefined;
          put<T>(key: string, value: T): void;
        };
        setAlarm(scheduledTime: number | Date): Promise<void>;
        deleteAlarm(): Promise<void>;
        deleteAll(): Promise<void>;
      };
    };
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
