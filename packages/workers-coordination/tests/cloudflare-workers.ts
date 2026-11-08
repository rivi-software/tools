/** The Workers runtime module for the tests in Node (`vitest.config.ts`): a base class alone. */
export abstract class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- stands in for the runtime's own signature: the state object it passes is opaque to this package
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
