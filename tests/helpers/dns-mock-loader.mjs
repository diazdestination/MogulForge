/**
 * Loader hook that replaces node:dns/promises with a controllable mock so
 * tests can drive TXT / CNAME lookup outcomes deterministically.
 * The mock delegates to globalThis.__dnsMock = { resolveTxt, resolveCname }.
 * Register from a test file BEFORE importing any lib module.
 */
const MOCK_URL =
  "data:text/javascript," +
  encodeURIComponent(
    "export const resolveTxt = (...a) => globalThis.__dnsMock.resolveTxt(...a);\n" +
    "export const resolveCname = (...a) => globalThis.__dnsMock.resolveCname(...a);\n",
  );

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:dns/promises" || specifier === "dns/promises") {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
