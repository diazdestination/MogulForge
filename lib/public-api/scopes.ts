/** Scopes for public API keys. Read scopes cover list/detail, write scopes cover mutations. */
export const API_SCOPES = [
  "leads:read",
  "leads:write",
  "imports:read",
  "campaigns:read",
  "campaigns:write",
  "messages:read",
  "conversations:read",
  "appointments:read",
  "appointments:write",
  "metrics:read",
  "webhooks:read",
  "webhooks:write",
  "usage:read",
  "embed:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "leads:read": "List and read leads",
  "leads:write": "Create and update leads",
  "imports:read": "Read import batches",
  "campaigns:read": "List and read campaigns",
  "campaigns:write": "Pause and resume campaigns",
  "messages:read": "Read message history",
  "conversations:read": "Read conversation threads",
  "appointments:read": "List and read appointments",
  "appointments:write": "Create and update appointments",
  "metrics:read": "Read overview metrics",
  "webhooks:read": "List outgoing webhook endpoints and deliveries",
  "webhooks:write": "Manage outgoing webhook endpoints",
  "usage:read": "Read API usage counters",
  "embed:write": "Issue embed session tokens",
};

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}
