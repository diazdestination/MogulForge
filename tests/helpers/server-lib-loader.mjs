/**
 * Module-resolution hooks so node:test can import server-side lib modules
 * directly (outside Next.js):
 * - "server-only" resolves to an empty module (Next aliases it at build time);
 * - extensionless relative imports (e.g. "./db") fall back to "<spec>.ts",
 *   matching Next's resolution, since node's type stripping requires explicit
 *   extensions.
 * Register from a test file BEFORE importing any lib module:
 *   import { register } from "node:module";
 *   register("./helpers/server-lib-loader.mjs", import.meta.url);
 */
export async function resolve(specifier, context, nextResolve) {
  // Next's package exports omit the extension Node wants outside a Next build.
  if (specifier === "next/server" || specifier === "next/headers" || specifier === "next/navigation" || specifier === "next/cache") {
    return nextResolve(`${specifier}.js`, context);
  }
  if (specifier === "server-only") {
    return { url: "data:text/javascript,export%20default%20undefined;", shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-zA-Z]+$/.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      /* fall through to normal resolution */
    }
  }
  return nextResolve(specifier, context);
}
