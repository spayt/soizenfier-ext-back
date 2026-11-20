import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const PROJECT_ID = "demo-soizenfier";

type HttpHandler = (req: unknown, res: unknown) => unknown;

type ReqOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: Buffer;
};

export type FakeResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  headersSent: boolean;
};

function makeReq({ method = "POST", headers = {}, body, rawBody }: ReqOptions) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method,
    headers: lower,
    body,
    rawBody,
    query: {},
    get: (name: string) => lower[name.toLowerCase()],
    header: (name: string) => lower[name.toLowerCase()],
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) { res.statusCode = code; return res; },
    set(key: string, value: string) { res.headers[key] = value; return res; },
    send(body: unknown) { res.body = body; res.headersSent = true; return res; },
    json(body: unknown) { return res.send(body); },
    on() { return res; },
  };
  return res;
}

/** Invokes a deployed-style `onRequest` function in-process and returns the captured response. */
export async function call(fn: HttpHandler, options: ReqOptions = {}): Promise<FakeResponse> {
  const res = makeRes();
  await fn(makeReq(options), res);
  return res;
}

/** Wipes all Firestore and Auth emulator data. */
export async function resetEmulators() {
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST;
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  await fetch(
    `http://${fsHost}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  await fetch(`http://${authHost}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: "DELETE",
  });
}

/** Creates a real Auth emulator user and returns a genuine ID token for it. */
export async function createUserWithToken(email: string, displayName?: string) {
  const password = "password123";
  const user = await getAuth().createUser({ email, password, displayName });
  const response = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { idToken } = (await response.json()) as { idToken: string };
  return { uid: user.uid, idToken, authHeader: { Authorization: `Bearer ${idToken}` } };
}

export function db() {
  return getFirestore();
}

/** `isTestMode()` reads the first document of `generalparameters`. */
export async function setStripeMode(mode: "test" | "live") {
  await db().collection("generalparameters").doc("params").set({ test: mode === "test" });
}
