// Plain-node smoke tests:  node src/services/availability.test.js
const assert = require("assert");
const { DateTime } = require("luxon");
const { computeFreeSlots, isSlotBookable } = require("./availability");

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("FAIL  " + name + "\n      " + e.message);
    process.exitCode = 1;
  }
};

const now = DateTime.fromISO("2026-09-01T08:00", { zone: "Europe/Budapest" }); // Tuesday
const settings = {
  slotMinutes: 60,
  bufferMinutes: 15,
  minNoticeHours: 12,
  maxAdvanceDays: 30,
  workingHours: {
    tue: [{ start: "09:00", end: "12:00" }],
    wed: [{ start: "14:00", end: "16:00" }],
  },
};

t("respects min-notice window (no same-morning slots)", () => {
  const slots = computeFreeSlots({
    settings, appointments: [], fromISO: "2026-09-01T00:00", toISO: "2026-09-02T00:00", now,
  });
  assert.strictEqual(slots.length, 0);
});

t("emits working-hours slots on later days", () => {
  const slots = computeFreeSlots({
    settings, appointments: [], fromISO: "2026-09-02T00:00", toISO: "2026-09-03T00:00", now,
  });
  assert.deepStrictEqual(slots.map((s) => s.start), ["2026-09-02T14:00", "2026-09-02T15:00"]);
});

t("existing appointment blocks only its own slot when buffer = 0", () => {
  const noBuffer = { ...settings, bufferMinutes: 0 };
  const appts = [{ date: "2026-09-02T14:00", durationMin: 60, status: "confirmed" }];
  const slots = computeFreeSlots({
    settings: noBuffer, appointments: appts, fromISO: "2026-09-02T00:00", toISO: "2026-09-03T00:00", now,
  });
  assert.deepStrictEqual(slots.map((s) => s.start), ["2026-09-02T15:00"]);
});

t("buffer extends the block to adjacent slots", () => {
  // appt 14:00-15:00 with 15-min buffer → busy 13:45-15:15 → both 14:00 and 15:00 blocked
  const appts = [{ date: "2026-09-02T14:00", durationMin: 60, status: "confirmed" }];
  const slots = computeFreeSlots({
    settings, appointments: appts, fromISO: "2026-09-02T00:00", toISO: "2026-09-03T00:00", now,
  });
  assert.strictEqual(slots.length, 0);
});

t("declined/cancelled appointments do not block", () => {
  const appts = [
    { date: "2026-09-02T14:00", durationMin: 60, status: "declined" },
    { date: "2026-09-02T15:00", durationMin: 60, status: "cancelled_by_guest" },
  ];
  const slots = computeFreeSlots({
    settings, appointments: appts, fromISO: "2026-09-02T00:00", toISO: "2026-09-03T00:00", now,
  });
  assert.strictEqual(slots.length, 2);
});

t("isSlotBookable accepts a valid free slot", () => {
  const r = isSlotBookable({ settings, appointments: [], startISO: "2026-09-02T14:00", now });
  assert.strictEqual(r.ok, true);
});

t("isSlotBookable rejects a slot outside working hours", () => {
  const r = isSlotBookable({ settings, appointments: [], startISO: "2026-09-02T09:00", now });
  assert.strictEqual(r.ok, false);
});

t("isSlotBookable rejects an already-taken slot", () => {
  const appts = [{ date: "2026-09-02T14:00", durationMin: 60, status: "confirmed" }];
  const r = isSlotBookable({ settings, appointments: appts, startISO: "2026-09-02T14:00", now });
  assert.strictEqual(r.ok, false);
});

console.log(`\n${pass} passed`);
