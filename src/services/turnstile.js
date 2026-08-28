const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Cloudflare Turnstile token. If TURNSTILE_SECRET is not configured
 * (local dev), verification is skipped and success is returned.
 *
 * @param {string} token   the token from the browser widget
 * @param {string} [remoteIp]
 * @returns {Promise<{ success: boolean, skipped?: boolean, error?: string, raw?: any }>}
 */
async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) {
    console.warn("[turnstile] TURNSTILE_SECRET not set — skipping CAPTCHA verification");
    return { success: true, skipped: true };
  }
  if (!token) return { success: false, error: "missing-token" };

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteIp) form.set("remoteip", remoteIp);

    const resp = await fetch(VERIFY_URL, { method: "POST", body: form });
    const data = await resp.json();
    return { success: !!data.success, raw: data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { verifyTurnstile };
