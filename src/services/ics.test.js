// node src/services/ics.test.js
const assert = require("assert");
const { buildIcs, icsAttachment } = require("./ics");

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
};

const ics = buildIcs({
  uid: "abc123@trainercalendar.hu",
  startISO: "2026-09-02T14:00",
  endISO: "2026-09-02T15:00",
  summary: "Edzés — Kovács Péter",
  description: "Visszaigazolt időpont.",
  organizerName: "Kovács Péter",
});

t("wraps a single VEVENT in a VCALENDAR", () => {
  assert.ok(ics.startsWith("BEGIN:VCALENDAR"));
  assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
});

t("emits local times with TZID", () => {
  assert.ok(ics.includes("DTSTART;TZID=Europe/Budapest:20260902T140000"));
  assert.ok(ics.includes("DTEND;TZID=Europe/Budapest:20260902T150000"));
});

t("carries uid and summary", () => {
  assert.ok(ics.includes("UID:abc123@trainercalendar.hu"));
  assert.ok(ics.includes("SUMMARY:Edzés — Kovács Péter"));
});

t("uses CRLF line endings", () => {
  assert.ok(ics.includes("\r\n"));
});

t("icsAttachment returns base64 content", () => {
  const att = icsAttachment(ics);
  assert.strictEqual(att.filename, "idopont.ics");
  assert.strictEqual(Buffer.from(att.content, "base64").toString("utf8"), ics);
});

console.log(`\n${pass} passed`);
