import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import Stripe from "stripe";
import { GeneralParams, getStripe } from "./utils";
import { defineSecret } from "firebase-functions/params";
import { Timestamp, FieldValue } from "firebase-admin/firestore";

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

  await admin
    .firestore()
    .collection("users")
    .doc(firebaseUserId)
    .set(
      {
        subscription: {
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
          current_period_end: toFirestoreTimestamp(
            subscription.current_period_end,
          ),
          cancel_at: toFirestoreTimestamp(subscription.cancel_at),
          canceled_at: toFirestoreTimestamp(subscription.canceled_at),
          updatedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
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
    secrets: [STRIPE_LIVE_SECRET_KEY, STRIPE_LIVE_WEBHOOK_SECRET],
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
    const isLocal = process.env.RUNNING_ON_LOCAL === "true";
    const useTestSecret = isTest || isLocal;

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
    } = body as {
      mode?: string;
      title?: string;
      amount?: number;
      currency?: string;
      interval?: string;
      locale?: string;
      successUrl?: string;
      cancelUrl?: string;
    };

    if (!mode || !title || !amount || !currency || !successUrl || !cancelUrl) {
      res.status(400).send("Missing required Stripe checkout session data.");
      return;
    }

    if (mode !== "payment" && mode !== "subscription") {
      res.status(400).send("Invalid checkout mode.");
      return;
    }

    const isTest = await isTestMode();
    const isLocal = process.env.RUNNING_ON_LOCAL === "true";
    const useTestSecret = isTest || isLocal;

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

    try {
      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency,
              product_data: { name: title },
              unit_amount: amount,
              ...(mode === "subscription"
                ? {
                    recurring: {
                      interval: interval === "year" ? "year" : "month",
                    },
                  }
                : {}),
            },
            quantity: 1,
          },
        ],
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
    const isLocal = process.env.RUNNING_ON_LOCAL === "true";
    const useTestSecret = isTest || isLocal;

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
