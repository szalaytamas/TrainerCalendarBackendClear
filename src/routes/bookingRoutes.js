const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { verifyToken } = require("../middleware/auth");
const { isProEntitled, bookingRequiresPro } = require("../services/entitlement");

const router = express.Router();
const db = admin.firestore();

// 3–40 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen.
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const HM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const DEFAULT_SETTINGS = {
  enabled: false,
  slug: null,
  displayName: "",
  bio: "",
  slotMinutes: 60,
  bufferMinutes: 0,
  minNoticeHours: 12,
  cancelWindowHours: 24,
  maxAdvanceDays: 30,
  autoConfirm: false,
  workingHours: {},
  serviceTypes: [],
};

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function normalizeSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function sanitizeWorkingHours(wh) {
  const out = {};
  if (!wh || typeof wh !== "object") return out;
  for (const d of DAY_KEYS) {
    if (!Array.isArray(wh[d])) continue;
    const windows = wh[d]
      .filter((w) => w && HM_REGEX.test(w.start) && HM_REGEX.test(w.end) && w.start < w.end)
      .map((w) => ({ start: w.start, end: w.end }))
      .slice(0, 6);
    if (windows.length) out[d] = windows;
  }
  return out;
}

function sanitizeServiceTypes(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((s) => ({
    id: (s && s.id && String(s.id)) || crypto.randomUUID(),
    name: String((s && s.name) || "").trim().slice(0, 80) || "Edzés",
    durationMin: clampInt(s && s.durationMin, 15, 480, 60),
    usesPackage: !s || s.usesPackage === undefined ? true : !!s.usesPackage,
  }));
}

async function slugOwner(slug) {
  const snap = await db.collection("users").where("booking.slug", "==", slug).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

// GET /api/booking/settings
router.get("/settings", verifyToken, async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.userId).get();
    const user = (doc.exists && doc.data()) || {};
    const booking = user.booking || {};
    res.json({
      ...DEFAULT_SETTINGS,
      ...booking,
      tier: (user.subscription || {}).tier || "none",
      proEntitled: isProEntitled(user),
      bookingRequiresPro: bookingRequiresPro(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/booking/settings
router.put("/settings", verifyToken, async (req, res) => {
  try {
    const b = req.body || {};
    const userDoc = await db.collection("users").doc(req.userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const current = userDoc.data().booking || {};
    const next = { ...DEFAULT_SETTINGS, ...current };

    if (b.displayName !== undefined) next.displayName = String(b.displayName || "").trim().slice(0, 80);
    if (b.bio !== undefined) next.bio = String(b.bio || "").trim().slice(0, 500);
    if (b.slotMinutes !== undefined) next.slotMinutes = clampInt(b.slotMinutes, 15, 480, 60);
    if (b.bufferMinutes !== undefined) next.bufferMinutes = clampInt(b.bufferMinutes, 0, 120, 0);
    if (b.minNoticeHours !== undefined) next.minNoticeHours = clampInt(b.minNoticeHours, 0, 720, 12);
    if (b.cancelWindowHours !== undefined) next.cancelWindowHours = clampInt(b.cancelWindowHours, 0, 720, 24);
    if (b.maxAdvanceDays !== undefined) next.maxAdvanceDays = clampInt(b.maxAdvanceDays, 1, 180, 30);
    if (b.autoConfirm !== undefined) next.autoConfirm = !!b.autoConfirm;
    if (b.workingHours !== undefined) next.workingHours = sanitizeWorkingHours(b.workingHours);
    if (b.serviceTypes !== undefined) next.serviceTypes = sanitizeServiceTypes(b.serviceTypes);

    if (b.slug !== undefined && b.slug !== null && b.slug !== "") {
      const slug = normalizeSlug(b.slug);
      if (!SLUG_REGEX.test(slug)) {
        return res.status(400).json({
          error: "Érvénytelen link. 3–40 karakter, csak kisbetű, szám és kötőjel.",
        });
      }
      const owner = await slugOwner(slug);
      if (owner && owner !== req.userId) {
        return res.status(409).json({ error: "Ez a foglalási link már foglalt." });
      }
      next.slug = slug;
    }

    if (b.enabled !== undefined) next.enabled = !!b.enabled;

    // Turning booking ON requires an active Pro entitlement. Configuring the
    // other fields while on Alap is allowed so it's ready when they upgrade.
    if (next.enabled && !current.enabled && bookingRequiresPro() && !isProEntitled(userDoc.data())) {
      return res.status(403).json({
        error: "A vendég időpontfoglalás a Pro csomag része. Válts Pro-ra az aktiváláshoz.",
        code: "pro_required",
      });
    }
    if (next.enabled && !next.slug) {
      return res.status(400).json({
        error: "A foglalás engedélyezéséhez előbb állíts be egy foglalási linket.",
      });
    }
    if (next.enabled && Object.keys(next.workingHours).length === 0) {
      return res.status(400).json({
        error: "A foglalás engedélyezéséhez adj meg legalább egy munkaidő-sávot.",
      });
    }

    await db.collection("users").doc(req.userId).set({ booking: next }, { merge: true });
    res.json({ ...DEFAULT_SETTINGS, ...next, tier: (userDoc.data().subscription || {}).tier || "none", proEntitled: isProEntitled(userDoc.data()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/booking/slug-available?slug=
router.get("/slug-available", verifyToken, async (req, res) => {
  try {
    const slug = normalizeSlug(req.query.slug);
    if (!SLUG_REGEX.test(slug)) return res.json({ slug, available: false, reason: "invalid" });
    const owner = await slugOwner(slug);
    res.json({ slug, available: !owner || owner === req.userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/booking/requests  → pending guest bookings for this trainer
router.get("/requests", verifyToken, async (req, res) => {
  try {
    const snap = await db
      .collection("appointments")
      .where("user_id", "==", req.userId)
      .where("status", "==", "pending")
      .limit(200)
      .get();
    const requests = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function loadOwnedAppointment(id, userId) {
  const ref = db.collection("appointments").doc(id);
  const doc = await ref.get();
  if (!doc.exists) return { error: 404 };
  if (doc.data().user_id !== userId) return { error: 403 };
  return { ref, data: doc.data() };
}

// POST /api/booking/requests/:id/approve  → status: confirmed
// IMPORTANT: never touches package sessions. Deduction stays 100% with the
// trainer via the attendance checkbox, exactly as for manual appointments.
router.post("/requests/:id/approve", verifyToken, async (req, res) => {
  try {
    const { ref, data, error } = await loadOwnedAppointment(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: "Foglalás nem található." });
    if (error === 403) return res.status(403).json({ error: "Unauthorized" });
    if (data.status !== "pending") {
      return res.status(409).json({ error: "Ez a foglalás már nem függő állapotú." });
    }
    await ref.update({ status: "confirmed" });
    res.json({ id: ref.id, status: "confirmed", message: "Foglalás elfogadva." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/booking/requests/:id/decline  → status: declined (packages untouched)
router.post("/requests/:id/decline", verifyToken, async (req, res) => {
  try {
    const { ref, data, error } = await loadOwnedAppointment(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: "Foglalás nem található." });
    if (error === 403) return res.status(403).json({ error: "Unauthorized" });
    if (data.status !== "pending") {
      return res.status(409).json({ error: "Ez a foglalás már nem függő állapotú." });
    }
    await ref.update({ status: "declined" });
    res.json({ id: ref.id, status: "declined", message: "Foglalás elutasítva." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.normalizeSlug = normalizeSlug;
module.exports.SLUG_REGEX = SLUG_REGEX;
