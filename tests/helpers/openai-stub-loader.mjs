/**
 * Module-resolution hook that redirects lib/openai (the real OpenAI client
 * factory) to tests/helpers/openai-stub.mjs so unit tests can script model
 * responses without network access or an API key. Register AFTER
 * server-lib-loader from a test file:
 *   register("./helpers/server-lib-loader.mjs", import.meta.url);
 *   register("./helpers/openai-stub-loader.mjs", import.meta.url);
 * Then import the stub module directly to control responses — it resolves to
 * the same module instance the lib code receives.
 */
const STUB_URL = new URL("./openai-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (/(^|\/)openai(\.ts)?$/.test(specifier) && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const resolved = await nextResolve(specifier, context);
    if (/\/lib\/openai\.ts$/.test(resolved.url)) {
      return { url: STUB_URL, shortCircuit: true };
    }
    return resolved;
  }
  return nextResolve(specifier, context);
}
