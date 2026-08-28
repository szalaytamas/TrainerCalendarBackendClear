// node src/services/entitlement.test.js
const assert = require("assert");

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
};

function fresh() {
  delete require.cache[require.resolve("./entitlement")];
  return require("./entitlement");
}

const future = new Date(Date.now() + 30 * 864e5).toISOString();
const past = new Date(Date.now() - 864e5).toISOString();

t("active pro is entitled", () => {
  delete process.env.BOOKING_REQUIRE_PRO;
  const { isProEntitled } = fresh();
  assert.strictEqual(isProEntitled({ subscription: { tier: "pro", status: "active", expiryTime: future } }), true);
});

t("grace pro is entitled", () => {
  const { isProEntitled } = fresh();
  assert.strictEqual(isProEntitled({ subscription: { tier: "pro", status: "grace", expiryTime: future } }), true);
});

t("alap tier is not entitled", () => {
  const { isProEntitled } = fresh();
  assert.strictEqual(isProEntitled({ subscription: { tier: "alap", status: "active", expiryTime: future } }), false);
});

t("expired pro is not entitled even if status says active", () => {
  const { isProEntitled } = fresh();
  assert.strictEqual(isProEntitled({ subscription: { tier: "pro", status: "active", expiryTime: past } }), false);
});

t("on_hold pro is not entitled", () => {
  const { isProEntitled } = fresh();
  assert.strictEqual(isProEntitled({ subscription: { tier: "pro", status: "on_hold", expiryTime: future } }), false);
});

t("manualPro override wins", () => {
  const { isProEntitled } = fresh();
  assert.strictEqual(isProEntitled({ subscription: { manualPro: true } }), true);
});

t("no subscription → not entitled", () => {
  const { isProEntitled } = fresh();
  assert.strictEqual(isProEntitled({}), false);
});

t("BOOKING_REQUIRE_PRO=false lets any trainer offer booking", () => {
  process.env.BOOKING_REQUIRE_PRO = "false";
  const { trainerCanOfferBooking, bookingRequiresPro } = fresh();
  assert.strictEqual(bookingRequiresPro(), false);
  assert.strictEqual(trainerCanOfferBooking({}), true);
  delete process.env.BOOKING_REQUIRE_PRO;
});

t("default: trainerCanOfferBooking requires Pro", () => {
  delete process.env.BOOKING_REQUIRE_PRO;
  const { trainerCanOfferBooking } = fresh();
  assert.strictEqual(trainerCanOfferBooking({}), false);
  assert.strictEqual(trainerCanOfferBooking({ subscription: { tier: "pro", status: "active", expiryTime: future } }), true);
});

console.log(`\n${pass} passed`);
