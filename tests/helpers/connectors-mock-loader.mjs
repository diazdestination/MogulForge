/**
 * Resolves "@replit/connectors-sdk" to a stub that delegates to
 * globalThis.__connectorsMock, so tests can control workspace-connector
 * state and record proxied calls without connector env/credentials.
 * Set globalThis.__connectorsMock = { listConnections(), proxy() } BEFORE
 * importing any lib module that uses the SDK.
 */
const STUB = `
export class ReplitConnectors {
  listConnections(...a) { return globalThis.__connectorsMock.listConnections(...a); }
  proxy(...a) { return globalThis.__connectorsMock.proxy(...a); }
}
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@replit/connectors-sdk") {
    return { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
