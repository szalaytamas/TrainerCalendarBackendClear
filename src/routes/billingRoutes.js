const express = require("express");
const admin = require("firebase-admin");
const { verifyToken } = require("../middleware/auth");
const {
  getSubscriptionV2,
  acknowledgeSubscription,
  summarize,
  checkCredentials,
} = require("../services/playBilling");

const router = express.Router();
const db = admin.firestore();

function publicSubView(sub) {
  if (!sub) return { tier: "none", status: "none", entitled: false };
  const { purchaseToken, ...rest } = sub;
  return rest;
}

async function persistSubscription(uid, purchaseToken, summary) {
  const sub = {
    ...summary,
    purchaseToken,
    source: "play",
    lastVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection("users").doc(uid).set({ subscription: sub }, { merge: true });
  await db
    .collection("playPurchaseTokens")
    .doc(purchaseToken)
    .set(
      { uid, productId: summary.productId || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  return sub;
}

// POST /api/billing/play/verify   { purchaseToken, productId? }
router.post("/play/verify", verifyToken, async (req, res) => {
  try {
    const { purchaseToken } = req.body || {};
    if (!purchaseToken) return res.status(400).json({ error: "purchaseToken kötelező." });

    let v2;
    try {
      v2 = await getSubscriptionV2(purchaseToken);
    } catch (e) {
      if (e.code === "NOT_CONFIGURED") {
        return res.status(503).json({ error: "A számlázás-ellenőrzés még nincs beállítva a szerveren." });
      }
      if (e.response && e.response.status === 404) {
        return res.status(404).json({ error: "Ismeretlen vagy lejárt vásárlási token." });
      }
      throw e;
    }

    const summary = summarize(v2);

    // best-effort server-side acknowledgement (the app also acks on-device)
    if (summary.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" && summary.productId) {
      acknowledgeSubscription(summary.productId, purchaseToken).catch((e) =>
        console.error("[billing/verify] acknowledge failed:", e.message)
      );
    }

    const sub = await persistSubscription(req.userId, purchaseToken, summary);
    res.json({ subscription: publicSubView(sub) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/play/health — no auth; confirms the SA key is usable.
router.get("/play/health", async (_req, res) => {
  const result = await checkCredentials();
  res.status(result.tokenAcquired ? 200 : 503).json(result);
});

// GET /api/billing/subscription
router.get("/subscription", verifyToken, async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.userId).get();
    const sub = (doc.exists && doc.data().subscription) || null;
    res.json({ subscription: publicSubView(sub) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/play/rtdn?token=SECRET   (Google Cloud Pub/Sub push endpoint)
// Disabled unless PLAY_RTDN_TOKEN is configured and matches.
router.post("/play/rtdn", async (req, res) => {
  try {
    const expected = process.env.PLAY_RTDN_TOKEN;
    if (!expected || req.query.token !== expected) return res.status(403).end();

    const msg = req.body && req.body.message;
    if (!msg || !msg.data) return res.status(204).end();

    const payload = JSON.parse(Buffer.from(msg.data, "base64").toString("utf8"));

    if (payload.testNotification) {
      console.log("[rtdn] test notification", payload.testNotification.version || "");
      return res.status(204).end();
    }

    const n = payload.subscriptionNotification;
    if (!n || !n.purchaseToken) return res.status(204).end();

    const mapDoc = await db.collection("playPurchaseTokens").doc(n.purchaseToken).get();
    if (!mapDoc.exists) {
      console.warn("[rtdn] purchaseToken not mapped to a user — ignoring");
      return res.status(204).end();
    }
    const uid = mapDoc.data().uid;

    let v2;
    try {
      v2 = await getSubscriptionV2(n.purchaseToken);
    } catch (e) {
      if (e.code === "NOT_CONFIGURED") return res.status(204).end();
      console.error("[rtdn] re-verify failed:", e.message);
      return res.status(500).end(); // Pub/Sub will retry
    }

    const summary = summarize(v2);
    await persistSubscription(uid, n.purchaseToken, summary);
    console.log(`[rtdn] ${uid} type=${n.notificationType} -> ${summary.status}/${summary.tier}`);
    res.status(204).end();
  } catch (err) {
    console.error("[rtdn] error:", err.message);
    res.status(500).end();
  }
});

module.exports = router;
