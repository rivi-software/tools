import { readFile } from "node:fs/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const KV_NAMESPACE_ID = /^[0-9a-f]{32}$/iu;
const ALL_ZEROS = /^[0-]+$/u;

/** The parts of a Wrangler config `assertDeployedBindings` reads. */
export interface BindingsConfig {
  d1_databases?: { binding?: string; database_id?: unknown }[];
  kv_namespaces?: { binding?: string; id?: unknown }[];
  previews?: BindingsConfig;
  env?: Record<string, BindingsConfig | undefined>;
}

export interface DeployedBindingsOptions {
  /**
   * Check the named environment (`wrangler deploy --env <name>`) instead of the top level.
   * Wrangler does not inherit bindings into an environment, so its own lists are what deploys.
   */
  environment?: string;
  /** Check the `previews` block, which `wrangler preview` deploys, of the top level or `environment`. */
  previews?: boolean;
}

const isString = (value: unknown): value is string => typeof value === "string";

const isConfigPath = (config: string | BindingsConfig): config is string =>
  typeof config === "string";

const isConfigObject = (value: unknown): value is BindingsConfig =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A string is matched first, so a `//` or a `,]` inside one stays.
const STRING_OR_COMMENT =
  /(?<string>"(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;

const STRING_OR_TRAILING_COMMA = /(?<string>"(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/gu;

const keepString = (_match: string, string: string | undefined) => string ?? "";

/** JSONC, as Wrangler reads `wrangler.json` and `wrangler.jsonc`: JSON with comments and trailing commas. */
const jsoncToJson = (text: string): string =>
  text
    .replace(/^\uFEFF/u, "")
    .replaceAll(STRING_OR_COMMENT, keepString)
    .replaceAll(STRING_OR_TRAILING_COMMA, keepString);

const placeholderIds = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the config comes from a JSON file, so its binding list is whatever that file held
  entries: unknown,
  list: string,
  key: string,
  form: RegExp
): string[] => {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.flatMap(
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- an entry of a hand-written config may carry any field, and only `key` and `binding` are read
    (entry: Record<string, unknown> | null, index) => {
      const id = entry?.[key];

      if (id === undefined) {
        return [];
      }

      if (isString(id) && form.test(id) && !ALL_ZEROS.test(id)) {
        return [];
      }

      const name = isString(entry?.binding) ? entry.binding : index;

      return [`${list}[${name}].${key} = ${JSON.stringify(id)}`];
    }
  );
};

const readWranglerConfig = async (
  configPath: string
): Promise<BindingsConfig> => {
  if (configPath.endsWith(".toml")) {
    throw new Error(
      `${configPath}: parse a TOML config yourself and pass the object`
    );
  }

  let config: unknown;

  try {
    config = JSON.parse(jsoncToJson(await readFile(configPath, "utf-8")));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    throw new Error(`${configPath} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }

  if (!isConfigObject(config)) {
    throw new Error(`${configPath} holds no Wrangler config object`);
  }

  return config;
};

/**
 * Refuses a config whose D1 or KV bindings carry a placeholder id, before a deploy script changes
 * anything: one error lists every such binding. A D1 `database_id` must be a UUID and a KV `id` 32
 * hexadecimal characters, neither all zeros, so `<DATABASE_ID>`, `TODO` and the like fail. A
 * binding without an id passes, because Wrangler provisions it on deploy.
 *
 * `config` is a path to a JSON or JSONC Wrangler config, such as the `wrangler.json` the Cloudflare
 * Vite plugin writes, or a config already parsed (parse a TOML one yourself).
 */
export const assertDeployedBindings = async (
  config: string | BindingsConfig,
  options: DeployedBindingsOptions = {}
): Promise<void> => {
  const where = isConfigPath(config) ? config : "The config";

  let block: BindingsConfig | undefined = isConfigPath(config)
    ? await readWranglerConfig(config)
    : config;

  let at = "";

  if (options.environment !== undefined) {
    at = `env.${options.environment}.`;
    block = block.env?.[options.environment];
  }

  if (options.previews) {
    at += "previews.";
    block = block?.previews;
  }

  if (!block) {
    throw new Error(`${where} has no ${at.slice(0, -1)} block`);
  }

  const placeholders = [
    ...placeholderIds(
      block.d1_databases,
      `${at}d1_databases`,
      "database_id",
      UUID
    ),
    ...placeholderIds(
      block.kv_namespaces,
      `${at}kv_namespaces`,
      "id",
      KV_NAMESPACE_ID
    ),
  ];

  if (placeholders.length) {
    throw new Error(
      [
        `${where} has placeholder binding ids:`,
        ...placeholders.map((line) => `  ${line}`),
        "A D1 database_id is a UUID and a KV namespace id is 32 hexadecimal characters, neither all zeros.",
      ].join("\n")
    );
  }
};
