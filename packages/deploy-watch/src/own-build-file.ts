/**
 * Where each build's own copy of `build.json` is, from the client output's root: in the assets
 * directory, under a name with the build's id. A host that keeps a replaced build's assets keeps
 * it too, so a tab can read its own build's file after a deploy. The browser learns the id from
 * the page, so the name is in no chunk. Null for an id that is not a plain file name, which gets
 * no copy.
 */
export const ownBuildFilePath = (
  assetsDir: string,
  id: string
): string | null => {
  if (!/^[\w.-]{1,100}$/u.test(id)) {
    return null;
  }

  const dir = assetsDir.replaceAll(/^\/+|\/+$/gu, "");

  return `${dir ? `${dir}/` : ""}deploy-watch-${id}.json`;
};
