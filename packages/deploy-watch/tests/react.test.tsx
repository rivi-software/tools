// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DeployWatch from "../src/index.js";
import { useChunkErrorRecovery } from "../src/react.js";

/** A check `recoverFromChunkError` started, waiting for the test to settle it. */
interface PendingCheck {
  error: unknown;
  settle: (reloads: boolean) => void;
}

// A watching tab whose checks the test settles: each `recoverFromChunkError` waits in `checks`.
const tab = vi.hoisted(() => {
  const checks: PendingCheck[] = [];

  return { checks };
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- the hook reads the tab's watch through this module's own functions, which take no dependencies to inject
vi.mock(import("../src/index.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof DeployWatch>()),
  isWatching: () => true,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the real signature takes whatever the error boundary caught
  recoverFromChunkError: (error: unknown) =>
    // oxlint-disable-next-line promise/avoid-new -- the test keeps the resolver, to settle the check at the moment it chooses
    new Promise<boolean>((resolve) => {
      tab.checks.push({ error, settle: resolve });
    }),
  isReloadingOntoNewBuild: () => true,
  subscribeToReload: () => () => {
    // Nothing subscribed: there is nothing to unsubscribe from.
  },
}));

// SAFETY: React reads this flag off the global object to allow `act`; the global type does not
// name it, and nothing else in the test run reads it.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the error an error boundary caught, of any shape a thrown value can take
const ErrorScreen = ({ error }: { error: unknown }) => {
  if (useChunkErrorRecovery(error)) {
    return null;
  }

  // SAFETY: every error this test renders is an Error it built itself.
  return <p>{(error as Error).message}</p>;
};

/** An error screen the boundary keeps mounted while it catches one error after another. */
const errorScreen = () => {
  const page = document.createElement("div");
  const root = createRoot(page);
  roots.push(root);

  return {
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as above: whatever the boundary caught
    shows: (error: unknown) =>
      act(() => root.render(<ErrorScreen error={error} />)),
    text: () => page.textContent,
  };
};

const chunkError = (file: string) =>
  new TypeError(
    `Failed to fetch dynamically imported module: https://app.example/${file}`
  );

/** Settles the oldest check still waiting. */
const settle = (reloads: boolean) =>
  // oxlint-disable-next-line eslint/require-await -- `act` flushes React's effects only when its callback returns a promise
  act(async () => tab.checks.shift()?.settle(reloads));

describe(useChunkErrorRecovery, () => {
  afterEach(() => {
    act(() => {
      for (const root of roots.splice(0)) {
        root.unmount();
      }
    });
    tab.checks.length = 0;
  });

  it("a chunk error after another error is checked", async () => {
    const screen = errorScreen();
    await screen.shows(new Error("Inbox failed"));
    expect(screen.text()).toBe("Inbox failed");
    expect(tab.checks).toStrictEqual([]);

    const missing = chunkError("assets/inbox-a1.js");
    await screen.shows(missing);
    expect(screen.text()).toBe("");
    expect(tab.checks.map((check) => check.error)).toStrictEqual([missing]);
    await settle(true);
    expect(screen.text()).toBe("");
  });

  it("a chunk error after one the screen showed is checked again", async () => {
    const screen = errorScreen();
    await screen.shows(chunkError("assets/inbox-a1.js"));
    await settle(false);
    expect(screen.text()).toMatch(/^Failed to fetch/u);

    await screen.shows(chunkError("assets/settings-b2.js"));
    expect(screen.text()).toBe("");
    expect(tab.checks).toHaveLength(1);
    await settle(false);
    expect(screen.text()).toMatch(/settings-b2\.js$/u);
  });

  it("a check that settles after the next error does not decide for it", async () => {
    const screen = errorScreen();
    await screen.shows(chunkError("assets/inbox-a1.js"));
    const next = chunkError("assets/settings-b2.js");
    await screen.shows(next);
    expect(tab.checks).toHaveLength(2);
    // The first error's check would show the screen, but the screen has moved on to the next error.
    await settle(false);
    expect(screen.text()).toBe("");
    await settle(true);
    expect(screen.text()).toBe("");
  });

  it("the same error rendered again is checked once", async () => {
    const screen = errorScreen();
    const missing = chunkError("assets/inbox-a1.js");
    await screen.shows(missing);
    await settle(false);
    await screen.shows(missing);
    expect(tab.checks).toStrictEqual([]);
    expect(screen.text()).toMatch(/inbox-a1\.js$/u);
  });
});
