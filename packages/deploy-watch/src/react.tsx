import { useEffect, useState, useSyncExternalStore } from "react";
import {
  BUILD_META_NAME,
  isChunkLoadError,
  isNewBuildLive,
  isWatching,
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

/**
 * The new-version notice's state: `show` once a newer build is live, until `dismiss`. `reload`
 * loads the page again on the new build; a page with unsaved work asks first, as it does for any
 * reload. Dismissed, the tab still moves onto the new build at its next move to another page.
 */
export function useNewBuildNotice(): { show: boolean; dismiss: () => void; reload: () => void } {
  const live = useSyncExternalStore(subscribeToNewBuild, isNewBuildLive, () => false);
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
