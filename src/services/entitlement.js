// Single source of truth for "can this trainer offer guest booking?".

const USABLE_STATES = new Set(["active", "grace"]);

/**
 * @param {object} user  the users/{uid} document data
 * @returns {boolean} whether the trainer currently has an active Pro entitlement
 */
function isProEntitled(user) {
  const s = (user && user.subscription) || {};
  if (s.manualPro === true) return true; // admin override for test accounts
  if (s.tier !== "pro") return false;
  if (!USABLE_STATES.has(s.status)) return false;
  if (s.expiryTime && Date.parse(s.expiryTime) < Date.now()) return false;
  return true;
}

/** Global switch — set BOOKING_REQUIRE_PRO=false to develop the web app before
 *  the Play products exist. Default: Pro IS required. */
function bookingRequiresPro() {
  return process.env.BOOKING_REQUIRE_PRO !== "false";
}

function trainerCanOfferBooking(user) {
  return !bookingRequiresPro() || isProEntitled(user);
}

module.exports = { isProEntitled, bookingRequiresPro, trainerCanOfferBooking };
