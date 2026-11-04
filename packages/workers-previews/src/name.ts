import { createHash } from "node:crypto";

/**
 * The longest a DNS label may be. A Preview's workers.dev host starts with the label
 * `<preview>-<worker>`, so the two names together must fit in it.
 */
export const MAX_LABEL_LENGTH = 63;

/** The options of `previewName`. */
export type PreviewNameOptions = {
  /** The branch production deploys from, which never gets a Preview. Default `main`. */
  productionBranch?: string;
  /** The Worker: when given, a name whose `<name>-<worker>` label is over 63 characters is refused. */
  worker?: string;
};

/** What `previewName` makes: `b-`, at most six characters of slug, `-`, then twelve of hash. */
const PREVIEW_NAME = /^b-[a-z0-9-]{1,6}-[a-f0-9]{12}$/;

/**
 * The Preview name for a branch: `b-`, the first six characters of the branch as a slug, and the
 * first 12 hexadecimal characters of the SHA-256 of the exact branch name. At most 21 characters,
 * so it fits a hostname label beside a Worker name of up to 41. Branches that make the same slug
 * (`feature/News`, `feature-news`) still get different names, because the hash covers the exact
 * name. Throws for an empty branch and for the production branch.
 */
export function previewName(branch: string, options: PreviewNameOptions = {}): string {
  if (!branch) throw new Error("A Preview needs a branch name");
  const production = options.productionBranch ?? "main";
  if (branch === production)
    throw new Error(`${branch} is the production branch, which gets no Preview`);
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 12);
  const name = `b-${slug.slice(0, 6).replace(/-$/, "") || "branch"}-${hash}`;
  if (options.worker !== undefined && `${name}-${options.worker}`.length > MAX_LABEL_LENGTH)
    throw new Error(
      `The Preview's hostname label ${name}-${options.worker} is over ${MAX_LABEL_LENGTH} characters: the Worker's name can have at most ${MAX_LABEL_LENGTH - name.length - 1}`,
    );
  return name;
}

/** Whether `name` has the form `previewName` gives, whatever branch it came from. */
export function isPreviewName(name: string): boolean {
  return PREVIEW_NAME.test(name);
}
