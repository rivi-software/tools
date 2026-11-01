import { useEffect, useState, useSyncExternalStore } from "react";
import {
  BUILD_META_NAME,
  isChunkLoadError,
  isModuleChanged,
  isNewBuildLive,
  isWatching,
  learnPageBuild,
  pageBuildId,
  recoverFromChunkError,
  reloadOntoNewBuild,
  subscribeToNewBuild,
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
 * changes that module), until `dismiss`. `reload` loads the page again on the new build; a page
 * with unsaved work asks first, as it does for any reload. Dismissed, the tab still moves onto the
 * new build at its next move to another page.
 */
export function useNewBuildNotice({ module }: NewBuildNoticeOptions = {}): {
  show: boolean;
  dismiss: () => void;
  reload: () => void;
} {
  const live = useSyncExternalStore(
    subscribeToNewBuild,
    () => (module === undefined ? isNewBuildLive() : module !== null && isModuleChanged(module)),
    () => false,
  );
  const scoped = module !== undefined;
  // A notice for a module compares a later deploy with the page's own build, so it reads that
  // build's file while it is most likely still the live one.
  useEffect(() => {
    if (scoped) learnPageBuild();
  }, [scoped]);
  const [dismissed, setDismissed] = useState(false);
  return {
    show: live && !dismissed,
    dismiss: () => setDismissed(true),
    reload: () => reloadOntoNewBuild(),
  };
}

/**
 * For an error screen: true while a missing chunk is checked against the live build, and while the
 * page reloads onto a newer one (render a placeholder, not the error); false once the error is the
 * screen's to show. The server render and any other error read false from the start.
 */
export function useChunkErrorRecovery(error: unknown): boolean {
  const [checking, setChecking] = useState(() => isWatching() && isChunkLoadError(error));
  useEffect(() => {
    if (!checking) return;
    let mounted = true;
    void recoverFromChunkError(error).then((reloading) => {
      if (mounted && !reloading) setChecking(false);
    });
    return () => {
      mounted = false;
    };
  }, [checking, error]);
  return checking;
}
