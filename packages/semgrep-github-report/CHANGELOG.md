# @rivi-software/semgrep-github-report

## 0.1.3

### Patch Changes

- dd04eee: The comment and the job summary show a finding's path, rule ID and message as written. A `|` or a line break in a path no longer splits its table row, and a backtick no longer ends a code span early. In a message, an invisible zero-width joiner keeps an `@` mention from notifying anyone, HTML such as `<!--` from hiding the rest of the comment, and a code fence from turning it into code. Links and email addresses in a message keep working.

## 0.1.2

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.

## 0.1.1

### Patch Changes

- 6177452: Declare Node 22 or later in `engines`, as the README already said, and describe the package's tests in the README.
