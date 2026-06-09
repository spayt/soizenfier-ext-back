import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import Stripe from "stripe";
import sgMail from "@sendgrid/mail";
import { GeneralParams, getStripe } from "./utils";
import { defineSecret } from "firebase-functions/params";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { appMonthlyPlans } from "./plans";

export { sendEmailVerificationCode, verifyEmailVerificationCode } from "./emailVerification";

admin.initializeApp();

function toFirestoreTimestamp(seconds?: number | null) {
  if (seconds == null) return null;
  return Timestamp.fromMillis(seconds * 1000);
}

const STRIPE_LIVE_SECRET_KEY = defineSecret(
  "SOIZENFIER_STRIPE_LIVE_SECRET_KEY",
);
const STRIPE_LIVE_WEBHOOK_SECRET = defineSecret(
  "SOIZENFIER_STRIPE_LIVE_WEBHOOK_SECRET",
);
const SENDGRID_API_KEY_SECRET = defineSecret("SOIZENFIER_SENDGRID_API_KEY");

export const helloSoiZenFier = onRequest((req, res) => {
  logger.info("SoiZenFier Cloud Function called", { structuredData: true });
  res.send("Hello from SoiZenFier Technologies Inc Cloud Function!");
});

export const addMessage = onRequest(async (req, res) => {
  const text =
    typeof req.query.text === "string" ? req.query.text : req.body?.text;

  if (!text || typeof text !== "string") {
    res.status(400).send("Provide a text query param or JSON body.");
    return;
  }

  const docRef = await admin.firestore().collection("messages").add({
    text,
    createdAt: FieldValue.serverTimestamp(),
  });

  res.send({ id: docRef.id, text });
});


async function updateUserSubscription(subscription: Stripe.Subscription) {
  const firebaseUserId = subscription.metadata?.firebaseUserId || null;
  if (!firebaseUserId) {
    logger.warn("Subscription has no firebaseUserId in metadata", {
      id: subscription.id,
    });
    return;
  }

  const userRef = admin.firestore().collection("users").doc(firebaseUserId);

  const subscriptionData = {
    id: subscription.id,
    planName: subscription.metadata?.planName || null,
    status: subscription.status,
    price_id: subscription.items?.data?.[0]?.price?.id || null,
    amount: subscription.items?.data?.[0]?.price?.unit_amount ?? null,
    currency: subscription.items?.data?.[0]?.price?.currency || null,
    interval:
      subscription.items?.data?.[0]?.price?.recurring?.interval || null,
    current_period_start: toFirestoreTimestamp(
      subscription.current_period_start,
    ),
    current_period_end: toFirestoreTimestamp(subscription.current_period_end),
    cancel_at: toFirestoreTimestamp(subscription.cancel_at),
    canceled_at: toFirestoreTimestamp(subscription.canceled_at),
    updatedAt: FieldValue.serverTimestamp(),
  };

  try {
    // Dot-path update merges only this subscription entry into the map
    await userRef.update({
      [`subscriptions.${subscription.id}`]: subscriptionData,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch {
    // Document may not exist yet on very first subscription event
    await userRef.set(
      {
        uid: firebaseUserId,
        subscriptions: { [subscription.id]: subscriptionData },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}

async function sendNewSubscriptionNotification(
  session: Stripe.Checkout.Session,
  subscription: Stripe.Subscription,
) {
  const isLocal = process.env.RUNNING_ON_LOCAL === "true";
  const sgKey = isLocal
    ? (process.env.SOIZENFIER_SENDGRID_API_KEY ?? "")
    : SENDGRID_API_KEY_SECRET.value();

  if (!sgKey) {
    logger.warn("SendGrid key not set — skipping subscription notification.");
    return;
  }

  const customerName  = (session.customer_details?.name  ?? "").trim() || "Customer";
  const customerEmail = (session.customer_details?.email ?? "").trim();
  const planName   = subscription.metadata?.planName || "Subscription Plan";
  const priceItem  = subscription.items?.data?.[0]?.price;
  const amountCents = priceItem?.unit_amount ?? 0;
  const currency   = (priceItem?.currency ?? "cad").toUpperCase();
  const amountFmt  = new Intl.NumberFormat("en-CA", {
    style: "currency", currency, minimumFractionDigits: 2,
  }).format(amountCents / 100);
  const startDate = new Date(subscription.current_period_start * 1000)
    .toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  const endDate = new Date(subscription.current_period_end * 1000)
    .toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });

  sgMail.setApiKey(sgKey);
  try {
    await sgMail.send({
      to:      { email: "admin@soizenfier.com", name: "SoiZenFier Technologies Inc." },
      from:    { email: "noreply@soizenfier.com", name: "SoiZenFier Technologies Inc." },
      replyTo: customerEmail ? { email: customerEmail, name: customerName } : undefined,
      subject: `New subscription — ${planName} (${customerName})`,
      html: buildSubscriptionEmail({
        customerName, customerEmail, planName,
        amountFmt, startDate, endDate,
        subscriptionId: subscription.id,
      }),
    });
    logger.info("Subscription notification sent", { subscriptionId: subscription.id });
  } catch (err) {
    logger.error("Failed to send subscription notification", err);
  }
}

function buildSubscriptionEmail(p: {
  customerName: string;
  customerEmail: string;
  planName: string;
  amountFmt: string;
  startDate: string;
  endDate: string;
  subscriptionId: string;
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:48px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
        <tr>
          <td style="background:#0f172a;padding:24px 36px;">
            <p style="margin:0;font-size:16px;font-weight:800;color:#ffffff;">SoiZenFier Technologies</p>
            <p style="margin:4px 0 0;font-size:12px;color:#94a3b8;">New subscription activated</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 36px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-bottom:16px;border-bottom:1px solid #f1f5f9;">
                  <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Customer</p>
                  <p style="margin:0;font-size:15px;font-weight:700;color:#0f172a;">${p.customerName}</p>
                  ${p.customerEmail ? `<a href="mailto:${p.customerEmail}" style="font-size:13px;color:#facc15;text-decoration:none;">${p.customerEmail}</a>` : ""}
                </td>
              </tr>
              <tr>
                <td style="padding:16px 0;border-bottom:1px solid #f1f5f9;">
                  <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Plan</p>
                  <p style="margin:0;font-size:15px;font-weight:700;color:#0f172a;">${p.planName}</p>
                  <p style="margin:2px 0 0;font-size:13px;color:#64748b;">${p.amountFmt} / month</p>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 0;border-bottom:1px solid #f1f5f9;">
                  <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Billing period</p>
                  <p style="margin:0;font-size:14px;color:#334155;">${p.startDate} → ${p.endDate}</p>
                </td>
              </tr>
              <tr>
                <td style="padding-top:16px;">
                  <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Subscription ID</p>
                  <p style="margin:0;font-size:12px;color:#94a3b8;font-family:'Courier New',monospace;">${p.subscriptionId}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:16px 36px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">© ${new Date().getFullYear()} SoiZenFier Technologies Inc.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function handleSoizenfierStripeWebhook(
  event: Stripe.Event,
  stripe: Stripe,
) {
  switch (event.type) {
    // Retrieve the subscription live so we get the confirmed (active) status,
    // not the transient "incomplete" that exists before payment is confirmed.
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription" && session.subscription) {
        const subId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subId);
        await updateUserSubscription(subscription);
        await sendNewSubscriptionNotification(session, subscription);
      }
      break;
    }
    // Fires once the invoice payment is confirmed — subscription is now "active".
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const sub = invoice.subscription;
      if (sub) {
        const subId = typeof sub === "string" ? sub : (sub as Stripe.Subscription).id;
        const subscription = await stripe.subscriptions.retrieve(subId);
        await updateUserSubscription(subscription);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      await updateUserSubscription(subscription);
      break;
    }
    default: {
      logger.info(`Unhandled Stripe webhook event type: ${event.type}`);
      break;
    }
  }
}

export const SoiZenFierPaymentEvent = onRequest(
  {
    secrets: [STRIPE_LIVE_SECRET_KEY, STRIPE_LIVE_WEBHOOK_SECRET, SENDGRID_API_KEY_SECRET],
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Stripe-Signature");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method not allowed.");
      return;
    }

    const signature = req.headers["stripe-signature"] as string | undefined;
    if (!signature) {
      res.status(400).send("Missing Stripe signature header.");
      return;
    }

    const isTest = await isTestMode();
    const useTestSecret = isTest;

    const stripeTestSecretKey = process.env.SOIZENFIER_STRIPE_TEST_SECRET_KEY;
    const stripeTestWebhookSecret =
      process.env.SOIZENFIER_STRIPE_TEST_WEBHOOK_SECRET;

    const stripe: Stripe = getStripe(
      useTestSecret ? stripeTestSecretKey! : STRIPE_LIVE_SECRET_KEY.value(),
    );

    if (!stripeTestWebhookSecret && !STRIPE_LIVE_WEBHOOK_SECRET.value()) {
      logger.error("Missing webhook secret environment variable.");
      res.status(500).send("Webhook secret not configured.");
      return;
    }

    const payload =
      req.rawBody && req.rawBody.length
        ? req.rawBody
        : Buffer.from(JSON.stringify(req.body || ""));

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        payload,
        signature,
        stripeTestWebhookSecret || STRIPE_LIVE_WEBHOOK_SECRET.value(),
      );
    } catch (error) {
      logger.error("Stripe webhook signature verification failed", error);
      res.status(400).send(`Webhook Error: ${(error as Error).message}`);
      return;
    }

    try {
      await handleSoizenfierStripeWebhook(event, stripe);
      res.status(200).send({ received: true });
    } catch (error) {
      logger.error("Stripe webhook processing failed", error);
      res.status(500).send("Webhook handler error.");
    }
  },
);

interface RequestWithHeaders {
  headers?: Record<string, string | string[] | undefined>;
}

async function verifyFirebaseUser(req: RequestWithHeaders) {
  const authHeader = req.headers?.["authorization"] as string | undefined;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader;

  if (!token) return null;

  try {
    return await admin.auth().verifyIdToken(token);
  } catch (error) {
    logger.warn("Invalid Firebase auth token", { error });
    return null;
  }
}

async function getOrCreateStripeCustomer(
  stripe: Stripe,
  userId: string,
  email?: string | null,
  name?: string | null,
) {
  const userRef = admin.firestore().collection("users").doc(userId);
  const userDoc = await userRef.get();
  const existingCustomerId = userDoc.exists
    ? (userDoc.data()?.stripeCustomerId as string | undefined)
    : undefined;

  if (existingCustomerId) return existingCustomerId;

  const customer = await stripe.customers.create({
    email: email || undefined,
    name: name || undefined,
    metadata: { firebaseUserId: userId },
  });

  await userRef.set(
    {
      uid: userId,
      email: email || null,
      displayName: name || null,
      stripeCustomerId: customer.id,
      role: userDoc.exists
        ? (userDoc.data()?.role as string | undefined) || "User"
        : "User",
      updatedAt: FieldValue.serverTimestamp(),
      ...(userDoc.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );

  return customer.id;
}

export const createCheckoutSession = onRequest(
  {
    secrets: [STRIPE_LIVE_SECRET_KEY],
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method not allowed.");
      return;
    }

    const decodedUser = await verifyFirebaseUser(req);
    if (!decodedUser) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const {
      mode,
      title,
      amount,
      currency,
      interval = "month",
      locale,
      successUrl,
      cancelUrl,
      planId,
    } = body as {
      mode?: string;
      title?: string;
      amount?: number;
      currency?: string;
      interval?: string;
      locale?: string;
      successUrl?: string;
      cancelUrl?: string;
      planId?: string;
    };

    if (!mode || !title || !successUrl || !cancelUrl) {
      res.status(400).send("Missing required Stripe checkout session data.");
      return;
    }
    if (!planId && (!amount || !currency)) {
      res.status(400).send("Either planId or amount+currency is required.");
      return;
    }

    if (mode !== "payment" && mode !== "subscription") {
      res.status(400).send("Invalid checkout mode.");
      return;
    }

    const isTest = await isTestMode();
    const useTestSecret = isTest;

    const stripeTestSecretKey = process.env.SOIZENFIER_STRIPE_TEST_SECRET_KEY;
    const stripe: Stripe = getStripe(
      useTestSecret ? stripeTestSecretKey! : STRIPE_LIVE_SECRET_KEY.value(),
    );

    const stripeCustomerId = await getOrCreateStripeCustomer(
      stripe,
      decodedUser.uid,
      decodedUser.email,
      decodedUser.name,
    );

    // Try to use a stored Stripe Price ID (created by syncPlansToStripe) for subscriptions.
    // Fall back to inline price_data if not found.
    let lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
    if (planId && mode === "subscription") {
      const pricingSnap = await admin.firestore().collection("config").doc("stripePricing").get();
      const priceField = useTestSecret ? "testPriceId" : "livePriceId";
      const storedPriceId = pricingSnap.exists
        ? (pricingSnap.data()?.[planId]?.[priceField] as string | undefined)
        : undefined;

      if (storedPriceId) {
        lineItems = [{ price: storedPriceId, quantity: 1 }];
      } else {
        // Plan not yet synced to Stripe — fall back to inline price
        lineItems = [{
          price_data: {
            currency: currency ?? "cad",
            product_data: { name: title },
            unit_amount: amount ?? 0,
            recurring: { interval: interval === "year" ? "year" : "month" },
          },
          quantity: 1,
        }];
      }
    } else {
      lineItems = [{
        price_data: {
          currency: currency!,
          product_data: { name: title },
          unit_amount: amount!,
          ...(mode === "subscription"
            ? { recurring: { interval: interval === "year" ? "year" : "month" } }
            : {}),
        },
        quantity: 1,
      }];
    }

    try {
      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        payment_method_types: ["card"],
        line_items: lineItems,
        mode: mode as Stripe.Checkout.SessionCreateParams.Mode,
        ...(mode === "subscription"
          ? {
              subscription_data: {
                metadata: { firebaseUserId: decodedUser.uid, planName: title },
              },
            }
          : {}),
        metadata: { firebaseUserId: decodedUser.uid },
        success_url: successUrl,
        cancel_url: cancelUrl,
        locale: locale === "fr" ? "fr" : "auto",
        allow_promotion_codes: true,
      });

      res.status(200).json({ url: session.url });
    } catch (error) {
      logger.error("Stripe checkout session creation failed", error);
      res.status(500).json({ error: "Unable to create checkout session." });
    }
  },
);

export const syncPlansToStripe = onRequest(
  { secrets: [STRIPE_LIVE_SECRET_KEY] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).send("Method not allowed."); return; }

    const decodedUser = await verifyFirebaseUser(req);
    if (!decodedUser) { res.status(401).json({ error: "Authentication required." }); return; }

    const userSnap = await admin.firestore().collection("users").doc(decodedUser.uid).get();
    if (!userSnap.exists || userSnap.data()?.role !== "Administrator") {
      res.status(403).json({ error: "Administrator access required." });
      return;
    }

    const isTest = await isTestMode();
    const useTestSecret = isTest;
    const stripeTestSecretKey = process.env.SOIZENFIER_STRIPE_TEST_SECRET_KEY;
    const stripe: Stripe = getStripe(
      useTestSecret ? stripeTestSecretKey! : STRIPE_LIVE_SECRET_KEY.value(),
    );

    const priceField = useTestSecret ? "testPriceId" : "livePriceId";
    const pricingRef = admin.firestore().collection("config").doc("stripePricing");
    const pricingSnap = await pricingRef.get();
    const stored = (pricingSnap.exists ? pricingSnap.data() : {}) as Record<string, Record<string, string>>;

    const result: Record<string, { productId: string; priceId: string }> = {};

    for (const plan of appMonthlyPlans) {
      // Find existing Stripe Product by appPlanId metadata
      const search = await stripe.products.search({
        query: `metadata['appPlanId']:'${plan.id}'`,
      });

      let productId: string;
      if (search.data.length > 0) {
        productId = search.data[0].id;
        if (search.data[0].name !== plan.title) {
          await stripe.products.update(productId, { name: plan.title });
        }
      } else {
        const product = await stripe.products.create({
          name: plan.title,
          metadata: { appPlanId: plan.id },
        });
        productId = product.id;
      }

      // Check if existing stored price is still valid
      const existingPriceId = stored[plan.id]?.[priceField];
      let priceId: string;

      if (existingPriceId) {
        const existing = await stripe.prices.retrieve(existingPriceId);
        if (existing.unit_amount === plan.amountCents && existing.currency === plan.currency && existing.active) {
          priceId = existingPriceId;
        } else {
          await stripe.prices.update(existingPriceId, { active: false });
          const newPrice = await stripe.prices.create({
            product: productId,
            unit_amount: plan.amountCents,
            currency: plan.currency,
            recurring: { interval: "month" },
            metadata: { appPlanId: plan.id },
          });
          priceId = newPrice.id;
        }
      } else {
        const newPrice = await stripe.prices.create({
          product: productId,
          unit_amount: plan.amountCents,
          currency: plan.currency,
          recurring: { interval: "month" },
          metadata: { appPlanId: plan.id },
        });
        priceId = newPrice.id;
      }

      result[plan.id] = { productId, priceId };
      await pricingRef.set(
        { [plan.id]: { ...stored[plan.id], productId, [priceField]: priceId } },
        { merge: true },
      );

      logger.info(`Synced plan ${plan.id}: product=${productId} price=${priceId}`);
    }

    res.status(200).json({ mode: useTestSecret ? "test" : "live", plans: result });
  },
);

export const syncUserSubscriptions = onRequest(
  {
    secrets: [STRIPE_LIVE_SECRET_KEY],
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).send("Method not allowed."); return; }

    const decodedUser = await verifyFirebaseUser(req);
    if (!decodedUser) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const userRef = admin.firestore().collection("users").doc(decodedUser.uid);
    const userDoc = await userRef.get();
    const stripeCustomerId = userDoc.exists
      ? (userDoc.data()?.stripeCustomerId as string | undefined)
      : undefined;

    if (!stripeCustomerId) {
      res.status(400).json({ error: "No Stripe customer linked to this account." });
      return;
    }

    const isTest = await isTestMode();
    const useTestSecret = isTest;
    const stripeTestSecretKey = process.env.SOIZENFIER_STRIPE_TEST_SECRET_KEY;
    const stripe: Stripe = getStripe(
      useTestSecret ? stripeTestSecretKey! : STRIPE_LIVE_SECRET_KEY.value(),
    );

    // Fetch all subscriptions for this customer from Stripe
    const stripeSubscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      limit: 100,
      expand: ["data.items.data.price"],
    });

    let synced = 0;
    for (const sub of stripeSubscriptions.data) {
      // Ensure the metadata carries the firebase UID so updateUserSubscription works
      const enriched = {
        ...sub,
        metadata: { ...sub.metadata, firebaseUserId: decodedUser.uid },
      };
      await updateUserSubscription(enriched as Stripe.Subscription);
      synced++;
    }

    logger.info(`Synced ${synced} subscriptions for user ${decodedUser.uid}`);
    res.status(200).json({ synced });
  },
);

export const createCustomerPortalSession = onRequest(
  {
    secrets: [STRIPE_LIVE_SECRET_KEY],
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method not allowed.");
      return;
    }

    const decodedUser = await verifyFirebaseUser(req);
    if (!decodedUser) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const userDoc = await admin
      .firestore()
      .collection("users")
      .doc(decodedUser.uid)
      .get();

    const stripeCustomerId = userDoc.exists
      ? (userDoc.data()?.stripeCustomerId as string | undefined)
      : undefined;

    if (!stripeCustomerId) {
      res
        .status(400)
        .json({ error: "No Stripe customer found for this user." });
      return;
    }

    const isTest = await isTestMode();
    const useTestSecret = isTest;

    const stripeTestSecretKey = process.env.SOIZENFIER_STRIPE_TEST_SECRET_KEY;
    const stripe: Stripe = getStripe(
      useTestSecret ? stripeTestSecretKey! : STRIPE_LIVE_SECRET_KEY.value(),
    );

    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const returnUrl = body.returnUrl || "https://soizenfier.com";

    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
      });

      res.status(200).json({ url: portalSession.url });
    } catch (error) {
      logger.error("Stripe portal session creation failed", error);
      res.status(500).json({ error: "Unable to create portal session." });
    }
  },
);

async function isTestMode(): Promise<boolean> {
  const paramSnapShot = await admin
    .firestore()
    .collection("generalparameters")
    .get();

  if (paramSnapShot.empty) {
    logger.warn("No general parameters found, defaulting to test mode.");
    return true;
  }
  const paramsData: GeneralParams =
    paramSnapShot.docs[0].data() as GeneralParams;
  return paramsData.test;
}
