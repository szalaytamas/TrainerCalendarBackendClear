// node src/services/playBilling.test.js
const assert = require("assert");

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
};

process.env.PLAY_PRODUCT_PRO = "trainer_calendar_pro";
process.env.PLAY_PRODUCT_ALAP = "trainer_calendar_alap";
const { summarize, tierForProduct } = require("./playBilling");

const future = new Date(Date.now() + 20 * 864e5).toISOString();
const past = new Date(Date.now() - 864e5).toISOString();

t("tierForProduct maps product ids", () => {
  assert.strictEqual(tierForProduct("trainer_calendar_pro"), "pro");
  assert.strictEqual(tierForProduct("trainer_calendar_alap"), "alap");
  assert.strictEqual(tierForProduct("something_else"), "none");
});

t("active pro subscription → entitled", () => {
  const s = summarize({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    lineItems: [{
      productId: "trainer_calendar_pro",
      expiryTime: future,
      offerDetails: { basePlanId: "pro-havi" },
      autoRenewingPlan: { autoRenewEnabled: true },
    }],
  });
  assert.deepStrictEqual(
    { tier: s.tier, status: s.status, entitled: s.entitled, basePlanId: s.basePlanId, autoRenewing: s.autoRenewing },
    { tier: "pro", status: "active", entitled: true, basePlanId: "pro-havi", autoRenewing: true }
  );
});

t("canceled but not yet expired pro → not entitled (state gate)", () => {
  const s = summarize({
    subscriptionState: "SUBSCRIPTION_STATE_CANCELED",
    lineItems: [{ productId: "trainer_calendar_pro", expiryTime: future }],
  });
  assert.strictEqual(s.status, "canceled");
  assert.strictEqual(s.entitled, false);
});

t("active pro but expiry in the past → not entitled", () => {
  const s = summarize({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    lineItems: [{ productId: "trainer_calendar_pro", expiryTime: past }],
  });
  assert.strictEqual(s.entitled, false);
});

t("alap plan is never 'entitled' for booking", () => {
  const s = summarize({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    lineItems: [{ productId: "trainer_calendar_alap", expiryTime: future }],
  });
  assert.strictEqual(s.tier, "alap");
  assert.strictEqual(s.entitled, false);
});

t("grace period pro → entitled", () => {
  const s = summarize({
    subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
    lineItems: [{ productId: "trainer_calendar_pro", expiryTime: future }],
  });
  assert.strictEqual(s.status, "grace");
  assert.strictEqual(s.entitled, true);
});

t("unknown/empty payload does not throw", () => {
  const s = summarize({});
  assert.strictEqual(s.tier, "none");
  assert.strictEqual(s.status, "unknown");
  assert.strictEqual(s.entitled, false);
});

console.log(`\n${pass} passed`);
