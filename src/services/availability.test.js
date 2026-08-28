// Plain-node smoke tests:  node src/services/availability.test.js
const assert = require("assert");
const { DateTime } = require("luxon");
const { computeFreeSlots, isSlotBookable, parseLocal } = require("./availability");

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

t("parseLocal accepts the app's 'space + seconds' format", () => {
  const dt = parseLocal("2026-09-02 14:00:00");
  assert.strictEqual(dt.isValid, true);
  assert.strictEqual(dt.toFormat("yyyy-LL-dd HH:mm"), "2026-09-02 14:00");
});

t("parseLocal also accepts ISO and date-only", () => {
  assert.strictEqual(parseLocal("2026-09-02T14:00").isValid, true);
  assert.strictEqual(parseLocal("2026-09-02").isValid, true);
  assert.strictEqual(parseLocal("2026-09-02T00:00:00.000+02:00").isValid, true);
});

t("slots are emitted in 'yyyy-MM-dd HH:mm:ss' format", () => {
  const slots = computeFreeSlots({
    settings, appointments: [], fromISO: "2026-09-02T00:00", toISO: "2026-09-03T00:00", now,
  });
  assert.deepStrictEqual(slots.map((s) => s.start), ["2026-09-02 14:00:00", "2026-09-02 15:00:00"]);
});

t("respects min-notice window (no same-morning slots)", () => {
  const slots = computeFreeSlots({
    settings, appointments: [], fromISO: "2026-09-01T00:00", toISO: "2026-09-02T00:00", now,
  });
  assert.strictEqual(slots.length, 0);
});

t("existing space-format appointment blocks its slot (buffer = 0)", () => {
  const noBuffer = { ...settings, bufferMinutes: 0 };
  const appts = [{ date: "2026-09-02 14:00:00", durationMin: 60, status: "confirmed" }];
  const slots = computeFreeSlots({
    settings: noBuffer, appointments: appts, fromISO: "2026-09-02T00:00", toISO: "2026-09-03T00:00", now,
  });
  assert.deepStrictEqual(slots.map((s) => s.start), ["2026-09-02 15:00:00"]);
});

t("buffer extends the block to adjacent slots", () => {
  const appts = [{ date: "2026-09-02 14:00:00", durationMin: 60, status: "confirmed" }];
  const slots = computeFreeSlots({
    settings, appointments: appts, fromISO: "2026-09-02T00:00", toISO: "2026-09-03T00:00", now,
  });
  assert.strictEqual(slots.length, 0);
});

t("declined/cancelled appointments do not block", () => {
  const appts = [
    { date: "2026-09-02 14:00:00", durationMin: 60, status: "declined" },
    { date: "2026-09-02 15:00:00", durationMin: 60, status: "cancelled_by_guest" },
  ];
  const slots = computeFreeSlots({
    settings, appointments: appts, fromISO: "2026-09-02T00:00", toISO: "2026-09-03T00:00", now,
  });
  assert.strictEqual(slots.length, 2);
});

t("isSlotBookable accepts a valid free slot (space format in)", () => {
  const r = isSlotBookable({ settings, appointments: [], startISO: "2026-09-02 14:00:00", now });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.start, "2026-09-02 14:00:00");
});

t("isSlotBookable rejects a slot outside working hours", () => {
  const r = isSlotBookable({ settings, appointments: [], startISO: "2026-09-02 09:00:00", now });
  assert.strictEqual(r.ok, false);
});

t("isSlotBookable rejects an already-taken slot", () => {
  const appts = [{ date: "2026-09-02 14:00:00", durationMin: 60, status: "confirmed" }];
  const r = isSlotBookable({ settings, appointments: appts, startISO: "2026-09-02 14:00:00", now });
  assert.strictEqual(r.ok, false);
});

console.log(`\n${pass} passed`);
