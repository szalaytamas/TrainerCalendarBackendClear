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

/**
 * Read-only projection of a guest's assigned packages, split into active/expired
 * with the SAME rules packageRoutes.js GET /user-packages/:guestId uses.
 * Contains no mutation surface — the guest portal can only read this.
 *
 * @param {string} guestId
 * @returns {Promise<{ active: object[], expired: object[] }>}
 */
async function getGuestPackagesView(guestId) {
  const snap = await db
    .collection("userPackages")
    .doc(guestId)
    .collection("packages")
    .limit(50)
    .get();

  const now = new Date();
  const active = [];
  const expired = [];

  snap.forEach((doc) => {
    const pkg = doc.data();
    const endDate = pkg.endDate ? pkg.endDate.toDate() : null;
    const isUnlimited = pkg.packageId === "unlimited";
    const expiredByDate = !!endDate && endDate <= now;

    const view = {
      id: doc.id,
      packageId: pkg.packageId || null,
      name: pkg.name || "",
      sessionCount: pkg.sessionCount ?? null,
      remainingSessions: isUnlimited ? null : pkg.remainingSessions ?? null,
      unlimited: isUnlimited,
      startDate: pkg.startDate ? pkg.startDate.toDate().toISOString() : null,
      endDate: endDate ? endDate.toISOString() : null,
    };

    if (isUnlimited) {
      (expiredByDate ? expired : active).push(view);
    } else {
      const expiredBySessions =
        pkg.remainingSessions !== undefined && pkg.remainingSessions <= 0;
      (expiredByDate || expiredBySessions ? expired : active).push(view);
    }
  });

  return { active, expired };
}

module.exports = { findActivePackageId, getGuestPackagesView };
