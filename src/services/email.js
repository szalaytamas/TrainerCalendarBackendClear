const { DateTime } = require("luxon");
const { ZONE } = require("./availability");

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function fromAddress() {
  return process.env.EMAIL_FROM || "Trainer Calendar <noreply@trainercalendar.hu>";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/**
 * Send a transactional email through Resend. If RESEND_API_KEY is not set
 * (local dev) the send is logged and skipped rather than throwing.
 *
 * @param {{ to:string|string[], subject:string, html:string, text?:string,
 *           replyTo?:string, attachments?:Array<{filename:string,content:string}> }} msg
 */
async function sendEmail({ to, subject, html, text, replyTo, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY not set — skipped: "${subject}" -> ${to}`);
    return { skipped: true };
  }

  const body = {
    from: fromAddress(),
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (text) body.text = text;
  if (replyTo) body.reply_to = replyTo;
  if (attachments && attachments.length) body.attachments = attachments;

  const resp = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Resend send failed (${resp.status}): ${errText}`);
  }
  return resp.json();
}

/** "2026. szeptember 2. (szerda) 14:00–15:00" */
function formatDateHu(startISO, endISO) {
  const start = DateTime.fromISO(startISO, { zone: ZONE }).setLocale("hu");
  const end = endISO ? DateTime.fromISO(endISO, { zone: ZONE }).setLocale("hu") : null;
  const day = start.toFormat("yyyy. LLLL d. (cccc)");
  const time = end ? `${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")}` : start.toFormat("HH:mm");
  return `${day} ${time}`;
}

const BTN =
  "background:#1B5E8A;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;display:inline-block";

// --- templates -------------------------------------------------------------

function verificationEmail({ trainerName, startISO, endISO, verifyUrl }) {
  const when = formatDateHu(startISO, endISO);
  return {
    subject: "Erősítsd meg az időpontfoglalásod",
    text:
`Szia!

Időpontot foglaltál ${trainerName} edzőhöz:
${when}

Erősítsd meg az e-mail-címed az alábbi linkkel (24 órán belül él):
${verifyUrl}

Ha nem te foglaltál, hagyd figyelmen kívül ezt az e-mailt.`,
    html:
`<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1a1a1a">
<p>Szia!</p>
<p>Időpontot foglaltál <strong>${escapeHtml(trainerName)}</strong> edzőhöz:</p>
<p style="font-size:17px"><strong>${escapeHtml(when)}</strong></p>
<p>Erősítsd meg az e-mail-címed (a link 24 óráig él):</p>
<p><a href="${escapeHtml(verifyUrl)}" style="${BTN}">Foglalás megerősítése</a></p>
<p style="color:#666;font-size:13px">Ha nem te foglaltál, hagyd figyelmen kívül ezt az e-mailt.</p>
</div>`,
  };
}

function bookingRegisteredEmail({ trainerName, startISO, endISO, autoConfirmed }) {
  const when = formatDateHu(startISO, endISO);
  const line = autoConfirmed
    ? "Az időpontod visszaigazolva."
    : "Az időpontkérésed rögzítettük — az edződ hamarosan visszaigazolja.";
  return {
    subject: autoConfirmed ? "Időpontod visszaigazolva" : "Időpontkérésed rögzítettük",
    text:
`Szia!

${line}

Edző: ${trainerName}
Időpont: ${when}

A naptáradhoz csatoltuk az esemény (.ics) fájlt.`,
    html:
`<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1a1a1a">
<p>Szia!</p>
<p>${escapeHtml(line)}</p>
<p><strong>Edző:</strong> ${escapeHtml(trainerName)}<br>
<strong>Időpont:</strong> ${escapeHtml(when)}</p>
<p style="color:#666;font-size:13px">A naptáradhoz csatoltuk az esemény (.ics) fájlt.</p>
</div>`,
  };
}

function magicLinkEmail({ loginUrl }) {
  return {
    subject: "Belépés a foglalási fiókodba",
    text:
`Szia!

Kattints az alábbi linkre a belépéshez (rövid ideig él):
${loginUrl}

Ha nem te kérted, hagyd figyelmen kívül ezt az e-mailt.`,
    html:
`<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1a1a1a">
<p>Szia!</p>
<p>Kattints a belépéshez (a link rövid ideig él):</p>
<p><a href="${escapeHtml(loginUrl)}" style="${BTN}">Belépés</a></p>
<p style="color:#666;font-size:13px">Ha nem te kérted, hagyd figyelmen kívül ezt az e-mailt.</p>
</div>`,
  };
}

function bookingCancelledEmail({ trainerName, startISO, endISO }) {
  const when = formatDateHu(startISO, endISO);
  return {
    subject: "Időpont lemondva",
    text:
`Szia!

Lemondtad az időpontod:
Edző: ${trainerName}
Időpont: ${when}`,
    html:
`<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1a1a1a">
<p>Szia!</p>
<p>Lemondtad az időpontod:</p>
<p><strong>Edző:</strong> ${escapeHtml(trainerName)}<br>
<strong>Időpont:</strong> ${escapeHtml(when)}</p>
</div>`,
  };
}

module.exports = {
  sendEmail,
  formatDateHu,
  verificationEmail,
  bookingRegisteredEmail,
  magicLinkEmail,
  bookingCancelledEmail,
};
