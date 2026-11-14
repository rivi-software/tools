# @rivi-software/vite-plugin-zod-jitless

## 1.0.0

### Major Changes

- e686453: The package is now at 1.0.0, and its releases follow semantic versioning: a breaking change raises the major version. Nothing in the package changes in this release. Before, its 0.x versions could break in a minor release. A range such as `^0.4.0` does not pick up 1.0.0, so change it to `^1.0.0` to get this and later releases.

## 0.1.2

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.

## 0.1.1

### Patch Changes

- d0a65e1: Declare Node 22 or later in `engines`, as the README already said, and describe in the README how the tests prove that no string is compiled.
