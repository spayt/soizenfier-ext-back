import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeStripe } from "./fakeStripe";

vi.mock("../src/utils", () => ({
  getStripe: (key: string) => {
    fakeStripe.keysUsed.push(key);
    return fakeStripe;
  },
}));
const sgMail = vi.hoisted(() => ({ setApiKey: vi.fn(), send: vi.fn() }));
vi.mock("@sendgrid/mail", () => ({ default: sgMail }));

import {
  createCheckoutSession,
  syncPlansToStripe,
  syncUserSubscriptions,
  createCustomerPortalSession,
  SoiZenFierPaymentEvent,
} from "../src/index";
import { appMonthlyPlans } from "../src/plans";
import * as functionsIndex from "../src/index";
import { call, createUserWithToken, db, resetEmulators, setStripeMode } from "./helpers";

const essential = appMonthlyPlans.find((p) => p.id === "essential")!;

const checkoutBody = (overrides: Record<string, unknown> = {}) => ({
  mode: "subscription",
  planId: "essential",
  title: "Essential Care",
  amount: essential.amountCents,
  currency: "cad",
  locale: "en",
  successUrl: "https://soizenfier.com/en/profile?checkout=success",
  cancelUrl: "https://soizenfier.com/en/pricing",
  ...overrides,
});

beforeEach(async () => {
  await resetEmulators();
  fakeStripe.reset();
  sgMail.setApiKey.mockReset();
  sgMail.send.mockReset().mockResolvedValue([{ statusCode: 202 }]);
  await setStripeMode("test");
});

// ── Authentication (shared by every authenticated endpoint) ──────────────────

describe.each([
  ["createCheckoutSession", createCheckoutSession],
  ["syncPlansToStripe", syncPlansToStripe],
  ["syncUserSubscriptions", syncUserSubscriptions],
  ["createCustomerPortalSession", createCustomerPortalSession],
])("%s — request guards", (_name, fn) => {
  it("answers CORS preflight with 204", async () => {
    expect((await call(fn, { method: "OPTIONS" })).statusCode).toBe(204);
  });

  it("rejects non-POST methods with 405", async () => {
    expect((await call(fn, { method: "GET" })).statusCode).toBe(405);
  });

  it("returns 401 without a token", async () => {
    expect((await call(fn, { body: checkoutBody() })).statusCode).toBe(401);
  });

  it("returns 401 with a forged token", async () => {
    const res = await call(fn, {
      headers: { Authorization: "Bearer not-a-real-token" },
      body: checkoutBody(),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── createCheckoutSession ────────────────────────────────────────────────────

describe("createCheckoutSession", () => {
  it.each([
    ["missing successUrl", { successUrl: undefined }],
    ["missing title", { title: undefined }],
    ["invalid mode", { mode: "donation" }],
    ["payment without amount", { mode: "payment", planId: undefined, amount: undefined }],
  ])("returns 400 for %s", async (_label, overrides) => {
    const { authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(createCheckoutSession, {
      headers: authHeader,
      body: checkoutBody(overrides),
    });
    expect(res.statusCode).toBe(400);
    expect(fakeStripe.checkoutSessionsCreated).toHaveLength(0);
  });

  it("charges the server-side plan amount, ignoring a tampered client amount", async () => {
    const { authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(createCheckoutSession, {
      headers: authHeader,
      body: checkoutBody({ amount: 1, currency: "usd" }),
    });
    expect(res.statusCode).toBe(200);
    const priceData = fakeStripe.checkoutSessionsCreated[0].line_items[0].price_data;
    expect(priceData.unit_amount).toBe(essential.amountCents);
    expect(priceData.currency).toBe("cad");
    expect(priceData.recurring).toEqual({ interval: "month" });
  });

  it.each([
    ["an unknown planId", { planId: "free-forever" }],
    ["no planId", { planId: undefined }],
  ])("refuses a subscription with %s", async (_label, overrides) => {
    const { authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(createCheckoutSession, {
      headers: authHeader,
      body: checkoutBody(overrides),
    });
    expect(res.statusCode).toBe(400);
    expect(fakeStripe.checkoutSessionsCreated).toHaveLength(0);
  });

  it("uses the synced Stripe price ID for the current mode when available", async () => {
    const price = fakeStripe.addPrice({ unit_amount: essential.amountCents });
    await db().collection("config").doc("stripePricing").set({
      essential: { testPriceId: price.id, livePriceId: "price_live_essential" },
    });
    const { authHeader } = await createUserWithToken("bob@example.com");
    await call(createCheckoutSession, { headers: authHeader, body: checkoutBody() });
    expect(fakeStripe.checkoutSessionsCreated[0].line_items).toEqual([
      { price: price.id, quantity: 1 },
    ]);
  });

  it.each([
    ["charges an old amount", { unit_amount: 9900 }],
    ["is archived", { unit_amount: 4950, active: false }],
    ["is in another currency", { unit_amount: 4950, currency: "usd" }],
    ["is yearly", { unit_amount: 4950, recurring: { interval: "year" } }],
  ])("ignores a stored price that %s and charges the plan amount inline", async (_l, overrides) => {
    const price = fakeStripe.addPrice(overrides);
    await db().collection("config").doc("stripePricing").set({ essential: { testPriceId: price.id } });
    const { authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(createCheckoutSession, { headers: authHeader, body: checkoutBody() });
    expect(res.statusCode).toBe(200);
    const [item] = fakeStripe.checkoutSessionsCreated[0].line_items;
    expect(item.price).toBeUndefined();
    expect(item.price_data.unit_amount).toBe(essential.amountCents);
  });

  it("falls back to the inline price when the stored price no longer exists", async () => {
    await db().collection("config").doc("stripePricing").set({ essential: { testPriceId: "price_deleted" } });
    const { authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(createCheckoutSession, { headers: authHeader, body: checkoutBody() });
    expect(res.statusCode).toBe(200);
    expect(fakeStripe.checkoutSessionsCreated[0].line_items[0].price_data.unit_amount)
      .toBe(essential.amountCents);
  });

  it("names the subscription from the server plan, not from the client title", async () => {
    const { authHeader } = await createUserWithToken("bob@example.com");
    await call(createCheckoutSession, {
      headers: authHeader,
      body: checkoutBody({ title: "Premium Plan <b>FREE</b>" }),
    });
    const params = fakeStripe.checkoutSessionsCreated[0];
    expect(params.line_items[0].price_data.product_data.name).toBe(essential.title);
    expect(params.subscription_data.metadata.planName).toBe(essential.title);
  });

  it("returns the session URL and tags the subscription with the Firebase user", async () => {
    const { uid, authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(createCheckoutSession, {
      headers: authHeader,
      body: checkoutBody({ locale: "fr" }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { url: string }).url).toMatch(/^https:\/\/checkout\.stripe\.test\//);

    const params = fakeStripe.checkoutSessionsCreated[0];
    expect(params.mode).toBe("subscription");
    expect(params.locale).toBe("fr");
    expect(params.subscription_data.metadata).toEqual({
      firebaseUserId: uid,
      planName: "Essential Care",
    });
  });

  it("creates the Stripe customer once and stores it under the test-mode field", async () => {
    const { uid, authHeader } = await createUserWithToken("bob@example.com", "Bob");
    await call(createCheckoutSession, { headers: authHeader, body: checkoutBody() });
    await call(createCheckoutSession, { headers: authHeader, body: checkoutBody() });

    expect(fakeStripe.customerStore.size).toBe(1);
    const user = (await db().collection("users").doc(uid).get()).data()!;
    const [customerId] = fakeStripe.customerStore.keys();
    expect(user.stripeTestCustomerId).toBe(customerId);
    expect(user.stripeCustomerId).toBeUndefined();
    expect(user.role).toBe("User");
    expect(fakeStripe.checkoutSessionsCreated[1].customer).toBe(customerId);
  });

  it("keeps an existing Administrator role when creating the customer", async () => {
    const { uid, authHeader } = await createUserWithToken("admin@example.com");
    await db().collection("users").doc(uid).set({ role: "Administrator" });
    await call(createCheckoutSession, { headers: authHeader, body: checkoutBody() });
    const user = (await db().collection("users").doc(uid).get()).data()!;
    expect(user.role).toBe("Administrator");
  });

  it("uses the live key and live customer field in live mode", async () => {
    await setStripeMode("live");
    const { uid, authHeader } = await createUserWithToken("bob@example.com");
    await call(createCheckoutSession, { headers: authHeader, body: checkoutBody() });
    expect(fakeStripe.keysUsed).toEqual(["sk_live_fake"]);
    const user = (await db().collection("users").doc(uid).get()).data()!;
    expect(user.stripeCustomerId).toMatch(/^cus_/);
    expect(user.stripeTestCustomerId).toBeUndefined();
  });

  it("falls back to test mode when no general parameters exist", async () => {
    await db().collection("generalparameters").doc("params").delete();
    const { authHeader } = await createUserWithToken("bob@example.com");
    await call(createCheckoutSession, { headers: authHeader, body: checkoutBody() });
    expect(fakeStripe.keysUsed).toEqual(["sk_test_fake"]);
  });

  it("returns 500 when Stripe rejects the session", async () => {
    fakeStripe.failCheckout = true;
    const { authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(createCheckoutSession, { headers: authHeader, body: checkoutBody() });
    expect(res.statusCode).toBe(500);
  });

  it("supports one-off payments with an explicit amount", async () => {
    const { authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(createCheckoutSession, {
      headers: authHeader,
      body: checkoutBody({ mode: "payment", planId: undefined, amount: 25000 }),
    });
    expect(res.statusCode).toBe(200);
    const params = fakeStripe.checkoutSessionsCreated[0];
    expect(params.line_items[0].price_data.unit_amount).toBe(25000);
    expect(params.line_items[0].price_data.recurring).toBeUndefined();
    expect(params.subscription_data).toBeUndefined();
  });
});

// ── syncPlansToStripe ────────────────────────────────────────────────────────

describe("syncPlansToStripe", () => {
  async function adminHeader() {
    const { uid, authHeader } = await createUserWithToken("admin@example.com");
    await db().collection("users").doc(uid).set({ role: "Administrator" });
    return authHeader;
  }

  it("returns 403 for a non-administrator", async () => {
    const { authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(syncPlansToStripe, { headers: authHeader });
    expect(res.statusCode).toBe(403);
    expect(fakeStripe.productStore.size).toBe(0);
  });

  it("creates one product and one monthly price per plan, with the plans.ts amounts", async () => {
    const res = await call(syncPlansToStripe, { headers: await adminHeader() });
    expect(res.statusCode).toBe(200);

    expect(fakeStripe.productStore.size).toBe(appMonthlyPlans.length);
    const stored = (await db().collection("config").doc("stripePricing").get()).data()!;
    for (const plan of appMonthlyPlans) {
      const price = fakeStripe.priceStore.get(stored[plan.id].testPriceId)!;
      expect(price.unit_amount).toBe(plan.amountCents);
      expect(price.currency).toBe(plan.currency);
      expect(price.recurring).toEqual({ interval: "month" });
      expect(stored[plan.id].livePriceId).toBeUndefined();
    }
  });

  it("is idempotent: a second run reuses the same products and prices", async () => {
    const header = await adminHeader();
    await call(syncPlansToStripe, { headers: header });
    const before = (await db().collection("config").doc("stripePricing").get()).data();
    await call(syncPlansToStripe, { headers: header });
    const after = (await db().collection("config").doc("stripePricing").get()).data();

    expect(after).toEqual(before);
    expect(fakeStripe.productStore.size).toBe(appMonthlyPlans.length);
    expect(fakeStripe.priceStore.size).toBe(appMonthlyPlans.length);
  });

  it("archives a stale price and creates a new one when a plan amount changed", async () => {
    const header = await adminHeader();
    await call(syncPlansToStripe, { headers: header });
    const stored = (await db().collection("config").doc("stripePricing").get()).data()!;
    const oldPriceId = stored.essential.testPriceId;
    // Simulate the price having been created at the old (pre-discount) amount.
    fakeStripe.priceStore.set(oldPriceId, {
      ...fakeStripe.priceStore.get(oldPriceId)!,
      unit_amount: 9900,
    });

    await call(syncPlansToStripe, { headers: header });
    const updated = (await db().collection("config").doc("stripePricing").get()).data()!;

    expect(updated.essential.testPriceId).not.toBe(oldPriceId);
    expect(fakeStripe.priceStore.get(oldPriceId)!.active).toBe(false);
    expect(fakeStripe.priceStore.get(updated.essential.testPriceId)!.unit_amount)
      .toBe(essential.amountCents);
    // Other plans untouched
    expect(updated.growth.testPriceId).toBe(stored.growth.testPriceId);
  });

  it("archives every other active monthly price, even when the stored price IDs were lost", async () => {
    // Real situation found by verify-stripe-prices: products synced at the old
    // amounts, and config/stripePricing missing in this environment.
    const header = await adminHeader();
    await call(syncPlansToStripe, { headers: header });
    const product = [...fakeStripe.productStore.values()].find((p) => p.metadata.appPlanId === "essential")!;
    for (const p of fakeStripe.priceStore.values()) {
      if (p.product === product.id) fakeStripe.priceStore.set(p.id, { ...p, unit_amount: 9900 });
    }
    const duplicate = fakeStripe.addPrice({ product: product.id, unit_amount: 9900 });
    await db().collection("config").doc("stripePricing").delete();

    await call(syncPlansToStripe, { headers: header });

    const active = [...fakeStripe.priceStore.values()]
      .filter((p) => p.product === product.id && p.active);
    expect(active).toHaveLength(1);
    expect(active[0].unit_amount).toBe(essential.amountCents);
    expect(fakeStripe.priceStore.get(duplicate.id)!.active).toBe(false);
    const stored = (await db().collection("config").doc("stripePricing").get()).data()!;
    expect(stored.essential.testPriceId).toBe(active[0].id);
  });

  it("keeps the live price ID when syncing in test mode", async () => {
    await db().collection("config").doc("stripePricing").set({
      essential: { livePriceId: "price_live_existing" },
    });
    await call(syncPlansToStripe, { headers: await adminHeader() });
    const stored = (await db().collection("config").doc("stripePricing").get()).data()!;
    expect(stored.essential.livePriceId).toBe("price_live_existing");
    expect(stored.essential.testPriceId).toMatch(/^price_/);
  });
});

// ── syncUserSubscriptions ────────────────────────────────────────────────────

describe("syncUserSubscriptions", () => {
  it("returns 400 when the user has no Stripe customer", async () => {
    const { authHeader } = await createUserWithToken("bob@example.com");
    const res = await call(syncUserSubscriptions, { headers: authHeader });
    expect(res.statusCode).toBe(400);
  });

  it("copies the customer's Stripe subscriptions into the user document", async () => {
    const { uid, authHeader } = await createUserWithToken("bob@example.com");
    await db().collection("users").doc(uid).set({ stripeTestCustomerId: "cus_bob" });
    const sub = fakeStripe.addSubscription({
      customer: "cus_bob",
      metadata: { planName: "Essential Care" },
    });
    fakeStripe.addSubscription({ customer: "cus_someone_else" });

    const res = await call(syncUserSubscriptions, { headers: authHeader });
    expect(res.body).toEqual({ synced: 1 });

    const user = (await db().collection("users").doc(uid).get()).data()!;
    expect(Object.keys(user.subscriptions)).toEqual([sub.id]);
    expect(user.subscriptions[sub.id]).toMatchObject({
      planName: "Essential Care",
      status: "active",
      amount: 4950,
      currency: "cad",
      interval: "month",
    });
  });
});

// ── createCustomerPortalSession ──────────────────────────────────────────────

describe("createCustomerPortalSession", () => {
  it("returns 400 when the user has no Stripe customer for the current mode", async () => {
    const { uid, authHeader } = await createUserWithToken("bob@example.com");
    // Live customer exists, but we are in test mode
    await db().collection("users").doc(uid).set({ stripeCustomerId: "cus_live_bob" });
    const res = await call(createCustomerPortalSession, { headers: authHeader });
    expect(res.statusCode).toBe(400);
  });

  it("opens the portal for the user's customer with the requested return URL", async () => {
    const { uid, authHeader } = await createUserWithToken("bob@example.com");
    await db().collection("users").doc(uid).set({ stripeTestCustomerId: "cus_bob" });
    const res = await call(createCustomerPortalSession, {
      headers: authHeader,
      body: { returnUrl: "https://soizenfier.com/fr/profile" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ url: "https://billing.stripe.test/session" });
    expect(fakeStripe.portalSessionsCreated[0]).toEqual({
      customer: "cus_bob",
      return_url: "https://soizenfier.com/fr/profile",
    });
  });
});

// ── SoiZenFierPaymentEvent (webhook) ─────────────────────────────────────────

describe("SoiZenFierPaymentEvent", () => {
  function signedRequest(event: object, secret = "whsec_test_fake") {
    const payload = JSON.stringify(event);
    const signature = fakeStripe.webhooks.generateTestHeaderString({ payload, secret });
    return {
      headers: { "stripe-signature": signature },
      rawBody: Buffer.from(payload),
    };
  }

  const subscriptionEvent = (type: string, sub: object) => ({
    id: "evt_1",
    object: "event",
    type,
    data: { object: sub },
  });

  it("returns 400 without a signature header", async () => {
    const res = await call(SoiZenFierPaymentEvent, { body: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const sub = fakeStripe.addSubscription({ metadata: { firebaseUserId: "u1" } });
    const res = await call(
      SoiZenFierPaymentEvent,
      signedRequest(subscriptionEvent("customer.subscription.updated", sub), "whsec_attacker"),
    );
    expect(res.statusCode).toBe(400);
    expect((await db().collection("users").doc("u1").get()).exists).toBe(false);
  });

  it("creates the user document on the first subscription event", async () => {
    const sub = fakeStripe.addSubscription({
      metadata: { firebaseUserId: "u1", planName: "Growth Plan" },
    });
    const res = await call(
      SoiZenFierPaymentEvent,
      signedRequest(subscriptionEvent("customer.subscription.created", sub)),
    );
    expect(res.statusCode).toBe(200);

    const user = (await db().collection("users").doc("u1").get()).data()!;
    expect(user.uid).toBe("u1");
    expect(user.subscriptions[sub.id]).toMatchObject({ planName: "Growth Plan", status: "active" });
  });

  it("updates one subscription as a nested field without touching the others", async () => {
    await db().collection("users").doc("u1").set({
      role: "Administrator",
      subscriptions: { sub_other: { status: "canceled" } },
    });
    const sub = fakeStripe.addSubscription({
      status: "past_due",
      cancel_at: 1_765_000_000,
      metadata: { firebaseUserId: "u1" },
    });
    await call(
      SoiZenFierPaymentEvent,
      signedRequest(subscriptionEvent("customer.subscription.updated", sub)),
    );

    const user = (await db().collection("users").doc("u1").get()).data()!;
    // Real Firestore semantics: the dotted key must land as a nested map entry,
    // not as a literal "subscriptions.<id>" field.
    expect(user[`subscriptions.${sub.id}`]).toBeUndefined();
    expect(user.subscriptions.sub_other).toEqual({ status: "canceled" });
    expect(user.subscriptions[sub.id].status).toBe("past_due");
    expect(user.subscriptions[sub.id].cancel_at.toMillis()).toBe(1_765_000_000_000);
    expect(user.role).toBe("Administrator");
  });

  it("ignores subscriptions without a firebaseUserId", async () => {
    const sub = fakeStripe.addSubscription();
    const res = await call(
      SoiZenFierPaymentEvent,
      signedRequest(subscriptionEvent("customer.subscription.updated", sub)),
    );
    expect(res.statusCode).toBe(200);
    expect((await db().collection("users").get()).empty).toBe(true);
  });

  it("on checkout.session.completed, stores the live subscription status and emails the admin", async () => {
    const sub = fakeStripe.addSubscription({
      metadata: { firebaseUserId: "u1", planName: "Essential Care" },
    });
    const session = {
      id: "cs_1",
      object: "checkout.session",
      mode: "subscription",
      subscription: sub.id,
      customer_details: { name: "Bob <script>", email: "bob@example.com" },
    };
    const res = await call(
      SoiZenFierPaymentEvent,
      signedRequest(subscriptionEvent("checkout.session.completed", session)),
    );
    expect(res.statusCode).toBe(200);

    const user = (await db().collection("users").doc("u1").get()).data()!;
    expect(user.subscriptions[sub.id].status).toBe("active");

    expect(sgMail.send).toHaveBeenCalledTimes(1);
    const mail = sgMail.send.mock.calls[0][0];
    expect(mail.to.email).toBe("admin@soizenfier.com");
    expect(mail.replyTo).toEqual({ email: "bob@example.com", name: "Bob <script>" });
    expect(mail.html).toContain("$49.50");
    // The customer controls their name: it must be escaped in the HTML.
    expect(mail.html).toContain("Bob &lt;script&gt;");
    expect(mail.html).not.toContain("<script>");
  });

  it("on invoice.payment_succeeded, refreshes the subscription from Stripe", async () => {
    const sub = fakeStripe.addSubscription({ metadata: { firebaseUserId: "u1" } });
    const invoice = { id: "in_1", object: "invoice", subscription: sub.id };
    await call(
      SoiZenFierPaymentEvent,
      signedRequest(subscriptionEvent("invoice.payment_succeeded", invoice)),
    );
    const user = (await db().collection("users").doc("u1").get()).data()!;
    expect(user.subscriptions[sub.id].status).toBe("active");
    expect(sgMail.send).not.toHaveBeenCalled();
  });

  it("acknowledges unhandled event types", async () => {
    const res = await call(
      SoiZenFierPaymentEvent,
      signedRequest(subscriptionEvent("customer.created", { id: "cus_1" })),
    );
    expect(res.statusCode).toBe(200);
  });

  it("returns 500 when processing fails so Stripe retries", async () => {
    const session = {
      id: "cs_1",
      object: "checkout.session",
      mode: "subscription",
      subscription: "sub_does_not_exist",
    };
    const res = await call(
      SoiZenFierPaymentEvent,
      signedRequest(subscriptionEvent("checkout.session.completed", session)),
    );
    expect(res.statusCode).toBe(500);
  });
});

// ── Removed endpoints ──────────────────────────────────────────────────────────

describe("removed endpoints", () => {
  it.each(["addMessage", "helloSoiZenFier"])("%s is no longer exported (so not deployed)", (name) => {
    expect(name in functionsIndex).toBe(false);
  });
});
