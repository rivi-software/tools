# RIVI tools

Small packages RIVI Software builds its own apps with, for Cloudflare Workers, Vite, React and TanStack Start, published to npm under [`@rivi-software`](https://www.npmjs.com/org/rivi-software). Each started as code in one of our apps and moved here once it was useful beyond it. Each lives in [`packages/`](packages) with its own README.

## Packages

| Package | What it does | Runs in |
| --- | --- | --- |
| [`cloudflare-deploy`](packages/cloudflare-deploy#readme) ([npm](https://www.npmjs.com/package/@rivi-software/cloudflare-deploy)) | Deploy helpers for Workers apps: environment guards, a post-deploy health check, a REST API client for D1, KV, R2 and Workers for Platforms, and skew protection that keeps earlier builds' client files served | Node, Workers |
| [`deploy-watch`](packages/deploy-watch#readme) ([npm](https://www.npmjs.com/package/@rivi-software/deploy-watch)) | Moves a tab that was open across a deploy onto the new build, at a moment that loses nothing | Browser, React, Vite |
| [`posthog-tanstack-start`](packages/posthog-tanstack-start#readme) ([npm](https://www.npmjs.com/package/@rivi-software/posthog-tanstack-start)) | PostHog error tracking for TanStack Start on Workers: the Worker's capture, Start middlewares, the browser SDK and the source map upload | Workers, browser, Vite |
| [`semgrep-github-report`](packages/semgrep-github-report#readme) ([npm](https://www.npmjs.com/package/@rivi-software/semgrep-github-report)) | Semgrep findings as one pull request comment it keeps up to date, or in the job summary, with only the job's `GITHUB_TOKEN` | GitHub Actions |
| [`vite-plugin-zod-jitless`](packages/vite-plugin-zod-jitless#readme) ([npm](https://www.npmjs.com/package/@rivi-software/vite-plugin-zod-jitless)) | Turns on Zod's `jitless` before any browser module builds a schema, so a strict Content-Security-Policy never sees Zod probe `new Function` | Vite |
| [`workers-mail`](packages/workers-mail#readme) ([npm](https://www.npmjs.com/package/@rivi-software/workers-mail)) | Mail from Workers through Amazon SES, and through Cloudflare Email Service's binding until SES is set up or when it refuses a message | Workers |

Each is published as `@rivi-software/<name>`. They are ESM only and ship JavaScript with type declarations. Where they run in Node, they support Node 22 and later.

## rivi-bot

[`rivi-bot`](rivi-bot#readme) is a GitHub Action and a reusable workflow rather than a package: a pull request review by Claude, run once a maintainer approves it.

## Contributing

Bug reports, fixes and ideas are welcome from anyone. With Node 24 and pnpm 12:

```bash
pnpm install
pnpm run verify
```

`verify` runs what CI runs. [CONTRIBUTING.md](CONTRIBUTING.md) covers proposing a change, what a pull request needs, the package conventions and how releases reach npm. Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md). [SECURITY.md](SECURITY.md) says how to report a vulnerability privately.

## License

[MIT](LICENSE)
