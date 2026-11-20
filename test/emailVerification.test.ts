import { describe, it, expect, vi, beforeEach } from "vitest";
import * as crypto from "crypto";

const sgMail = vi.hoisted(() => ({ setApiKey: vi.fn(), send: vi.fn() }));
vi.mock("@sendgrid/mail", () => ({ default: sgMail }));

import { sendEmailVerificationCode, verifyEmailVerificationCode } from "../src/index";
import { call, db, resetEmulators } from "./helpers";

const EMAIL = "alice@example.com";

const sha256 = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Extracts the 6-digit code from the HTML actually handed to SendGrid. */
function lastSentCode(): string {
  const html = sgMail.send.mock.calls.at(-1)![0].html as string;
  return /(\d{6})<\/span>/.exec(html)![1];
}

const send = (email: unknown = EMAIL) =>
  call(sendEmailVerificationCode, { body: { email } });
const verify = (code: string, email = EMAIL) =>
  call(verifyEmailVerificationCode, { body: { email, code } });

beforeEach(async () => {
  await resetEmulators();
  sgMail.setApiKey.mockReset();
  sgMail.send.mockReset().mockResolvedValue([{ statusCode: 202 }]);
  process.env.SOIZENFIER_SENDGRID_API_KEY = "SG.fake";
});

describe("sendEmailVerificationCode", () => {
  it("answers CORS preflight with 204", async () => {
    const res = await call(sendEmailVerificationCode, { method: "OPTIONS" });
    expect(res.statusCode).toBe(204);
  });

  it("rejects non-POST methods with 405", async () => {
    const res = await call(sendEmailVerificationCode, { method: "GET" });
    expect(res.statusCode).toBe(405);
  });

  it.each([null, "", "not-an-email", "a@b", "with space@x.com"])(
    "rejects invalid email %j with 400",
    async (email) => {
      const res = await call(sendEmailVerificationCode, { body: { email } });
      expect(res.statusCode).toBe(400);
      expect(sgMail.send).not.toHaveBeenCalled();
    },
  );

  it("emails a 6-digit code and stores only its hash", async () => {
    const res = await send();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sent: true });

    const code = lastSentCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(sgMail.send.mock.calls[0][0].to).toBe(EMAIL);

    const stored = (await db().collection("emailVerifications").doc(EMAIL).get()).data()!;
    expect(stored.codeHash).toBe(sha256(code));
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored.sendAttempts).toHaveLength(1);
  });

  it("normalises the email (trim + lowercase) before storing", async () => {
    await send("  Alice@Example.COM ");
    const doc = await db().collection("emailVerifications").doc(EMAIL).get();
    expect(doc.exists).toBe(true);
  });

  it("rate-limits to 3 codes per minute", async () => {
    for (let i = 0; i < 3; i++) expect((await send()).statusCode).toBe(200);
    const res = await send();
    expect(res.statusCode).toBe(429);
    expect(sgMail.send).toHaveBeenCalledTimes(3);
  });

  it("returns 500 and removes the pending code when SendGrid fails", async () => {
    sgMail.send.mockRejectedValueOnce(new Error("SendGrid down"));
    const res = await send();
    expect(res.statusCode).toBe(500);
    const doc = await db().collection("emailVerifications").doc(EMAIL).get();
    expect(doc.exists).toBe(false);
  });

  it("returns 500 when no SendGrid key is configured", async () => {
    process.env.SOIZENFIER_SENDGRID_API_KEY = "";
    const res = await send();
    expect(res.statusCode).toBe(500);
    expect(sgMail.send).not.toHaveBeenCalled();
  });
});

describe("verifyEmailVerificationCode", () => {
  it("requires email and code", async () => {
    const res = await call(verifyEmailVerificationCode, { body: { email: EMAIL } });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when no code was requested", async () => {
    expect((await verify("123456")).statusCode).toBe(404);
  });

  it("accepts the emailed code once, then deletes it so it cannot be reused", async () => {
    await send();
    const code = lastSentCode();

    const first = await verify(code);
    expect(first.statusCode).toBe(200);
    expect(first.body).toEqual({ verified: true });

    const second = await verify(code);
    expect(second.statusCode).toBe(404);
  });

  it("rejects a wrong code and records the attempt", async () => {
    await send();
    const wrong = lastSentCode() === "000000" ? "111111" : "000000";
    const res = await verify(wrong);
    expect(res.statusCode).toBe(400);
    const stored = (await db().collection("emailVerifications").doc(EMAIL).get()).data()!;
    expect(stored.verifyAttempts).toHaveLength(1);
  });

  it("blocks brute force: after 3 wrong codes even the right one is refused", async () => {
    await send();
    const code = lastSentCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) expect((await verify(wrong)).statusCode).toBe(400);
    expect((await verify(code)).statusCode).toBe(429);
  });

  it("returns 410 for a code older than 10 minutes", async () => {
    await send();
    const code = lastSentCode();
    await db()
      .collection("emailVerifications")
      .doc(EMAIL)
      .update({ createdAt: Date.now() - 11 * 60_000 });
    expect((await verify(code)).statusCode).toBe(410);
  });

  it("a newly requested code invalidates the previous one", async () => {
    await send();
    const oldCode = lastSentCode();
    await send();
    const newCode = lastSentCode();
    if (oldCode !== newCode) expect((await verify(oldCode)).statusCode).toBe(400);
    expect((await verify(newCode)).statusCode).toBe(200);
  });
});
