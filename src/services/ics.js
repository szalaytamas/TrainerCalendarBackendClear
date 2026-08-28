const { DateTime } = require("luxon");
const { parseLocal, ZONE } = require("./availability");

/**
 * Build a minimal RFC 5545 VCALENDAR string for a single appointment.
 * Times are emitted as local (Europe/Budapest) with an explicit TZID.
 */
function buildIcs({ uid, startISO, endISO, summary, description, organizerName }) {
  const local = (iso) => parseLocal(iso).toFormat("yyyyLLdd'T'HHmmss");
  const stampUtc = DateTime.utc().toFormat("yyyyLLdd'T'HHmmss'Z'");
  const esc = (s) => String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\r?\n/g, "\\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Trainer Calendar//HU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${esc(uid)}`,
    `DTSTAMP:${stampUtc}`,
    `DTSTART;TZID=${ZONE}:${local(startISO)}`,
    `DTEND;TZID=${ZONE}:${local(endISO)}`,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    organizerName ? `ORGANIZER;CN=${esc(organizerName)}:mailto:noreply@trainercalendar.hu` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return lines.join("\r\n");
}

/** Resend attachment shape: { filename, content } with base64 content. */
function icsAttachment(content, filename = "idopont.ics") {
  return { filename, content: Buffer.from(content, "utf8").toString("base64") };
}

module.exports = { buildIcs, icsAttachment };
