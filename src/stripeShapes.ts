import type Stripe from "stripe";

// Stripe moved some fields between API versions. Webhook payloads use the API
// version configured on the webhook endpoint (Stripe Dashboard), which can
// differ from the version this library requests, so read both shapes.

/** Legacy (pre-2025-03-31) fields that newer typings no longer declare. */
type LegacySubscription = { current_period_start?: number; current_period_end?: number };
type LegacyInvoice = { subscription?: string | { id: string } | null };

/**
 * Current billing period of a subscription. Since API 2025-03-31 it lives on
 * each subscription item; before that it was on the subscription itself.
 */
export function subscriptionPeriod(subscription: Stripe.Subscription): {
  start: number | null;
  end: number | null;
} {
  const item = subscription.items?.data?.[0];
  const legacy = subscription as unknown as LegacySubscription;
  return {
    start: item?.current_period_start ?? legacy.current_period_start ?? null,
    end: item?.current_period_end ?? legacy.current_period_end ?? null,
  };
}

/**
 * ID of the subscription an invoice belongs to. Since API 2025-03-31 it is
 * `invoice.parent.subscription_details.subscription`; before, `invoice.subscription`.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const current = invoice.parent?.subscription_details?.subscription;
  const legacy = (invoice as unknown as LegacyInvoice).subscription;
  const sub = current ?? legacy ?? null;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}
