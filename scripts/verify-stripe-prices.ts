/**
 * Verifies the subscription prices against the REAL Stripe API in TEST mode.
 *
 *   npm run verify:stripe-prices            (from functions/) — read-only check
 *   npm run verify:stripe-prices -- --fix   also repairs Stripe TEST mode: same
 *                                           logic as the admin "Sync plans"
 *                                           (one active monthly price per plan,
 *                                           old amounts archived)
 *
 * Re-run after any change to plans, prices or checkout code. It checks:
 *   1. functions/src/plans.ts mirrors lib/pricing.ts (what the site displays).
 *   2. For each plan, a real test-mode Checkout Session built exactly like
 *      createCheckoutSession's inline fallback charges the expected amount.
 *   3. If the plans were synced to Stripe test mode (admin "Sync plans"),
 *      each product has exactly one active monthly price at the expected
 *      amount, and a Checkout Session using it charges that amount.
 *
 * Uses SOIZENFIER_STRIPE_TEST_SECRET_KEY from functions/.env.local and refuses
 * to run with anything other than an sk_test_ key. Checkout sessions it creates
 * are expired immediately; nothing is charged.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import Stripe from "stripe";
import { appMonthlyPlans } from "../src/plans";
import { syncPlan } from "../src/stripePlans";
import { monthlyPlans } from "../../lib/pricing";

type Outcome = "PASS" | "FAIL" | "SKIP";
const results: { outcome: Outcome; message: string }[] = [];
const report = (outcome: Outcome, message: string) => {
  results.push({ outcome, message });
  console.log(`${outcome.padEnd(4)}  ${message}`);
};

function loadTestKey(): string {
  const fromEnv = process.env.SOIZENFIER_STRIPE_TEST_SECRET_KEY;
  if (fromEnv) return fromEnv;
  const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
  const match = /^SOIZENFIER_STRIPE_TEST_SECRET_KEY=(.+)$/m.exec(envFile);
  return match?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
}

function checkMirror() {
  const expected = monthlyPlans
    .filter((p) => p.syncToStripe !== false)
    .map((p) => ({ id: p.id, amountCents: p.amountCents }));
  const actual = appMonthlyPlans.map((p) => ({ id: p.id, amountCents: p.amountCents }));
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    report("PASS", "functions/src/plans.ts matches lib/pricing.ts");
  } else {
    report("FAIL", `plans.ts ${JSON.stringify(actual)} ≠ lib/pricing.ts ${JSON.stringify(expected)}`);
  }
}

async function checkoutCharges(
  stripe: Stripe,
  lineItem: Stripe.Checkout.SessionCreateParams.LineItem,
) {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [lineItem],
    success_url: "https://soizenfier.com/verify-stripe-prices/success",
    cancel_url: "https://soizenfier.com/verify-stripe-prices/cancel",
    metadata: { createdBy: "verify-stripe-prices" },
  });
  await stripe.checkout.sessions.expire(session.id);
  return { amount: session.amount_total, currency: session.currency };
}

async function checkPlan(stripe: Stripe, plan: (typeof appMonthlyPlans)[number]) {
  const label = `${plan.id} (${(plan.amountCents / 100).toFixed(2)} ${plan.currency.toUpperCase()})`;

  // 2. Inline price, as used by createCheckoutSession before plans are synced.
  const inline = await checkoutCharges(stripe, {
    price_data: {
      currency: plan.currency,
      product_data: { name: plan.title },
      unit_amount: plan.amountCents,
      recurring: { interval: "month" },
    },
    quantity: 1,
  });
  if (inline.amount === plan.amountCents && inline.currency === plan.currency) {
    report("PASS", `${label}: inline checkout charges ${inline.amount} ${inline.currency}`);
  } else {
    report("FAIL", `${label}: inline checkout charges ${inline.amount} ${inline.currency}`);
  }

  // 3. Synced product/price.
  const search = await stripe.products.search({ query: `metadata['appPlanId']:'${plan.id}'` });
  if (search.data.length === 0) {
    report("SKIP", `${label}: not synced to Stripe test mode yet (run "Sync plans" from the admin page in test mode)`);
    return;
  }
  if (search.data.length > 1) {
    report("FAIL", `${label}: ${search.data.length} products carry appPlanId=${plan.id}`);
  }
  const product = search.data[0];
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const monthly = prices.data.filter((p) => p.recurring?.interval === "month");
  const matching = monthly.filter(
    (p) => p.unit_amount === plan.amountCents && p.currency === plan.currency,
  );
  if (monthly.length !== 1 || matching.length !== 1) {
    const found = monthly.map((p) => `${p.id}=${p.unit_amount} ${p.currency}`).join(", ") || "none";
    report("FAIL", `${label}: expected exactly one active monthly price at this amount, found: ${found} — run with --fix (test mode) or "Sync plans" from the admin page`);
    return;
  }
  const synced = await checkoutCharges(stripe, { price: matching[0].id, quantity: 1 });
  if (synced.amount === plan.amountCents) {
    report("PASS", `${label}: synced price ${matching[0].id} charges ${synced.amount} ${synced.currency}`);
  } else {
    report("FAIL", `${label}: synced price ${matching[0].id} charges ${synced.amount} ${synced.currency}`);
  }
}

async function main() {
  const key = loadTestKey();
  if (!key.startsWith("sk_test_")) {
    console.error("Refusing to run: SOIZENFIER_STRIPE_TEST_SECRET_KEY must be a Stripe TEST key (sk_test_…).");
    process.exit(2);
  }
  const stripe = new Stripe(key, { apiVersion: "2022-11-15" });

  checkMirror();

  if (process.argv.includes("--fix")) {
    for (const plan of appMonthlyPlans) {
      try {
        const { productId, priceId } = await syncPlan(stripe, plan);
        report("PASS", `${plan.id}: synced in test mode (product ${productId}, price ${priceId})`);
      } catch (err) {
        report("FAIL", `${plan.id}: sync failed — ${(err as Error).message}`);
      }
    }
  }

  for (const plan of appMonthlyPlans) {
    try {
      await checkPlan(stripe, plan);
    } catch (err) {
      report("FAIL", `${plan.id}: Stripe API error — ${(err as Error).message}`);
    }
  }

  const failed = results.filter((r) => r.outcome === "FAIL").length;
  const skipped = results.filter((r) => r.outcome === "SKIP").length;
  console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

main();
