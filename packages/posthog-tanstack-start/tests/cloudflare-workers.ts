/** The Workers runtime module for the tests (`vitest.config.ts`): the Worker vars, and no request context. */
export const env = {
  POSTHOG_PROJECT_TOKEN: "phc_test",
  POSTHOG_HOST: "https://us.i.posthog.com",
} satisfies { POSTHOG_PROJECT_TOKEN?: string; POSTHOG_HOST?: string };

export const waitUntil = (_promise: Promise<unknown>) => {
  throw new Error("no request context");
};
