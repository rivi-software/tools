/** The Workers runtime module for the tests in Node (`vitest.config.ts`): a base class alone. */
export abstract class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
