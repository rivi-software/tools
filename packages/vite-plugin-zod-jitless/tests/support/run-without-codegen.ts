/**
 * Imports the module at argv[2] in a process started with --disallow-code-generation-from-strings,
 * which refuses `eval` and `new Function` as a Content-Security-Policy without 'unsafe-eval' does,
 * and prints `globalThis.result` with every attempt to compile a string. A refusal the caller
 * catches shows up nowhere else, while a browser reports it. With argv[3], a JSON file of
 * { url: code }, it loads those URLs as ES modules, as a browser loads them from the dev server.
 *   node --disallow-code-generation-from-strings run-without-codegen.ts <file | url> [modules.json]
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const attempts: string[] = [];

/** Anything that compiles a string: `eval`, and each kind of function's constructor. */
type Compiler = (...args: never[]) => void;

const counted = <T extends Compiler>(name: string, target: T): T =>
  new Proxy(target, {
    apply(wrapped, self, args) {
      attempts.push(name);

      // oxlint-disable-next-line anti-slop/no-reflect-apply -- a proxy's apply trap forwards the receiver and the argument list it was handed
      return Reflect.apply(wrapped, self, args);
    },
    construct(wrapped, args, newTarget) {
      attempts.push(name);

      return Reflect.construct(wrapped, args, newTarget);
    },
  });

// Each way to compile a string: eval, and the constructor of each kind of function, both by its
// global name and through any function's `constructor`.
Object.assign(globalThis, {
  // oxlint-disable-next-line eslint/no-eval -- wraps eval to count the calls; never calls it
  eval: counted("eval", eval),
  Function: counted("Function", Function),
});

/** A sample of each kind of function: its prototype carries the constructor that compiles. */
const KINDS = [
  function plain() {
    // Never called.
  },
  // oxlint-disable-next-line eslint/require-await -- a sample, only ever read for its prototype
  async function asynchronous() {
    // Never called.
  },
  function* generator() {
    // Never called.
  },
  // oxlint-disable-next-line eslint/require-await -- a sample, only ever read for its prototype
  async function* asyncGenerator() {
    // Never called.
  },
];

for (const kind of KINDS) {
  const prototype = Object.getPrototypeOf(kind);

  const constructor = counted(
    prototype.constructor.name,
    prototype.constructor
  );

  Object.defineProperty(prototype, "constructor", { value: constructor });
}

const [target, modulesFile] = process.argv.slice(2);

if (modulesFile) {
  const modules: Record<string, string> = JSON.parse(
    readFileSync(modulesFile, "utf-8")
  );

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;

      const url =
        parent && parent in modules
          ? new URL(specifier, parent).href
          : specifier;

      if (url in modules) {
        return { url, shortCircuit: true };
      }

      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url in modules) {
        return { format: "module", source: modules[url], shortCircuit: true };
      }

      return nextLoad(url, context);
    },
  });
}

await import(modulesFile ? target : pathToFileURL(target).href);

// SAFETY: the module just imported writes its answer to `globalThis.result`, which the global type
// does not name; reading it off the wider shape yields that value or undefined.
console.log(
  JSON.stringify({
    attempts,
    result: (globalThis as { result?: unknown }).result,
  })
);
