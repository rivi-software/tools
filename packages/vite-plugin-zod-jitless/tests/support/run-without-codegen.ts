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
function counted(name: string, target: Function): Function {
  return new Proxy(target, {
    apply(target, self, args) {
      attempts.push(name);
      return Reflect.apply(target, self, args);
    },
    construct(target, args, newTarget) {
      attempts.push(name);
      return Reflect.construct(target, args, newTarget);
    },
  });
}

// Each way to compile a string: eval, and the constructor of each kind of function, both by its
// global name and through any function's `constructor`.
// oxlint-disable-next-line no-eval -- wraps eval to count the calls; never calls it
Object.assign(globalThis, { eval: counted("eval", eval), Function: counted("Function", Function) });
for (const kind of [function () {}, async function () {}, function* () {}, async function* () {}]) {
  const prototype = Object.getPrototypeOf(kind);
  const constructor = counted(prototype.constructor.name, prototype.constructor);
  Object.defineProperty(prototype, "constructor", { value: constructor });
}

const [target, modulesFile] = process.argv.slice(2);
if (modulesFile) {
  const modules: Record<string, string> = JSON.parse(readFileSync(modulesFile, "utf8"));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      const url = parent && parent in modules ? new URL(specifier, parent).href : specifier;
      if (url in modules) return { url, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url in modules) return { format: "module", source: modules[url], shortCircuit: true };
      return nextLoad(url, context);
    },
  });
}

await import(modulesFile ? target : pathToFileURL(target).href);
console.log(JSON.stringify({ attempts, result: (globalThis as { result?: unknown }).result }));
