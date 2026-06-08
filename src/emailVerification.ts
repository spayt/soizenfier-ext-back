import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { defineSecret } from "firebase-functions/params";
import sgMail from "@sendgrid/mail";

const SENDGRID_API_KEY_SECRET = defineSecret("SOIZENFIER_SENDGRID_API_KEY");

const RATE_LIMIT_MS = 60_000; // 60-second window
const RATE_LIMIT_MAX = 3; // max 3 attempts per window
const CODE_EXPIRY_MS = 600_000; // 10 minutes

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function generateCode(): string {
  // crypto.randomInt upper bound is exclusive → 100000–999999
  return String(crypto.randomInt(100_000, 1_000_000));
}

function setCorsHeaders(res: { set: (k: string, v: string) => void }) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

// ─────────────────────────────────────────────────────────────────────────────
// sendEmailVerificationCode
// POST { email }
// → generates 6-digit code, stores SHA256 hash in Firestore, sends via SendGrid
// ─────────────────────────────────────────────────────────────────────────────
export const sendEmailVerificationCode = onRequest(
  { secrets: [SENDGRID_API_KEY_SECRET] },
  async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const email = (body.email ?? "").toString().toLowerCase().trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "Invalid email address." });
      return;
    }

    const code = generateCode();
    const codeHash = sha256(code);
    const now = Date.now();
    const db = admin.firestore();
    const docRef = db.collection("emailVerifications").doc(email);

    let rateLimited = false;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const data = snap.data() ?? {};

      // Keep only attempts within the last 60 s
      const recentSends: number[] = (
        (data.sendAttempts as number[]) ?? []
      ).filter((t) => now - t < RATE_LIMIT_MS);

      if (recentSends.length >= RATE_LIMIT_MAX) {
        rateLimited = true;
        return;
      }

      // Store hash; reset verifyAttempts so a fresh code gets fresh attempts
      tx.set(docRef, {
        codeHash,
        createdAt: now,
        sendAttempts: [...recentSends, now],
        verifyAttempts: [],
      });
    });

    if (rateLimited) {
      res.status(429).json({
        error:
          "Too many requests. Please wait 1 minute before requesting a new code.",
      });
      return;
    }

    // Send email via SendGrid
    const isLocal = process.env.RUNNING_ON_LOCAL === "true";
    const sgKey = isLocal
      ? (process.env.SOIZENFIER_SENDGRID_API_KEY ?? "")
      : SENDGRID_API_KEY_SECRET.value();

    if (!sgKey) {
      logger.error("SendGrid API key is not configured.");
      await docRef.delete().catch(() => {});
      res.status(500).json({ error: "Email service is not configured." });
      return;
    }

    try {
      sgMail.setApiKey(sgKey);
      await sgMail.send({
        to: email,
        from: {
          email:
            process.env.SOIZENFIER_SENDGRID_FROM_EMAIL ??
            "noreply@soizenfier.com",
          name: "SoiZenFier Technologies Inc",
        },
        subject: "Your verification code",
        html: buildVerificationEmail(code),
      });
      logger.info("Verification email sent", { email });
    } catch (err) {
      logger.error("SendGrid send failed", err);
      await docRef.delete().catch(() => {});
      res.status(500).json({
        error: "Failed to send verification email. Please try again.",
      });
      return;
    }

    res.status(200).json({ sent: true });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// verifyEmailVerificationCode
// POST { email, code }
// → checks hash, enforces rate limit, deletes record on success
// ─────────────────────────────────────────────────────────────────────────────
export const verifyEmailVerificationCode = onRequest(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const body =
    typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
  const email = (body.email ?? "").toString().toLowerCase().trim();
  const inputCode = (body.code ?? "").toString().trim();

  if (!email || !inputCode) {
    res.status(400).json({ error: "Email and code are required." });
    return;
  }

  const now = Date.now();
  const db = admin.firestore();
  const docRef = db.collection("emailVerifications").doc(email);

  // Use an object so TypeScript doesn't narrow the property after the async callback
  const state = {
    result: "not_found" as
      | "verified"
      | "rate_limited"
      | "expired"
      | "invalid"
      | "not_found",
  };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      state.result = "not_found";
      return;
    }

    const data = snap.data()!;

    // Check expiry (10 minutes)
    if (now - (data.createdAt as number) > CODE_EXPIRY_MS) {
      state.result = "expired";
      return;
    }

    // Rate limit verify attempts within last 60 s
    const recentVerify: number[] = (
      (data.verifyAttempts as number[]) ?? []
    ).filter((t) => now - t < RATE_LIMIT_MS);
    if (recentVerify.length >= RATE_LIMIT_MAX) {
      state.result = "rate_limited";
      return;
    }

    // Validate code
    if (sha256(inputCode) !== (data.codeHash as string)) {
      tx.update(docRef, { verifyAttempts: [...recentVerify, now] });
      state.result = "invalid";
      return;
    }

    // Success — delete the record so it cannot be reused
    tx.delete(docRef);
    state.result = "verified";
  });

  switch (state.result) {
    case "verified":
      res.status(200).json({ verified: true });
      break;
    case "rate_limited":
      res.status(429).json({
        error: "Too many attempts. Please wait 1 minute before trying again.",
      });
      break;
    case "expired":
      res
        .status(410)
        .json({ error: "Code has expired. Please request a new one." });
      break;
    case "invalid":
      res
        .status(400)
        .json({ error: "Incorrect code. Please check and try again." });
      break;
    case "not_found":
      res.status(404).json({
        error: "No verification code found. Please request a new one.",
      });
      break;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Email HTML template
// ─────────────────────────────────────────────────────────────────────────────
function buildVerificationEmail(code: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:48px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
        <tr>
          <td style="background:#0f172a;padding:28px 40px;">
            <p style="margin:0;font-size:17px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">SoiZenFier Technologies</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.4px;">Verify your email address</h1>
            <p style="margin:0 0 32px;font-size:15px;color:#64748b;line-height:1.65;">Use the 6-digit code below to complete your account creation. The code expires in <strong style="color:#0f172a;">10 minutes</strong>.</p>
            <div style="background:#f1f5f9;border-radius:16px;padding:28px 24px;text-align:center;margin-bottom:32px;border:2px dashed #e2e8f0;">
              <span style="display:inline-block;font-size:44px;font-weight:900;letter-spacing:14px;color:#0f172a;font-family:'Courier New',Courier,monospace;">${code}</span>
            </div>
            <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">If you didn't request this, you can safely ignore this email. No account will be created without entering this code.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:18px 40px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">© ${new Date().getFullYear()} SoiZenFier Technologies Inc. · admin@soizenfier.com</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
