const admin = require("firebase-admin");

const db = admin.firestore();

async function getTokens(uid) {
  const doc = await db.collection("users").doc(uid).get();
  const arr = (doc.exists && doc.data().fcmTokens) || [];
  return Array.isArray(arr) ? arr.filter(Boolean) : [];
}

async function pruneTokens(uid, badTokens) {
  if (!badTokens.length) return;
  await db
    .collection("users")
    .doc(uid)
    .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...badTokens) })
    .catch(() => {});
}

/**
 * Send a notification to every device the user registered. No-ops silently if
 * the user has no tokens. Invalid tokens are pruned.
 *
 * @param {string} uid
 * @param {{ title:string, body:string, data?:object }} payload
 */
async function notifyUser(uid, { title, body, data }) {
  let tokens;
  try {
    tokens = await getTokens(uid);
  } catch (e) {
    console.error("[push] token lookup failed:", e.message);
    return { sent: 0 };
  }
  if (!tokens.length) return { sent: 0 };

  const base = {
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [k, String(v)])
    ),
    android: { priority: "high", notification: { channelId: "booking_events" } },
  };

  const bad = [];
  let sent = 0;
  await Promise.all(
    tokens.map(async (token) => {
      try {
        await admin.messaging().send({ ...base, token });
        sent++;
      } catch (e) {
        const code = e && e.errorInfo && e.errorInfo.code;
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-argument" ||
          code === "messaging/invalid-registration-token"
        ) {
          bad.push(token);
        } else {
          console.error("[push] send error:", (e && e.message) || e);
        }
      }
    })
  );
  await pruneTokens(uid, bad);
  return { sent };
}

module.exports = { notifyUser };
