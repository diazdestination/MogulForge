/**
 * Billing-provider-neutral subscription adapter.
 *
 * No payment provider is hardcoded anywhere in the app: plan assignment,
 * account states, and admin overrides all go through this interface. When the
 * business picks a provider (Stripe, etc.), implement BillingAdapter for it
 * and register it here — nothing else in the codebase changes.
 *
 * Pure module (no server imports) so the adapter contract is unit-testable.
 */

export type BillingActionResult = {
  ok: boolean;
  /** Provider-side reference (subscription/customer id) when one exists. */
  providerRef: string | null;
  note: string;
};

export type BillingAdapter = {
  provider: string;
  /** Human description of how charges are collected under this adapter. */
  description: string;
  /** Whether clients can self-serve checkout/portal (manual billing cannot). */
  supportsSelfServe: boolean;
  createSubscription(input: { organizationId: string; planId: string }): Promise<BillingActionResult>;
  changePlan(input: { organizationId: string; billingRef: string | null; fromPlanId: string; toPlanId: string }): Promise<BillingActionResult>;
  cancelSubscription(input: { organizationId: string; billingRef: string | null }): Promise<BillingActionResult>;
  customerPortalUrl(input: { organizationId: string; billingRef: string | null }): Promise<string | null>;
};

/** Default adapter: invoicing handled outside the app; the app only tracks state. */
export function createManualBillingAdapter(): BillingAdapter {
  return {
    provider: "manual",
    description: "Manual billing — invoices are handled outside the app; plan and account state are managed by MogulForge admins.",
    supportsSelfServe: false,
    async createSubscription() {
      return { ok: true, providerRef: null, note: "Recorded locally. Invoice the client manually." };
    },
    async changePlan(input) {
      return { ok: true, providerRef: input.billingRef, note: `Plan change ${input.fromPlanId} → ${input.toPlanId} recorded locally. Adjust the client's invoice manually.` };
    },
    async cancelSubscription(input) {
      return { ok: true, providerRef: input.billingRef, note: "Cancellation recorded locally. Stop invoicing the client manually." };
    },
    async customerPortalUrl() {
      return null;
    },
  };
}

const registry = new Map<string, () => BillingAdapter>([["manual", createManualBillingAdapter]]);

/** Registers an adapter factory (e.g. a Stripe adapter, when the provider is chosen). */
export function registerBillingAdapter(provider: string, factory: () => BillingAdapter) {
  registry.set(provider, factory);
}

/**
 * Resolves the billing adapter for a provider name (an org subscription's
 * billing_provider column, or the BILLING_PROVIDER env default). Unknown
 * providers fall back to manual — explicitly, never silently to a live one.
 */
export function getBillingAdapter(providerName?: string | null): BillingAdapter {
  const name = (providerName ?? "").trim() || "manual";
  const factory = registry.get(name) ?? registry.get("manual")!;
  return factory();
}
