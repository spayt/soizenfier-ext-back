// Safety net: never let the test suite reach a real Firebase project or a
// real Stripe / SendGrid account.
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error(
    "Functions tests must run against the emulators. Use `npm test` (firebase emulators:exec).",
  );
}

process.env.GCLOUD_PROJECT = "demo-soizenfier";
process.env.SOIZENFIER_STRIPE_TEST_SECRET_KEY = "sk_test_fake";
process.env.SOIZENFIER_STRIPE_TEST_WEBHOOK_SECRET = "whsec_test_fake";
process.env.SOIZENFIER_STRIPE_LIVE_SECRET_KEY = "sk_live_fake";
process.env.SOIZENFIER_STRIPE_LIVE_WEBHOOK_SECRET = "whsec_live_fake";
process.env.SOIZENFIER_SENDGRID_API_KEY = "SG.fake";
process.env.RUNNING_ON_LOCAL = "true";
