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

  // Data-only message: the Android client builds the notification itself so it
  // can use a stable per-appointment id (a re-push replaces the earlier card)
  // and clear it once the trainer has handled the request. A `notification`
  // block would let the OS post its own uncontrollable, stacking notification.
  const base = {
    data: {
      title: String(title),
      body: String(body),
      channelId: "booking_events",
      ...Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [k, String(v)])
      ),
    },
    android: { priority: "high" },
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
