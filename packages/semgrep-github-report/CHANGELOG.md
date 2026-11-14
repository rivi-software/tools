# @rivi-software/semgrep-github-report

## 1.0.0

### Major Changes

- e686453: The package is now at 1.0.0, and its releases follow semantic versioning: a breaking change raises the major version. Nothing in the package changes in this release. Before, its 0.x versions could break in a minor release. A range such as `^0.4.0` does not pick up 1.0.0, so change it to `^1.0.0` to get this and later releases.

## 0.2.0

### Minor Changes

- f30f753: `--mode pr` now lists the findings of a pull request from a fork in the job summary, as `--mode summary` does, prints a line that says why and exits 0. It tells a fork apart by the event in `GITHUB_EVENT_PATH`: the pull request's head repository is not `GITHUB_REPOSITORY`. It makes no request to GitHub then, since GitHub gives a fork's pull request a read-only `GITHUB_TOKEN` by default. Before, the step failed with a 403 on every pull request from a fork, unless the workflow skipped it with a step condition. Those conditions can go: `if: github.event_name == 'pull_request'` on the step is enough. A 403 on a pull request from the repository itself still fails the step, and now names only the missing `pull-requests: write`. `--mode pr` reads the event with `--pr` too, and fails with the file's name when it cannot.

### Patch Changes

- 23b1cb4: `--mode pr` now updates only a comment that opens with `<!-- semgrep-scan -->` and that `github-actions[bot]` wrote, or the account the new `--author <login>` option names. Any other comment with the marker is left alone, and the command comments anew when none matches. Before, it updated the first comment that held the marker anywhere, so a person's comment that pasted or quoted the report, posted before the report's own, was the one it edited: GitHub refused the edit with a 403 on every run, or, with a token that could edit it, the command overwrote that person's comment. A workflow that runs the command with a GitHub App's or a person's token passes that account's login, such as `--author acme-scanner[bot]`. Without it, such a run adds a comment every time.

## 0.1.3

### Patch Changes

- dd04eee: The comment and the job summary show a finding's path, rule ID and message as written. A `|` or a line break in a path no longer splits its table row, and a backtick no longer ends a code span early. In a message, an invisible zero-width joiner keeps an `@` mention from notifying anyone, HTML such as `<!--` from hiding the rest of the comment, and a code fence from turning it into code. Links and email addresses in a message keep working.

## 0.1.2

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.

## 0.1.1

### Patch Changes

- 6177452: Declare Node 22 or later in `engines`, as the README already said, and describe the package's tests in the README.
