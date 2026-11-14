# @rivi-software/d1-migrations

## 0.1.4

### Patch Changes

- cee8392: Depend on `minimatch` 11.0.5 or later instead of 11.0.4. Globs match the same files as before, and a pattern with a numeric brace range of 100 or more values, such as `{0..999}`, compiles faster.

## 0.1.3

### Patch Changes

- 5fcdab0: The code now follows Ultracite's lint rules. It does what it did before, with the same exports and errors. The declarations differ in form: object types are interfaces, and functions are declared as constants. A type that is now an interface no longer fits a `Record<string, unknown>` parameter without a spread. In `@rivi-software/workers-coordination` and `@rivi-software/cloudflare-deploy`, an object a caller passes in, such as a Durable Object stub or a KV binding, declares its functions as properties instead of methods. Cloudflare's own bindings still fit. In `@rivi-software/workers-mail`, `fitReferences` returns an empty string for a value too long to fit that is only whitespace. It used to throw a `TypeError`.

## 0.1.2

### Patch Changes

- cedacc0: Depend on `minimatch` 11 instead of 10. Globs match the same files as before.

## 0.1.1

### Patch Changes

- 5c92074: Add doc comments to the `ReadD1MigrationsOptions`, `BundleD1MigrationsOptions`, `BundleD1MigrationsResult`, `MigrateD1Result`, `JournalOptions`, `JournalEntry`, `JournalCheck` and `JournalUpdate` types, and to `BundleD1MigrationsResult`'s `table` and `migrations`, so an editor shows them. This is the first version the release workflow publishes, with npm provenance; 0.1.0 was published by hand.
