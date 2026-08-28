const { DateTime, Interval } = require("luxon");

// All trainer/guest wall-clock times are interpreted in this zone.
// Appointment `date` strings are stored WITHOUT a timezone designator
// (e.g. "2026-08-28T17:00"), matching the existing app behaviour.
const ZONE = "Europe/Budapest";

// Luxon weekday: 1=Mon .. 7=Sun.  (weekday % 7) → Mon=1..Sat=6, Sun=0
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const ACTIVE_STATUSES_BLOCKING = (status) => {
  const s = status || "confirmed";
  return s !== "declined" && s !== "cancelled_by_guest" && s !== "cancelled_by_trainer";
};

function parseHM(hm) {
  const [h, m] = String(hm).split(":").map(Number);
  return { h, m };
}

function wallClock(dt) {
  return dt.toFormat("yyyy-LL-dd'T'HH:mm");
}

/**
 * Compute bookable free slots for a trainer using the "working hours" model.
 *
 * @param {Object}  opts
 * @param {Object}  opts.settings              users/{id}.booking object
 * @param {Array}   opts.appointments          [{ date:"ISO wall-clock", durationMin?, status? }]
 * @param {string}  opts.fromISO               range start (wall-clock or ISO), inclusive
 * @param {string}  opts.toISO                 range end (wall-clock or ISO), exclusive
 * @param {number} [opts.serviceDurationMin]   duration of the service being booked
 * @param {DateTime} [opts.now]                injectable "now" for testing
 * @returns {Array<{ start:string, end:string }>}  wall-clock strings, same format as appointment.date
 */
function computeFreeSlots({ settings, appointments, fromISO, toISO, serviceDurationMin, now }) {
  const s = settings || {};
  const slotMinutes = clampNumber(serviceDurationMin || s.slotMinutes || 60, 5, 480);
  const buffer = clampNumber(s.bufferMinutes || 0, 0, 240);
  const minNoticeHours = clampNumber(s.minNoticeHours || 0, 0, 24 * 60);
  const maxAdvanceDays = clampNumber(s.maxAdvanceDays || 60, 1, 365);
  const wh = s.workingHours || {};

  const nowDt = (now || DateTime.now()).setZone(ZONE);
  const earliest = nowDt.plus({ hours: minNoticeHours });
  const latest = nowDt.plus({ days: maxAdvanceDays }).endOf("day");

  let rangeStart = DateTime.fromISO(fromISO, { zone: ZONE });
  let rangeEnd = DateTime.fromISO(toISO, { zone: ZONE });
  if (!rangeStart.isValid || !rangeEnd.isValid) return [];
  if (rangeStart < earliest) rangeStart = earliest;
  if (rangeEnd > latest) rangeEnd = latest;
  if (rangeEnd <= rangeStart) return [];

  // Busy intervals from existing appointments (buffer padded on both sides).
  const busy = (appointments || [])
    .filter((a) => a && a.date && ACTIVE_STATUSES_BLOCKING(a.status))
    .map((a) => {
      const start = DateTime.fromISO(a.date, { zone: ZONE });
      if (!start.isValid) return null;
      const dur = clampNumber(a.durationMin || s.slotMinutes || 60, 5, 480);
      return Interval.fromDateTimes(
        start.minus({ minutes: buffer }),
        start.plus({ minutes: dur + buffer })
      );
    })
    .filter((iv) => iv && iv.isValid);

  const results = [];
  let cursorDay = rangeStart.startOf("day");
  const lastDay = rangeEnd.startOf("day");

  while (cursorDay <= lastDay) {
    const dayKey = DAY_KEYS[cursorDay.weekday % 7];
    const windows = Array.isArray(wh[dayKey]) ? wh[dayKey] : [];

    for (const w of windows) {
      const from = parseHM(w.start);
      const to = parseHM(w.end);
      if ([from.h, from.m, to.h, to.m].some((n) => Number.isNaN(n))) continue;

      const windowEnd = cursorDay.set({ hour: to.h, minute: to.m, second: 0, millisecond: 0 });
      let slotStart = cursorDay.set({ hour: from.h, minute: from.m, second: 0, millisecond: 0 });

      while (slotStart.plus({ minutes: slotMinutes }) <= windowEnd) {
        const slotEnd = slotStart.plus({ minutes: slotMinutes });
        const inRange = slotStart >= rangeStart && slotStart >= earliest && slotEnd <= rangeEnd;
        if (inRange) {
          const iv = Interval.fromDateTimes(slotStart, slotEnd);
          const clashes = busy.some((b) => b.overlaps(iv));
          if (!clashes) results.push({ start: wallClock(slotStart), end: wallClock(slotEnd) });
        }
        slotStart = slotStart.plus({ minutes: slotMinutes });
      }
    }
    cursorDay = cursorDay.plus({ days: 1 });
  }
  return results;
}

/**
 * Is a specific wall-clock start still bookable right now?
 * Used by the booking-creation endpoints to re-validate the chosen slot.
 */
function isSlotBookable({ settings, appointments, startISO, serviceDurationMin, now }) {
  const s = settings || {};
  const dur = clampNumber(serviceDurationMin || s.slotMinutes || 60, 5, 480);
  const start = DateTime.fromISO(startISO, { zone: ZONE });
  if (!start.isValid) return { ok: false, reason: "invalid_slot" };

  const end = start.plus({ minutes: dur });
  const slots = computeFreeSlots({
    settings: s,
    appointments,
    fromISO: start.startOf("day").toISO(),
    toISO: end.plus({ days: 1 }).toISO(),
    serviceDurationMin: dur,
    now,
  });
  const wanted = wallClock(start);
  return slots.some((sl) => sl.start === wanted)
    ? { ok: true, start: wanted, end: wallClock(end) }
    : { ok: false, reason: "slot_taken" };
}

function clampNumber(v, min, max) {
  const n = Number(v);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

module.exports = { computeFreeSlots, isSlotBookable, ZONE };
