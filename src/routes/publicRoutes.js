const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { DateTime } = require("luxon");

const { verifyTurnstile } = require("../services/turnstile");
const { computeFreeSlots, isSlotBookable, ZONE } = require("../services/availability");
const { findActivePackageId } = require("../services/packages");
const { sendEmail, verificationEmail, bookingRegisteredEmail } = require("../services/email");
const { buildIcs, icsAttachment } = require("../services/ics");

const router = express.Router();
const db = admin.firestore();

const TOKEN_TTL_HOURS = 24;
const MAX_RANGE_DAYS = 62;
const MAX_PENDING_PER_EMAIL = 3;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tighter limiter for the write endpoint (on top of the global /api/ limiter).
const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Túl sok foglalási kísérlet. Próbáld újra később." },
});

// --- helpers -------------------------------------------------------------

async function loadEnabledTrainerBySlug(slug) {
  const norm = String(slug || "").trim().toLowerCase();
  if (!norm) return null;
  const snap = await db.collection("users").where("booking.slug", "==", norm).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const user = doc.data();
  if (!user.booking || user.booking.enabled !== true) return null;
  // M4: additionally require an active "pro" subscription here.
  return { id: doc.id, user };
}

function trainerDisplayName(user) {
  const b = user.booking || {};
  return (
    (b.displayName && b.displayName.trim()) ||
    `${user.forename || ""} ${user.lastname || ""}`.trim() ||
    "Edző"
  );
}

function publicTrainerView(user) {
  const b = user.booking || {};
  return {
    slug: b.slug,
    displayName: trainerDisplayName(user),
    bio: b.bio || "",
    photoUrl: user.profileImage || null,
    slotMinutes: b.slotMinutes || 60,
    minNoticeHours: b.minNoticeHours ?? 12,
    maxAdvanceDays: b.maxAdvanceDays ?? 30,
    cancelWindowHours: b.cancelWindowHours ?? 24,
    serviceTypes: Array.isArray(b.serviceTypes)
      ? b.serviceTypes.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin }))
      : [],
  };
}

async function fetchTrainerAppointments(trainerId, fromISO, toISO) {
  // widen the low bound so long appointments starting just before the range still block
  const low = DateTime.fromISO(fromISO, { zone: ZONE }).minus({ days: 1 }).toFormat("yyyy-LL-dd'T'HH:mm");
  const high = DateTime.fromISO(toISO, { zone: ZONE }).toFormat("yyyy-LL-dd'T'HH:mm");
  const snap = await db
    .collection("appointments")
    .where("user_id", "==", trainerId)
    .where("date", ">=", low)
    .where("date", "<=", high)
    .orderBy("date", "asc")
    .limit(500)
    .get();
  return snap.docs.map((d) => {
    const a = d.data();
    return { date: a.date, durationMin: a.durationMin || null, status: a.status || "confirmed" };
  });
}

function resolveService(settings, serviceTypeId) {
  let durationMin = settings.slotMinutes || 60;
  let serviceType = null;
  if (serviceTypeId) {
    serviceType = (settings.serviceTypes || []).find((s) => s.id === serviceTypeId) || null;
    if (serviceType) durationMin = serviceType.durationMin;
  }
  return { durationMin, serviceType };
}

// --- routes ------------------------------------------------------------

// GET /api/public/t/:slug
router.get("/t/:slug", async (req, res) => {
  try {
    const t = await loadEnabledTrainerBySlug(req.params.slug);
    if (!t) return res.status(404).json({ error: "Ez a foglalási oldal nem elérhető." });
    res.json(publicTrainerView(t.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/public/t/:slug/availability?from=&to=&serviceTypeId=
router.get("/t/:slug/availability", async (req, res) => {
  try {
    const t = await loadEnabledTrainerBySlug(req.params.slug);
    if (!t) return res.status(404).json({ error: "Ez a foglalási oldal nem elérhető." });

    const settings = t.user.booking;
    const now = DateTime.now().setZone(ZONE);
    const from = req.query.from
      ? DateTime.fromISO(String(req.query.from), { zone: ZONE })
      : now.startOf("day");
    let to = req.query.to
      ? DateTime.fromISO(String(req.query.to), { zone: ZONE })
      : from.plus({ days: 14 });
    if (!from.isValid || !to.isValid) {
      return res.status(400).json({ error: "Érvénytelen dátumtartomány." });
    }
    if (to.diff(from, "days").days > MAX_RANGE_DAYS) to = from.plus({ days: MAX_RANGE_DAYS });

    const { durationMin, serviceType } = resolveService(settings, req.query.serviceTypeId);
    const appointments = await fetchTrainerAppointments(t.id, from.toISO(), to.toISO());
    const slots = computeFreeSlots({
      settings,
      appointments,
      fromISO: from.toISO(),
      toISO: to.toISO(),
      serviceDurationMin: durationMin,
    });
    res.json({ slots, serviceType, slotMinutes: durationMin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/public/bookings
router.post("/bookings", bookingLimiter, async (req, res) => {
  try {
    const { slug, start, serviceTypeId, name, email, phone, note, turnstileToken } = req.body || {};

    if (!name || !String(name).trim()) return res.status(400).json({ error: "A név megadása kötelező." });
    if (!email || !EMAIL_REGEX.test(String(email))) {
      return res.status(400).json({ error: "Érvényes e-mail-cím szükséges." });
    }
    if (!start) return res.status(400).json({ error: "Válassz időpontot." });

    const captcha = await verifyTurnstile(turnstileToken, req.ip);
    if (!captcha.success) {
      return res.status(400).json({ error: "A CAPTCHA-ellenőrzés sikertelen. Töltsd újra az oldalt." });
    }

    const t = await loadEnabledTrainerBySlug(slug);
    if (!t) return res.status(404).json({ error: "Ez a foglalási oldal nem elérhető." });
    const settings = t.user.booking;
    const { durationMin, serviceType } = resolveService(settings, serviceTypeId);
    const emailLc = String(email).trim().toLowerCase();

    // re-validate the chosen slot against the live calendar
    const dayStart = DateTime.fromISO(start, { zone: ZONE }).startOf("day");
    if (!dayStart.isValid) return res.status(400).json({ error: "Érvénytelen időpont." });
    const appointments = await fetchTrainerAppointments(
      t.id,
      dayStart.toISO(),
      dayStart.plus({ days: 1 }).toISO()
    );
    const check = isSlotBookable({ settings, appointments, startISO: start, serviceDurationMin: durationMin });
    if (!check.ok) {
      return res.status(409).json({ error: "Ez az időpont már nem foglalható. Válassz másikat." });
    }

    // anti-abuse: cap pending requests per email for this trainer
    const pendingSnap = await db
      .collection("appointments")
      .where("user_id", "==", t.id)
      .where("status", "==", "pending")
      .limit(50)
      .get();
    const pendingForEmail = pendingSnap.docs.filter(
      (d) => (d.data().guest_email || "") === emailLc
    ).length;
    if (pendingForEmail >= MAX_PENDING_PER_EMAIL) {
      return res.status(429).json({
        error: "Túl sok függő foglalásod van ennél az edzőnél. Várd meg a visszaigazolást.",
      });
    }

    // match an existing guest by email (in-memory — avoids a new composite index),
    // otherwise create a lightweight web guest for this trainer
    const guestsSnap = await db.collection("guests").where("user_id", "==", t.id).limit(200).get();
    let guestId = null;
    guestsSnap.forEach((d) => {
      if (!guestId && String(d.data().email || "").toLowerCase() === emailLc) guestId = d.id;
    });
    if (!guestId) {
      const gRef = await db.collection("guests").add({
        user_id: t.id,
        name: String(name).trim(),
        email: emailLc,
        phone: phone ? String(phone).trim() : "",
        notes: "",
        isActive: true,
        source: "web",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      guestId = gRef.id;
    }

    // hold the guest's active package on the appointment — same as manual create.
    // NEVER deducts a session; the trainer's attendance checkbox does that.
    const packageId = await findActivePackageId(guestId);

    const apptRef = await db.collection("appointments").add({
      user_id: t.id,
      client_name: String(name).trim(),
      date: check.start,
      notes: note ? String(note).trim().slice(0, 500) : "",
      guest_id: guestId,
      attended: false,
      status: "pending",
      source: "guest_web",
      durationMin,
      serviceTypeId: serviceType ? serviceType.id : null,
      requestedByGuestId: guestId,
      guest_email: emailLc,
      packageId: packageId || null,
      sessionDeducted: null,
      emailVerified: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const token = crypto.randomBytes(24).toString("hex");
    await db.collection("bookingTokens").doc(token).set({
      appointmentId: apptRef.id,
      trainerId: t.id,
      guestId,
      email: emailLc,
      start: check.start,
      end: check.end,
      used: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000),
    });

    const webOrigin = (process.env.PUBLIC_WEB_ORIGIN || "https://foglalas.trainercalendar.hu").replace(/\/$/, "");
    const verifyUrl = `${webOrigin}/foglalas/megerosites?token=${token}`;
    const mail = verificationEmail({
      trainerName: trainerDisplayName(t.user),
      startISO: check.start,
      endISO: check.end,
      verifyUrl,
    });
    try {
      await sendEmail({
        to: emailLc,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: t.user.email || undefined,
      });
    } catch (e) {
      console.error("[public/bookings] verification email failed:", e.message);
      // keep the booking; a resend path is added in M3
    }

    res.status(201).json({ ok: true, bookingRef: apptRef.id, requiresVerification: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/public/bookings/:token/verify
router.post("/bookings/:token/verify", async (req, res) => {
  try {
    const tokenRef = db.collection("bookingTokens").doc(req.params.token);
    const tokenDoc = await tokenRef.get();
    if (!tokenDoc.exists) {
      return res.status(404).json({ error: "Érvénytelen vagy lejárt megerősítő link." });
    }
    const tok = tokenDoc.data();
    if (tok.used) return res.json({ ok: true, status: "already_verified" });
    if (tok.expiresAt && tok.expiresAt.toMillis() < Date.now()) {
      return res.status(410).json({ error: "A megerősítő link lejárt. Foglalj újra." });
    }

    const apptRef = db.collection("appointments").doc(tok.appointmentId);
    const apptDoc = await apptRef.get();
    if (!apptDoc.exists) {
      return res.status(404).json({ error: "A foglalás időközben törlődött." });
    }
    const appt = apptDoc.data();

    const trainerDoc = await db.collection("users").doc(tok.trainerId).get();
    const trainer = trainerDoc.exists ? trainerDoc.data() : {};
    const autoConfirm = !!(trainer.booking && trainer.booking.autoConfirm);

    const updates = { emailVerified: true };
    if (appt.status === "pending" && autoConfirm) updates.status = "confirmed";
    await apptRef.update(updates);
    await tokenRef.update({ used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });

    // M5: push an FCM notification to the trainer here.

    const trainerName = trainerDisplayName(trainer);
    const finalStatus = updates.status || appt.status;
    const ics = buildIcs({
      uid: `${tok.appointmentId}@trainercalendar.hu`,
      startISO: tok.start,
      endISO: tok.end,
      summary: `Edzés — ${trainerName}`,
      description: finalStatus === "confirmed" ? "Visszaigazolt időpont." : "Időpontkérés — visszaigazolásra vár.",
      organizerName: trainerName,
    });
    const mail = bookingRegisteredEmail({
      trainerName,
      startISO: tok.start,
      endISO: tok.end,
      autoConfirmed: finalStatus === "confirmed",
    });
    try {
      await sendEmail({
        to: tok.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: trainer.email || undefined,
        attachments: [icsAttachment(ics)],
      });
    } catch (e) {
      console.error("[public/verify] confirmation email failed:", e.message);
    }

    res.json({ ok: true, status: finalStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
