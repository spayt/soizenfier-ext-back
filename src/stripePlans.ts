import type Stripe from "stripe";
import { appMonthlyPlans } from "./plans";

export type AppPlan = (typeof appMonthlyPlans)[number];

/** True when `price` charges exactly what `plan` says, monthly. */
export function isPlanPrice(price: Stripe.Price, plan: AppPlan): boolean {
  return (
    price.active &&
    price.unit_amount === plan.amountCents &&
    price.currency === plan.currency &&
    price.recurring?.interval === "month"
  );
}

/** Finds (or creates) the Stripe product tagged with this plan's id, keeping its name in sync. */
export async function ensurePlanProduct(stripe: Stripe, plan: AppPlan): Promise<string> {
  const search = await stripe.products.search({
    query: `metadata['appPlanId']:'${plan.id}'`,
  });
  const existing = search.data[0];
  if (existing) {
    if (existing.name !== plan.title) {
      await stripe.products.update(existing.id, { name: plan.title });
    }
    return existing.id;
  }
  const product = await stripe.products.create({
    name: plan.title,
    metadata: { appPlanId: plan.id },
  });
  return product.id;
}

/**
 * Leaves the product with exactly one active monthly price, at the plan's
 * amount: reuses a matching price, archives every other monthly price (old
 * amounts, duplicates), and creates the price if none matches.
 */
export async function ensurePlanPrice(
  stripe: Stripe,
  plan: AppPlan,
  productId: string,
): Promise<string> {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const monthly = prices.data.filter((p) => p.recurring?.interval === "month");
  const keep = monthly.find((p) => isPlanPrice(p, plan));

  for (const price of monthly) {
    if (price.id !== keep?.id) {
      await stripe.prices.update(price.id, { active: false });
    }
  }
  if (keep) return keep.id;

  const created = await stripe.prices.create({
    product: productId,
    unit_amount: plan.amountCents,
    currency: plan.currency,
    recurring: { interval: "month" },
    metadata: { appPlanId: plan.id },
  });
  return created.id;
}

export async function syncPlan(stripe: Stripe, plan: AppPlan) {
  const productId = await ensurePlanProduct(stripe, plan);
  const priceId = await ensurePlanPrice(stripe, plan, productId);
  return { productId, priceId };
}

/** HTML-escapes a value before it is inserted into an email template. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
