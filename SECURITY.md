# Security

This policy covers the code in this repository: the `@rivi-software/*` packages on npm, the [rivi-bot](rivi-bot) GitHub Action and its reusable workflow, and the workflows that test, review and release them.

## Reporting a vulnerability

Report it privately, in either of two ways:

- [Report a vulnerability](https://github.com/rivi-software/tools/security/advisories/new) on GitHub, which opens a draft advisory only you and the maintainers see.
- Email **[oss-cybersecurity@rivi.software](mailto:oss-cybersecurity@rivi.software)**.

Do not open a public issue, pull request or discussion about it, and do not publish it before a fix is out.

Include what you can of:

- The package and version, or the rivi-bot tag or commit
- What an attacker can do with it, and what they need first: access, a configuration, a user's action
- How to reproduce it: steps, a proof of concept or a failing test
- A fix, if you have one in mind
- The name to credit, or that you would rather not be credited

Send one report per issue. If you are not sure whether something is a vulnerability, or whether it is in scope, report it anyway.

## What happens next

- We acknowledge your report within 3 working days.
- Within 10 working days, we tell you whether we can reproduce it, how serious we think it is and what we will do about it.
- We keep you posted until it is fixed, and agree with you when it goes public. We aim to release a fix within 90 days of your report, and sooner for a serious one.
- With the fix, we publish a [GitHub security advisory](https://github.com/rivi-software/tools/security/advisories), with a CVE where one applies, and credit you unless you would rather not be.

There is no bug bounty.

## Supported versions

| What                        | Gets fixes                              |
| --------------------------- | --------------------------------------- |
| `@rivi-software/*` packages | The latest published version            |
| rivi-bot                    | `main` and the latest `rivi-bot-v*` tag |

A fix comes out as a new version of the affected package, or a new `rivi-bot-v*` tag. Earlier versions are not patched: upgrade to get the fix.

## Scope

In scope, for example:

- A flaw in a package that an attacker can exploit in an app using it as its README describes: an injection, a leaked secret or token, a check that can be bypassed.
- A way to run code, read a secret or write to this repository through its workflows, for example from a pull request from a fork.
- A way to make rivi-bot do more than [its README](rivi-bot/README.md#safety) allows: run a command, edit a file, reveal a secret, or approve a pull request when `approve` is `false`.
- A way to publish a package to npm, or to move or delete a release tag, without a maintainer.

Out of scope:

- A vulnerability in a dependency that our packages do not expose. Report it upstream; if one of our packages does expose it, tell us.
- Text in a pull request that steers what a rivi-bot review says. Its README says the review cannot prevent that, which is why it only comments unless `approve` is `true`.
- A setup a README warns against, such as running rivi-bot on every push of an outside pull request instead of after a maintainer approves.
- An attack that first needs a maintainer's account, machine or credentials.
- Scanner output, a missing best practice or a version number on show, without a way to exploit it.

## Testing

Test against your own copy: a fork, a local checkout, or an app or repository you own.

- Do not open pull requests or issues here to try an attack on the workflows. Reproduce it in a fork, with your own secrets.
- Do not access, change or delete data that is not yours, and stop once you have shown the problem.
- Do not publish to, or tamper with, the `@rivi-software` packages on npm.
- No denial of service, spam or social engineering of maintainers.

## Safe harbor

If you research and report a vulnerability in good faith and follow this policy, we consider your research authorized, we will not take legal action against you over it, and if someone else does, we will make it known that you acted within this policy.

## Verifying a release

The packages are published by the release workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)), from `main`, through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) with provenance. npm shows the commit and the workflow run each version was built from, and `npm audit signatures` checks the signatures and provenance of the packages you installed.

A package's first version is the exception: a maintainer publishes it by hand, once, because npm adds a trusted publisher only to a package that already exists ([CONTRIBUTING.md](CONTRIBUTING.md#the-first-release-of-a-new-package)). It has no provenance. From then on, the release workflow publishes every version, and npm refuses a publish with a token.

Release tags (`@rivi-software/<name>@<version>`, `rivi-bot-v*`) are never moved or deleted. Pin rivi-bot to a commit SHA or to one of those tags.

A version without provenance that is not its package's first, or with provenance from another repository or workflow, did not come from us: report it.
