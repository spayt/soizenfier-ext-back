import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, beforeAll, beforeEach, afterAll } from "vitest";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp,
} from "firebase/firestore";

// Exercises ../firestore.rules against the emulator with the exact writes the
// website makes (lib/user.ts, ProfilePageClient, AdminPageClient).

let env: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(":");
  env = await initializeTestEnvironment({
    projectId: "demo-soizenfier-rules",
    firestore: {
      rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
      host,
      port: Number(port),
    },
  });
});

afterAll(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/alice"), {
      uid: "alice", email: "alice@example.com", role: "User",
      stripeCustomerId: "cus_alice",
      subscriptions: { sub_1: { status: "active", planName: "Essential" } },
    });
    await setDoc(doc(db, "users/admin"), { uid: "admin", role: "Administrator" });
    await setDoc(doc(db, "generalparameters/main"), { test: false });
    await setDoc(doc(db, "config/stripePricing"), { essential: { livePriceId: "price_live" } });
    await setDoc(doc(db, "emailVerifications/alice@example.com"), { code: "123456" });
  });
});

const as = (uid: string | null) =>
  (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

// The profile write lib/user.ts makes on every sign-in.
const profile = (uid: string, role: string) => ({
  uid, email: `${uid}@example.com`, displayName: null, photoURL: null, role,
  lastSeenAt: serverTimestamp(), updatedAt: serverTimestamp(),
});

describe("users/{uid} — the owner", () => {
  it("can read their own document", async () => {
    await assertSucceeds(getDoc(doc(as("alice"), "users/alice")));
  });

  it("can create their profile as a plain user", async () => {
    await assertSucceeds(setDoc(doc(as("bob"), "users/bob"), { ...profile("bob", "User"), createdAt: serverTimestamp() }));
  });

  it("cannot create their profile as Administrator", async () => {
    await assertFails(setDoc(doc(as("bob"), "users/bob"), profile("bob", "Administrator")));
  });

  it("cannot create a profile with subscription data", async () => {
    await assertFails(setDoc(doc(as("bob"), "users/bob"), {
      ...profile("bob", "User"), subscriptions: { sub_x: { status: "active" } },
    }));
  });

  it("can refresh their profile on sign-in (merge write)", async () => {
    await assertSucceeds(setDoc(doc(as("alice"), "users/alice"), profile("alice", "User"), { merge: true }));
  });

  it("an existing administrator keeps signing in normally", async () => {
    await assertSucceeds(setDoc(doc(as("admin"), "users/admin"), profile("admin", "Administrator"), { merge: true }));
  });

  it("a profile without a role (created by the webhook) can be completed as User", async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users/carol"), { stripeCustomerId: "cus_c" }));
    await assertSucceeds(setDoc(doc(as("carol"), "users/carol"), profile("carol", "User"), { merge: true }));
  });

  it("cannot promote themself to Administrator", async () => {
    await assertFails(updateDoc(doc(as("alice"), "users/alice"), { role: "Administrator" }));
  });

  it("cannot give themself a subscription or change their Stripe customer", async () => {
    await assertFails(updateDoc(doc(as("alice"), "users/alice"), { "subscriptions.sub_1.status": "active", "subscriptions.sub_2": { status: "active" } }));
    await assertFails(updateDoc(doc(as("alice"), "users/alice"), { stripeCustomerId: "cus_other" }));
  });

  it("cannot delete their document", async () => {
    await assertFails(deleteDoc(doc(as("alice"), "users/alice")));
  });
});

describe("users/{uid} — other users", () => {
  it("cannot read someone else's document", async () => {
    await assertFails(getDoc(doc(as("bob"), "users/alice")));
  });

  it("cannot list users", async () => {
    await assertFails(getDocs(collection(as("bob"), "users")));
  });

  it("cannot write someone else's document", async () => {
    await assertFails(setDoc(doc(as("bob"), "users/alice"), profile("alice", "User"), { merge: true }));
  });

  it("anonymous visitors cannot read users", async () => {
    await assertFails(getDoc(doc(as(null), "users/alice")));
  });
});

describe("users/{uid} — administrators", () => {
  it("can list all users", async () => {
    await assertSucceeds(getDocs(collection(as("admin"), "users")));
  });

  it("can edit a subscription's package and domain", async () => {
    await assertSucceeds(updateDoc(doc(as("admin"), "users/alice"), { "subscriptions.sub_1.websitePackage": "starter" }));
    await assertSucceeds(updateDoc(doc(as("admin"), "users/alice"), { "subscriptions.sub_1.domain": "alice.com" }));
  });

  it("cannot change another user's role", async () => {
    await assertFails(updateDoc(doc(as("admin"), "users/alice"), { role: "Administrator" }));
  });
});

describe("server-only collections", () => {
  it.each([
    "generalparameters/main",
    "config/stripePricing",
    "emailVerifications/alice@example.com",
    "messages/m1",
  ])("%s is neither readable nor writable from the client", async (path) => {
    await assertFails(getDoc(doc(as("alice"), path)));
    await assertFails(setDoc(doc(as("alice"), path), { test: true }));
    await assertFails(setDoc(doc(as("admin"), path), { test: true }));
  });
});
