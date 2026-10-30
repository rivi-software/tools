# RIVI tools

Small packages RIVI Software builds its own apps with, for Cloudflare Workers, Vite, React and TanStack Start, published to npm under [`@rivi-software`](https://www.npmjs.com/org/rivi-software). Each started as code in one of our apps and moved here once it was useful beyond it. Each lives in [`packages/`](packages) with its own README.

The packages are ESM only and ship JavaScript with type declarations. Where they run in Node, they support Node 22 and later.

## Development

Node 24 and pnpm 12:

```bash
pnpm install
pnpm run verify
```

`verify` runs what CI runs. [CONTRIBUTING.md](CONTRIBUTING.md) has the package conventions and how releases reach npm; [SECURITY.md](SECURITY.md) says how to report a vulnerability.

## License

[MIT](LICENSE)
