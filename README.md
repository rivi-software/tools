<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/rivi-tools-on-dark.svg">
      <img src="assets/rivi-tools.svg" alt="RIVI tools" width="280">
    </picture>
  </a>
</p>

<p align="center">
  The small packages <a href="https://rivi.software">RIVI Software</a> builds its own apps with,<br>
  for Cloudflare Workers, Vite, React and TanStack Start.
</p>

<p align="center">
  <a href="https://github.com/rivi-software/tools/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/rivi-software/tools/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <a href="https://www.npmjs.com/org/rivi-software"><img src="https://img.shields.io/badge/npm-%40rivi--software-0b6b3a" alt="npm: @rivi-software"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0b6b3a" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#packages">Packages</a>
  ·
  <a href="rivi-bot#readme">rivi-bot</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
  ·
  <a href="https://rivi.software">rivi.software</a>
</p>

<br>

Each package started as code in one of our apps and moved here once it was useful beyond it. They are published to npm under [`@rivi-software`](https://www.npmjs.com/org/rivi-software) and copied to [GitHub Packages](https://github.com/orgs/rivi-software/packages?repo_name=tools). Each lives in [`packages/`](packages) with its own README.

## Packages

| Package | What it does | Runs in |
| --- | --- | --- |
| [`cloudflare-deploy`](packages/cloudflare-deploy#readme) ([npm](https://www.npmjs.com/package/@rivi-software/cloudflare-deploy)) | Deploy helpers for Workers apps: environment guards, a post-deploy health check, a REST API client for D1, KV, R2 and Workers for Platforms, and skew protection that keeps earlier builds' client files served | Node, Workers |
| [`deploy-watch`](packages/deploy-watch#readme) ([npm](https://www.npmjs.com/package/@rivi-software/deploy-watch)) | Moves a tab that was open across a deploy onto the new build, at a moment that loses nothing | Browser, React, Vite |
| [`posthog-tanstack-start`](packages/posthog-tanstack-start#readme) ([npm](https://www.npmjs.com/package/@rivi-software/posthog-tanstack-start)) | PostHog error tracking for TanStack Start on Workers: the Worker's capture, Start middlewares, the browser SDK and the source map upload | Workers, browser, Vite |
| [`semgrep-github-report`](packages/semgrep-github-report#readme) ([npm](https://www.npmjs.com/package/@rivi-software/semgrep-github-report)) | Semgrep findings as one pull request comment it keeps up to date, or in the job summary, with only the job's `GITHUB_TOKEN` | GitHub Actions |
| [`vite-plugin-zod-jitless`](packages/vite-plugin-zod-jitless#readme) ([npm](https://www.npmjs.com/package/@rivi-software/vite-plugin-zod-jitless)) | Turns on Zod's `jitless` before any browser module builds a schema, so a strict Content-Security-Policy never sees Zod probe `new Function` | Vite |
| [`workers-mail`](packages/workers-mail#readme) ([npm](https://www.npmjs.com/package/@rivi-software/workers-mail)) | Mail from Workers through Amazon SES, and through Cloudflare Email Service's binding until SES is set up or when it refuses a message | Workers |

Each is published as `@rivi-software/<name>`. They are ESM only and ship JavaScript with type declarations. Where they run in Node, they support Node 22 and later. Each README starts with how to install its package and what else it needs, such as the versions of Vite, React or the framework it plugs into.

### Used together

Each package stands on its own. A few of them also cover for each other:

- **A deploy that breaks no open tab.** After a deploy, a tab still running the previous build fails on the next chunk it loads lazily. On Workers, [`cloudflare-deploy`](packages/cloudflare-deploy#skew-protection) keeps earlier builds' client files served for seven days after the deploy that replaced them, and [`deploy-watch`](packages/deploy-watch#readme) moves the tab onto the new build at its next navigation, or through a notice that offers the reload.
- **Errors worth reporting.** With `deploy-watch`, [`posthog-tanstack-start`](packages/posthog-tanstack-start#readme) reports a router error only when it is not a missing chunk that reloads the page: `recoverFromChunkError(error).then((reloading) => reloading || captureClientException(error))`.

### From GitHub Packages

Every release is on GitHub Packages too, as the same tarball npm has. GitHub Packages asks for a token even to install a public package. To install the `@rivi-software` packages from there, add this to the project's `.npmrc`:

```ini
@rivi-software:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then set `GITHUB_TOKEN` to a classic personal access token with `read:packages` or, in GitHub Actions, to the job's `GITHUB_TOKEN` with `packages: read`. Every other dependency still comes from npm.

## rivi-bot

[`rivi-bot`](rivi-bot#readme) is a set of GitHub Actions and a reusable workflow rather than a package: Claude on a repository's pull requests and issues. It reviews pull requests, and, where a repository turns them on, describes them, triages issues, fixes review findings, answers questions and reports on the backlog. RIVI Software runs it as RIVI Bot on its own repositories, this one included.

## Contributing

Bug reports, fixes and ideas are welcome from anyone. With Node 24 and pnpm 12:

```bash
pnpm install
pnpm run verify
```

`verify` runs what CI runs. [CONTRIBUTING.md](CONTRIBUTING.md) covers proposing a change, what a pull request needs, the package conventions and how releases reach npm. Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md). [SECURITY.md](SECURITY.md) says how to report a vulnerability privately.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 RIVI Software.

<br>

<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/rivi-mark-on-dark.svg">
      <img src="assets/rivi-mark.svg" alt="RIVI Software" width="36" height="36">
    </picture>
  </a>
</p>

<p align="center">
  <sub>RIVI tools is made by <a href="https://rivi.software">RIVI Software</a>, which builds software for radio stations.</sub>
</p>
