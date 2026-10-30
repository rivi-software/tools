# RIVI tools

Small packages RIVI Software builds its own apps with, for Cloudflare Workers, Vite, React and TanStack Start, published to npm under [`@rivi-software`](https://www.npmjs.com/org/rivi-software). Each started as code in one of our apps and moved here once it was useful beyond it. Each lives in [`packages/`](packages) with its own README.

The packages are ESM only and ship JavaScript with type declarations. Where they run in Node, they support Node 22 and later.

[`rivi-bot`](rivi-bot) is a GitHub Action rather than a package: a pull request review by Claude, run once a maintainer approves it.

## Contributing

Bug reports, fixes and ideas are welcome from anyone. With Node 24 and pnpm 12:

```bash
pnpm install
pnpm run verify
```

`verify` runs what CI runs. [CONTRIBUTING.md](CONTRIBUTING.md) covers proposing a change, what a pull request needs, the package conventions and how releases reach npm. Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md). [SECURITY.md](SECURITY.md) says how to report a vulnerability privately.

## License

[MIT](LICENSE)
