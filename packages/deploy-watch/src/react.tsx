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
  learnPageBuild,
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
export function BuildMeta() {
  const id = pageBuildId();
  return id ? <meta name={BUILD_META_NAME} content={id} /> : null;
}

export type NewBuildNoticeOptions = {
  /**
   * The module the page shows, as the Vite plugin's `modules` names it. The notice then shows only
   * once a deploy changes that module's code, or while the tab cannot tell; a deploy that changes
   * other code reaches the tab at its next move to another page. `null` for a page in no module,
   * where the notice never shows. Left out, every newer build shows it.
   */
  module?: string | null;
};

/**
 * The new-version notice's state: `show` once a newer build is live (with `module`, once it
 * changes that module), until `dismiss`. A dismissal holds in every notice of the tab, including
 * one that mounts later, until a later build has other browser code (with `module`, changes that
 * module again). `reload` loads the page again on the new build; a page with unsaved work asks
 * first, as it does for any reload. Dismissed, the tab still moves onto the new build at its next
 * move to another page.
 */
export function useNewBuildNotice({ module }: NewBuildNoticeOptions = {}): {
  show: boolean;
  dismiss: () => void;
  reload: () => void;
} {
  const show = useSyncExternalStore(
    subscribeToNewBuild,
    () =>
      module !== null &&
      (module === undefined ? isNewBuildLive() : isModuleChanged(module)) &&
      !isNewBuildNoticeDismissed(module),
    () => false,
  );
  const scoped = module !== undefined;
  // A notice for a module compares a later deploy with the page's own build, so it reads that
  // build's file while it is most likely still the live one.
  useEffect(() => {
    if (scoped) learnPageBuild();
  }, [scoped]);
  return {
    show,
    dismiss: () => {
      if (module !== null) dismissNewBuildNotice(module);
    },
    reload: () => reloadOntoNewBuild(),
  };
}

/**
 * For an error screen: true while a missing chunk is checked against the live build, and while the
 * page reloads onto a newer one (render a placeholder, not the error); false once the error is the
 * screen's to show, which includes a reload the user stayed through at the unsaved-work prompt.
 * The server render and any other error read false from the start.
 */
export function useChunkErrorRecovery(error: unknown): boolean {
  const [state, setState] = useState<"checking" | "reloading" | "shown">(() =>
    isWatching() && isChunkLoadError(error) ? "checking" : "shown",
  );
  const reloading = useSyncExternalStore(subscribeToReload, isReloadingOntoNewBuild, () => false);
  useEffect(() => {
    if (state !== "checking") return;
    let mounted = true;
    void recoverFromChunkError(error).then((reloads) => {
      if (mounted) setState(reloads ? "reloading" : "shown");
    });
    return () => {
      mounted = false;
    };
  }, [state, error]);
  return state === "checking" || (state === "reloading" && reloading);
}
