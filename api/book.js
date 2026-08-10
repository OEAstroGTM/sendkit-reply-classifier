// GET  /api/book?e=lead@x.com&t=1690000000&d=30&n=Charles&sig=...
// POST /api/book  (same params, from the confirm form)
//
// The page a lead lands on when they click a proposed time in the email.
//
// IMPORTANT: GET must never write to the calendar. Corporate mail security
// scanners (Mimecast, Proofpoint, Barracuda, Outlook SafeLinks) fetch every
// link in an inbound message before the human sees it. When booking happened
// on GET, those scanners silently booked every proposed slot and mailed the
// lead a calendar invite they never asked for. GET now only renders a confirm
// button; the POST behind it does the write. Scanners do not submit forms.

import { createEvent, formatSlot } from "../lib/nylas.js";
import { verifySlot } from "../lib/booking.js";
import { cancelFollowups } from "../lib/followup.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const p = { ...req.query, ...(req.body || {}) };
  const { e: email, t, d, n: name, c: conversationId, sig } = p;
  const startTime = Number(t);
  const durationMin = Number(d || 30);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Belt and braces: never let a proxy cache a booking page.
  res.setHeader("Cache-Control", "no-store");

  if (!email || !startTime || !sig || !verifySlot(email, startTime, durationMin, sig, conversationId || "")) {
    return res.status(400).send(page("This booking link is not valid.", "Please reply to the email and we'll sort out a time."));
  }
  if (startTime * 1000 < Date.now()) {
    return res.status(410).send(page("That time has already passed.", "Reply to the email and we'll find a new time."));
  }

  const tz = process.env.TIMEZONE || "America/New_York";
  const label = formatSlot(startTime, tz);
  const host = process.env.SENDER_NAME || "the team";

  // Anything that is not an explicit POST gets the confirmation page only.
  if (String(req.method || "GET").toUpperCase() !== "POST") {
    return res.status(200).send(confirmPage({ label, durationMin, email, t, d, name, conversationId, sig }));
  }

  try {
    await createEvent({
      startTime,
      endTime: startTime + durationMin * 60,
      title: `${host} <> ${name || email}`,
      leadEmail: email,
      leadName: name || "",
      description: "Booked from email.",
    });
    if (conversationId) cancelFollowups(conversationId).catch(() => {});
    return res.status(200).send(page(
      "You're booked.",
      `${label} (${durationMin} min). A calendar invite is on its way to ${escapeHtml(email)}.`
    ));
  } catch (err) {
    console.error(`booking failed: ${err.message}`);
    return res.status(500).send(page(
      "Something went wrong booking that time.",
      "Just reply to the email and we'll confirm your slot directly."
    ));
  }
}

function confirmPage({ label, durationMin, email, t, d, name, conversationId, sig }) {
  const hidden = Object.entries({ e: email, t, d, n: name || "", c: conversationId || "", sig })
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  return shell(`
    <div style="font-size:44px;margin-bottom:12px">&#128197;</div>
    <h1 style="font-size:20px;margin:0 0 6px">Confirm your time</h1>
    <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 4px"><strong>${escapeHtml(label)}</strong></p>
    <p style="color:#777;font-size:14px;margin:0 0 22px">${durationMin} minutes &middot; invite goes to ${escapeHtml(email)}</p>
    <form method="POST" action="/api/book">${hidden}
      <button type="submit" style="background:#1a56db;color:#fff;border:0;border-radius:8px;padding:13px 30px;font-size:15px;cursor:pointer">Confirm booking</button>
    </form>
    <p style="color:#999;font-size:13px;margin:20px 0 0">Wrong time? Just reply to the email.</p>
  `, "Confirm your time");
}

function page(title, sub) {
  return shell(`
    <div style="font-size:44px;margin-bottom:12px">${title.startsWith("You're") ? "&#9989;" : "&#9888;&#65039;"}</div>
    <h1 style="font-size:20px;margin:0 0 10px">${escapeHtml(title)}</h1>
    <p style="color:#555;font-size:15px;line-height:1.5;margin:0">${escapeHtml(sub)}</p>
  `, title);
}

function shell(inner, title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title></head>
  <body style="margin:0;background:#f0f2f5;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
    <div style="background:#fff;border-radius:12px;padding:40px;max-width:440px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)">${inner}</div>
  </body></html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
