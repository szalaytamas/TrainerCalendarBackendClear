const { JWT } = require("google-auth-library");

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
  const raw = process.env.GOOGLE_PLAY_SA_JSON;
  if (!raw) return null;
  const sa = JSON.parse(raw);
  cachedClient = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE] });
  return cachedClient;
}

function packageName() {
  return process.env.ANDROID_PACKAGE_NAME || "hu.szalaytamas.trainercalendar";
}

function notConfiguredError() {
  const e = new Error("play_not_configured");
  e.code = "NOT_CONFIGURED";
  return e;
}

/** GET purchases.subscriptionsv2 for a purchase token. */
async function getSubscriptionV2(purchaseToken) {
  const client = getClient();
  if (!client) throw notConfiguredError();
  const url = `${API_BASE}/${encodeURIComponent(packageName())}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const { data } = await client.request({ url });
  return data;
}

/** Best-effort server-side acknowledgement (belt & braces with the on-device ack). */
async function acknowledgeSubscription(subscriptionId, purchaseToken) {
  const client = getClient();
  if (!client || !subscriptionId) return { skipped: true };
  const url = `${API_BASE}/${encodeURIComponent(packageName())}/purchases/subscriptions/${encodeURIComponent(subscriptionId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  await client.request({ url, method: "POST", data: {} });
  return { ok: true };
}

const STATE_MAP = {
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace",
  SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_CANCELED: "canceled",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_PENDING: "pending",
};

const LEGACY_PRODUCT = "trainer_calendar_monthly"; // pre-M6 single plan → treat as pro

function tierForProduct(productId) {
  const pro = process.env.PLAY_PRODUCT_PRO || "trainer_calendar_pro_havi_auto";
  const alap = process.env.PLAY_PRODUCT_ALAP || "trainer_calendar_alap_havi_auto";
  if (productId === pro || productId === LEGACY_PRODUCT) return "pro";
  if (productId === alap) return "alap";
  return "none";
}

/** Normalise a subscriptionsv2 payload into the shape we persist on the user. */
function summarize(v2) {
  const line = (v2 && v2.lineItems && v2.lineItems[0]) || {};
  const productId = line.productId || null;
  const status = STATE_MAP[v2 && v2.subscriptionState] || "unknown";
  const tier = tierForProduct(productId);
  const expiryTime = line.expiryTime || null;
  const notExpired = !expiryTime || Date.parse(expiryTime) > Date.now();
  const entitledStates = status === "active" || status === "grace";

  return {
    tier,
    status,
    entitled: tier === "pro" && entitledStates && notExpired,
    productId,
    basePlanId: (line.offerDetails && line.offerDetails.basePlanId) || null,
    offerId: (line.offerDetails && line.offerDetails.offerId) || null,
    expiryTime,
    autoRenewing: line.autoRenewingPlan
      ? line.autoRenewingPlan.autoRenewEnabled !== false
      : null,
    testPurchase: !!(v2 && v2.testPurchase),
    acknowledgementState: (v2 && v2.acknowledgementState) || null,
  };
}

module.exports = {
  getSubscriptionV2,
  acknowledgeSubscription,
  summarize,
  tierForProduct,
};
