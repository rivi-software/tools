// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useChunkErrorRecovery } from "../src/react.js";

// A watching tab whose checks the test settles: each `recoverFromChunkError` waits in `checks`.
const tab = vi.hoisted(() => ({
  checks: [] as { error: unknown; settle: (reloads: boolean) => void }[],
}));

vi.mock("../src/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/index.js")>()),
  isWatching: () => true,
  recoverFromChunkError: (error: unknown) =>
    new Promise<boolean>((settle) => void tab.checks.push({ error, settle })),
  isReloadingOntoNewBuild: () => true,
  subscribeToReload: () => () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  tab.checks.length = 0;
});

function ErrorScreen({ error }: { error: unknown }) {
  if (useChunkErrorRecovery(error)) return null;
  return <p>{(error as Error).message}</p>;
}

/** An error screen the boundary keeps mounted while it catches one error after another. */
function errorScreen() {
  const page = document.createElement("div");
  const root = createRoot(page);
  roots.push(root);
  return {
    shows: (error: unknown) => act(() => root.render(<ErrorScreen error={error} />)),
    text: () => page.textContent,
  };
}

const chunkError = (path: string) =>
  new TypeError(`Failed to fetch dynamically imported module: https://app.example/${path}`);

/** Settles the oldest check still waiting. */
const settle = (reloads: boolean) => act(async () => tab.checks.shift()?.settle(reloads));

test("a chunk error after another error is checked", async () => {
  const screen = errorScreen();
  await screen.shows(new Error("Inbox failed"));
  expect(screen.text()).toBe("Inbox failed");
  expect(tab.checks).toEqual([]);

  const missing = chunkError("assets/inbox-a1.js");
  await screen.shows(missing);
  expect(screen.text()).toBe("");
  expect(tab.checks.map((check) => check.error)).toEqual([missing]);
  await settle(true);
  expect(screen.text()).toBe("");
});

test("a chunk error after one the screen showed is checked again", async () => {
  const screen = errorScreen();
  await screen.shows(chunkError("assets/inbox-a1.js"));
  await settle(false);
  expect(screen.text()).toMatch(/^Failed to fetch/);

  await screen.shows(chunkError("assets/settings-b2.js"));
  expect(screen.text()).toBe("");
  expect(tab.checks).toHaveLength(1);
  await settle(false);
  expect(screen.text()).toMatch(/settings-b2\.js$/);
});

test("a check that settles after the next error does not decide for it", async () => {
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

test("the same error rendered again is checked once", async () => {
  const screen = errorScreen();
  const missing = chunkError("assets/inbox-a1.js");
  await screen.shows(missing);
  await settle(false);
  await screen.shows(missing);
  expect(tab.checks).toEqual([]);
  expect(screen.text()).toMatch(/inbox-a1\.js$/);
});
