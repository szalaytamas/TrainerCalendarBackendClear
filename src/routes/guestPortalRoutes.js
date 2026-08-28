const express = require("express");
const admin = require("firebase-admin");
const rateLimit = require("express-rate-limit");
const { DateTime } = require("luxon");

const { verifyGuestToken } = require("../middleware/auth");
const { computeFreeSlots, isSlotBookable, parseLocal, ZONE } = require("../services/availability");
const { findActivePackageId, getGuestPackagesView } = require("../services/packages");
const { trainerCanOfferBooking } = require("../services/entitlement");
const {
  sendEmail,
  bookingRegisteredEmail,
  bookingCancelledEmail,
  magicLinkEmail,
  formatDateHu,
} = require("../services/email");
const { buildIcs, icsAttachment } = require("../services/ics");
const { notifyUser } = require("../services/push");

const router = express.Router();
const db = admin.firestore();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RANGE_DAYS = 62;
const UPCOMING_STATUSES = new Set(["pending", "confirmed"]);

const linkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Túl sok belépési kísérlet. Próbáld újra később." },
});

// --- helpers ----------------------------------------------------------

function webOrigin() {
  return (process.env.PUBLIC_WEB_ORIGIN || "https://foglalas.trainercalendar.hu").replace(/\/$/, "");
}

function trainerDisplayName(user) {
  const b = (user && user.booking) || {};
  return (
    (b.displayName && b.displayName.trim()) ||
    `${(user && user.forename) || ""} ${(user && user.lastname) || ""}`.trim() ||
    "Edző"
  );
}

async function guestsForEmail(email) {
  const snap = await db.collection("guests").where("email", "==", email).limit(50).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function apptView(id, a) {
  return {
    id,
    date: a.date,
    durationMin: a.durationMin || null,
    status: a.status || "confirmed",
    source: a.source || "trainer",
    serviceTypeId: a.serviceTypeId || null,
    attended: a.hasOwnProperty("attended") ? a.attended : false,
    notes: a.notes || "",
  };
}

async function fetchTrainerAppointments(trainerId, fromISO, toISO) {
  const low = parseLocal(fromISO).minus({ days: 1 }).toFormat("yyyy-LL-dd HH:mm:ss");
  const high = parseLocal(toISO).toFormat("yyyy-LL-dd HH:mm:ss");
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

// =====================================================================
// POST /api/guest/auth/request-link   (PRE-LOGIN — no token required)
// =====================================================================
router.post("/auth/request-link", linkLimiter, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Érvényes e-mail-cím szükséges." });
    }

    // Anti-enumeration: always return ok; only actually send if the email is a
    // known guest of at least one trainer.
    const guests = await guestsForEmail(email);
    if (guests.length > 0) {
      try {
        const link = await admin.auth().generateSignInWithEmailLink(email, {
          url: `${webOrigin()}/fiok/belepes`,
          handleCodeInApp: true,
        });
        const mail = magicLinkEmail({ loginUrl: link });
        await sendEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
      } catch (e) {
        console.error("[guest/auth/request-link] send failed:", e.message);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Everything below requires a verified-email Firebase token.
router.use(verifyGuestToken);

// =====================================================================
// GET /api/guest/me
// =====================================================================
router.get("/me", async (req, res) => {
  try {
    const guests = await guestsForEmail(req.guestEmail);
    if (guests.length === 0) {
      return res.json({ email: req.guestEmail, trainers: [] });
    }

    // opportunistically link auth uid onto guest docs (for the trainer app UI)
    const toLink = guests.filter((g) => g.linkedAuthUid !== req.guestUid);
    if (toLink.length) {
      const batch = db.batch();
      toLink.forEach((g) =>
        batch.update(db.collection("guests").doc(g.id), {
          linkedAuthUid: req.guestUid,
          linkedAt: admin.firestore.FieldValue.serverTimestamp(),
        })
      );
      await batch.commit().catch((e) => console.error("[guest/me] link batch:", e.message));
    }

    const todayStr = DateTime.now().setZone(ZONE).startOf("day").toFormat("yyyy-LL-dd HH:mm:ss");

    const trainers = await Promise.all(
      guests.map(async (g) => {
        const [trainerDoc, packages, apptSnap] = await Promise.all([
          db.collection("users").doc(g.user_id).get(),
          getGuestPackagesView(g.id),
          db.collection("appointments").where("guest_id", "==", g.id).limit(300).get(),
        ]);
        const trainer = trainerDoc.exists ? trainerDoc.data() : {};
        const booking = trainer.booking || {};
        const bookingLive = booking.enabled === true && trainerCanOfferBooking(trainer);

        const all = apptSnap.docs
          .map((d) => apptView(d.id, d.data()))
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));

        const upcoming = all.filter(
          (a) => a.date >= todayStr && UPCOMING_STATUSES.has(a.status)
        );
        const history = all
          .filter((a) => !(a.date >= todayStr && UPCOMING_STATUSES.has(a.status)))
          .slice(-20)
          .reverse();

        return {
          trainerId: g.user_id,
          guestId: g.id,
          trainerName: trainerDisplayName(trainer),
          trainerPhotoUrl: trainer.profileImage || null,
          bookingEnabled: bookingLive,
          cancelWindowHours: booking.cancelWindowHours ?? 24,
          serviceTypes: Array.isArray(booking.serviceTypes)
            ? booking.serviceTypes.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin }))
            : [],
          packages,
          upcoming,
          history,
        };
      })
    );

    res.json({ email: req.guestEmail, trainers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// GET /api/guest/t/:trainerId/availability
// =====================================================================
router.get("/t/:trainerId/availability", async (req, res) => {
  try {
    const trainerId = req.params.trainerId;
    const guests = await guestsForEmail(req.guestEmail);
    if (!guests.some((g) => g.user_id === trainerId)) {
      return res.status(403).json({ error: "Nem vagy ennek az edzőnek a vendége." });
    }

    const trainerDoc = await db.collection("users").doc(trainerId).get();
    const trainerUser = trainerDoc.exists ? trainerDoc.data() : {};
    const settings = trainerUser.booking || null;
    if (!settings || settings.enabled !== true || !trainerCanOfferBooking(trainerUser)) {
      return res.status(404).json({ error: "Ennél az edzőnél nem elérhető az online foglalás." });
    }

    const now = DateTime.now().setZone(ZONE);
    const from = req.query.from ? parseLocal(String(req.query.from)) : now.startOf("day");
    let to = req.query.to ? parseLocal(String(req.query.to)) : from.plus({ days: 14 });
    if (!from.isValid || !to.isValid) {
      return res.status(400).json({ error: "Érvénytelen dátumtartomány." });
    }
    if (to.diff(from, "days").days > MAX_RANGE_DAYS) to = from.plus({ days: MAX_RANGE_DAYS });

    const { durationMin, serviceType } = resolveService(settings, req.query.serviceTypeId);
    const appointments = await fetchTrainerAppointments(trainerId, from.toISO(), to.toISO());
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

// =====================================================================
// POST /api/guest/bookings   { trainerId, start, serviceTypeId?, note? }
// =====================================================================
router.post("/bookings", async (req, res) => {
  try {
    const { trainerId, start, serviceTypeId, note } = req.body || {};
    if (!trainerId || !start) {
      return res.status(400).json({ error: "Hiányzó edző vagy időpont." });
    }

    const guests = await guestsForEmail(req.guestEmail);
    const guest = guests.find((g) => g.user_id === trainerId);
    if (!guest) return res.status(403).json({ error: "Nem vagy ennek az edzőnek a vendége." });

    const trainerDoc = await db.collection("users").doc(trainerId).get();
    const trainerUser = trainerDoc.exists ? trainerDoc.data() : {};
    const settings = trainerUser.booking || null;
    if (!settings || settings.enabled !== true || !trainerCanOfferBooking(trainerUser)) {
      return res.status(404).json({ error: "Ennél az edzőnél nem elérhető az online foglalás." });
    }

    const { durationMin, serviceType } = resolveService(settings, serviceTypeId);
    const dayStart = parseLocal(start).startOf("day");
    if (!dayStart.isValid) return res.status(400).json({ error: "Érvénytelen időpont." });

    const appointments = await fetchTrainerAppointments(
      trainerId,
      dayStart.toISO(),
      dayStart.plus({ days: 1 }).toISO()
    );
    const check = isSlotBookable({ settings, appointments, startISO: start, serviceDurationMin: durationMin });
    if (!check.ok) {
      return res.status(409).json({ error: "Ez az időpont már nem foglalható. Válassz másikat." });
    }

    // Hold the guest's active package — NEVER deducts a session.
    const packageId = await findActivePackageId(guest.id);
    const autoConfirm = settings.autoConfirm === true;

    const apptRef = await db.collection("appointments").add({
      user_id: trainerId,
      client_name: guest.name || req.guestEmail,
      date: check.start,
      notes: note ? String(note).trim().slice(0, 500) : "",
      guest_id: guest.id,
      attended: false,
      status: autoConfirm ? "confirmed" : "pending",
      source: "guest_web",
      durationMin,
      serviceTypeId: serviceType ? serviceType.id : null,
      requestedByGuestId: guest.id,
      guest_email: req.guestEmail,
      packageId: packageId || null,
      sessionDeducted: null,
      emailVerified: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const trainer = trainerUser;
    const trainerName = trainerDisplayName(trainer);

    notifyUser(trainerId, {
      title: autoConfirm ? "Új foglalás" : "Új foglalási kérés",
      body: `${guest.name || req.guestEmail} — ${formatDateHu(check.start, check.end)}`,
      data: { type: "booking_request", appointmentId: apptRef.id, status: autoConfirm ? "confirmed" : "pending" },
    }).catch((e) => console.error("[guest/bookings] push failed:", e.message));

    const ics = buildIcs({
      uid: `${apptRef.id}@trainercalendar.hu`,
      startISO: check.start,
      endISO: check.end,
      summary: `Edzés — ${trainerName}`,
      description: autoConfirm ? "Visszaigazolt időpont." : "Időpontkérés — visszaigazolásra vár.",
      organizerName: trainerName,
    });
    const mail = bookingRegisteredEmail({
      trainerName,
      startISO: check.start,
      endISO: check.end,
      autoConfirmed: autoConfirm,
    });
    try {
      await sendEmail({
        to: req.guestEmail,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: trainer.email || undefined,
        attachments: [icsAttachment(ics)],
      });
    } catch (e) {
      console.error("[guest/bookings] email failed:", e.message);
    }

    res.status(201).json({ ok: true, id: apptRef.id, status: autoConfirm ? "confirmed" : "pending" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- shared load + ownership + cancel-window guard --------------------
async function loadCancellableAppt(req, res) {
  const ref = db.collection("appointments").doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) {
    res.status(404).json({ error: "Foglalás nem található." });
    return null;
  }
  const appt = doc.data();

  const guests = await guestsForEmail(req.guestEmail);
  const myGuestIds = new Set(guests.map((g) => g.id));
  if (!myGuestIds.has(appt.guest_id)) {
    res.status(403).json({ error: "Ez nem a te foglalásod." });
    return null;
  }
  if (!UPCOMING_STATUSES.has(appt.status || "confirmed")) {
    res.status(409).json({ error: "Ez a foglalás már nem módosítható." });
    return null;
  }

  const trainerDoc = await db.collection("users").doc(appt.user_id).get();
  const trainer = trainerDoc.exists ? trainerDoc.data() : {};
  const cancelWindowHours = (trainer.booking && trainer.booking.cancelWindowHours) ?? 24;
  const deadline = parseLocal(appt.date).minus({ hours: cancelWindowHours });
  if (DateTime.now().setZone(ZONE) >= deadline) {
    res.status(409).json({
      error: `A módosítási határidő lejárt (${cancelWindowHours} órával a kezdés előtt). Egyeztess az edződdel.`,
    });
    return null;
  }
  return { ref, appt, trainer };
}

// =====================================================================
// POST /api/guest/bookings/:id/cancel   — NEVER touches package sessions
// =====================================================================
router.post("/bookings/:id/cancel", async (req, res) => {
  try {
    const loaded = await loadCancellableAppt(req, res);
    if (!loaded) return;
    const { ref, appt, trainer } = loaded;

    await ref.update({ status: "cancelled_by_guest", cancelledAt: admin.firestore.FieldValue.serverTimestamp() });

    const trainerName = trainerDisplayName(trainer);

    notifyUser(appt.user_id, {
      title: "Vendég lemondta az időpontot",
      body: `${appt.client_name || "Vendég"} — ${formatDateHu(appt.date)}`,
      data: { type: "booking_cancelled", appointmentId: ref.id },
    }).catch((e) => console.error("[guest/cancel] push failed:", e.message));

    const end = parseLocal(appt.date)
      .plus({ minutes: appt.durationMin || (trainer.booking && trainer.booking.slotMinutes) || 60 })
      .toFormat("yyyy-LL-dd HH:mm:ss");
    const mail = bookingCancelledEmail({ trainerName, startISO: appt.date, endISO: end });
    try {
      await sendEmail({
        to: req.guestEmail,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: trainer.email || undefined,
      });
    } catch (e) {
      console.error("[guest/cancel] email failed:", e.message);
    }

    res.json({ ok: true, status: "cancelled_by_guest" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// POST /api/guest/bookings/:id/reschedule   { start, serviceTypeId? }
//   — moves the appointment; leaves packageId untouched
// =====================================================================
router.post("/bookings/:id/reschedule", async (req, res) => {
  try {
    const { start, serviceTypeId } = req.body || {};
    if (!start) return res.status(400).json({ error: "Válassz új időpontot." });

    const loaded = await loadCancellableAppt(req, res);
    if (!loaded) return;
    const { ref, appt, trainer } = loaded;

    const settings = trainer.booking || null;
    if (!settings || settings.enabled !== true || !trainerCanOfferBooking(trainer)) {
      return res.status(404).json({ error: "Ennél az edzőnél nem elérhető az online foglalás." });
    }

    const { durationMin, serviceType } = resolveService(
      settings,
      serviceTypeId || appt.serviceTypeId
    );
    const dayStart = parseLocal(start).startOf("day");
    if (!dayStart.isValid) return res.status(400).json({ error: "Érvénytelen időpont." });

    let appointments = await fetchTrainerAppointments(
      appt.user_id,
      dayStart.toISO(),
      dayStart.plus({ days: 1 }).toISO()
    );
    // ignore this appointment's own current slot when checking for clashes
    appointments = appointments.filter((a) => a.date !== appt.date);

    const check = isSlotBookable({ settings, appointments, startISO: start, serviceDurationMin: durationMin });
    if (!check.ok) {
      return res.status(409).json({ error: "Ez az időpont már nem foglalható. Válassz másikat." });
    }

    const autoConfirm = settings.autoConfirm === true;
    await ref.update({
      date: check.start,
      durationMin,
      serviceTypeId: serviceType ? serviceType.id : null,
      status: autoConfirm ? "confirmed" : "pending",
      rescheduledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const trainerName = trainerDisplayName(trainer);

    notifyUser(appt.user_id, {
      title: "Vendég áthelyezte az időpontot",
      body: `${appt.client_name || "Vendég"} — ${formatDateHu(check.start, check.end)}`,
      data: { type: "booking_rescheduled", appointmentId: ref.id, status: autoConfirm ? "confirmed" : "pending" },
    }).catch((e) => console.error("[guest/reschedule] push failed:", e.message));

    const ics = buildIcs({
      uid: `${ref.id}@trainercalendar.hu`,
      startISO: check.start,
      endISO: check.end,
      summary: `Edzés — ${trainerName}`,
      description: autoConfirm ? "Visszaigazolt (áthelyezett) időpont." : "Áthelyezett időpontkérés — visszaigazolásra vár.",
      organizerName: trainerName,
    });
    const mail = bookingRegisteredEmail({
      trainerName,
      startISO: check.start,
      endISO: check.end,
      autoConfirmed: autoConfirm,
    });
    try {
      await sendEmail({
        to: req.guestEmail,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: trainer.email || undefined,
        attachments: [icsAttachment(ics)],
      });
    } catch (e) {
      console.error("[guest/reschedule] email failed:", e.message);
    }

    res.json({ ok: true, id: ref.id, status: autoConfirm ? "confirmed" : "pending" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
