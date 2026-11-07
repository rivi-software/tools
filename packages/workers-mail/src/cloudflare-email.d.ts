// What `sendRawWithBinding` uses of the Workers runtime's mail module. A Worker has the whole module, from
// `wrangler types` or @cloudflare/workers-types; this stands in for the package's own check, and the build emits
// nothing of it, so the published types need neither. `vitest.config.ts` points the tests at
// `tests/cloudflare-email.ts`.
declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
    readonly from: string;
    readonly to: string;
  }
}
