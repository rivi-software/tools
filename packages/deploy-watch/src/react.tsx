import { useEffect, useState, useSyncExternalStore } from "react";

import {
  BUILD_META_NAME,
  dismissNewBuildNotice,
  isChunkLoadError,
  isModuleChanged,
  isNewBuildLive,
  isNewBuildNoticeDismissed,
  isReloadingOntoNewBuild,
  isWatching,
  pageBuildId,
  recoverFromChunkError,
  reloadOntoNewBuild,
  subscribeToNewBuild,
  subscribeToReload,
} from "./index.js";

/**
 * The page's build id, for the browser to compare with `/build.json`: render it in the document's
 * `<head>`. In the browser it reads the id back from the page, so hydration renders the same tag.
 * Nothing in development or in a build without an id.
 */
export const BuildMeta = () => {
  const id = pageBuildId();

  return id ? <meta name={BUILD_META_NAME} content={id} /> : null;
};

export interface NewBuildNoticeOptions {
  /**
   * The module the page shows, as the Vite plugin's `modules` names it. The notice then shows only
   * once a deploy changes that module's code, or while the tab cannot tell; a deploy that changes
   * other code reaches the tab at its next move to another page. `null` for a page in no module,
   * where the notice never shows. Left out, every newer build shows it.
   */
  module?: string | null;
}

/**
 * The new-version notice's state: `show` once a newer build is live (with `module`, once it
 * changes that module), until `dismiss`. A dismissal holds in every notice of the tab, including
 * one that mounts later, until a later build has other browser code (with `module`, changes that
 * module again). `reload` loads the page again on the new build; a page with unsaved work asks
 * first, as it does for any reload. Dismissed, the tab still moves onto the new build at its next
 * move to another page.
 */
export const useNewBuildNotice = ({ module }: NewBuildNoticeOptions = {}) => {
  const show = useSyncExternalStore(
    subscribeToNewBuild,
    () =>
      module !== null &&
      (module === undefined ? isNewBuildLive() : isModuleChanged(module)) &&
      !isNewBuildNoticeDismissed(module),
    () => false
  );

  return {
    show,
    dismiss: () => {
      if (module !== null) {
        dismissNewBuildNotice(module);
      }
    },
    reload: () => reloadOntoNewBuild(),
  };
};

/**
 * For an error screen: true while a missing chunk is checked against the live build, and while the
 * page reloads onto a newer one (render a placeholder, not the error); false once the error is the
 * screen's to show, which includes a reload the user stayed through at the unsaved-work prompt.
 * The server render and any other error read false from the start. A screen that stays mounted
 * and renders again with another error checks that error afresh.
 */
interface ChunkErrorRecovery {
  error: unknown;
  state: "checking" | "reloading" | "shown";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever the error boundary caught, which nothing has parsed
const startRecovery = (error: unknown): ChunkErrorRecovery => ({
  error,
  state: isWatching() && isChunkLoadError(error) ? "checking" : "shown",
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the error an error screen caught, of any shape a thrown value can take
export const useChunkErrorRecovery = (error: unknown): boolean => {
  const [recovery, setRecovery] = useState(() => startRecovery(error));
  // The state belongs to one error. Another error starts over, and React renders again at once,
  // before the screen shows anything (its pattern for storing information from previous renders).
  let current = recovery;

  if (!Object.is(recovery.error, error)) {
    current = startRecovery(error);
    setRecovery(current);
  }

  const { state } = current;

  const reloading = useSyncExternalStore(
    subscribeToReload,
    isReloadingOntoNewBuild,
    () => false
  );

  useEffect(() => {
    if (state !== "checking") {
      return;
    }

    let active = true;

    const check = async () => {
      const reloads = await recoverFromChunkError(error);

      // The screen may have gone, or another error may have started over, meanwhile.
      if (active) {
        setRecovery({ error, state: reloads ? "reloading" : "shown" });
      }
    };

    void check();

    return () => {
      active = false;
    };
  }, [state, error]);

  return state === "checking" || (state === "reloading" && reloading);
};
