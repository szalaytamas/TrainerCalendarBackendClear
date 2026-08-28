const admin = require("firebase-admin");

const db = admin.firestore();

/**
 * Returns the id of the guest's active userPackage doc to "hold" against a new
 * appointment — the SAME rule the trainer's manual appointment create uses
 * (appointmentRoutes.js). This only records which package the appointment
 * belongs to; it NEVER decrements remainingSessions. Session deduction stays
 * entirely with the trainer via the attendance checkbox.
 *
 * Priority: first package with remainingSessions > 0, otherwise an "unlimited" one.
 *
 * @param {string} guestId
 * @returns {Promise<string|null>}
 */
async function findActivePackageId(guestId) {
  if (!guestId) return null;
  const snap = await db
    .collection("userPackages")
    .doc(guestId)
    .collection("packages")
    .get();
  if (snap.empty) return null;

  let withSessions = null;
  let unlimited = null;
  snap.forEach((doc) => {
    const pkg = doc.data();
    if (!withSessions && pkg.remainingSessions > 0) withSessions = doc.id;
    if (!unlimited && pkg.packageId === "unlimited") unlimited = doc.id;
  });
  return withSessions || unlimited || null;
}

module.exports = { findActivePackageId };
