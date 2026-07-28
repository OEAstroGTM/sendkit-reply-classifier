// GET /api/book?e=lead@x.com&t=1690000000&d=30&n=Charles&sig=...
// The page a lead lands on when they click a proposed time in the email.
// Verifies the signed link, books the slot on the calendar via Nylas
// (lead gets the calendar invite), and shows a confirmation.

import { createEvent, formatSlot } from "../lib/nylas.js";
import { verifySlot } from "../lib/booking.js";
import { cancelFollowups } from "../lib/followup.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const { e: email, t, d, n: name, c: conversationId, sig } = req.query;
  const startTime = Number(t);
  const durationMin = Number(d || 30);
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!email || !startTime || !sig || !verifySlot(email, startTime, durationMin, sig, conversationId || "")) {
    return res.status(400).send(page("This booking link is not valid.", "Please reply to the email and we'll sort out a time."));
  }
  if (startTime * 1000 < Date.now()) {
    return res.status(410).send(page("That time has already passed.", "Reply to the email and we'll find a new time."));
  }

  const tz = process.env.TIMEZONE || "America/New_York";
  const label = formatSlot(startTime, tz);
  const host = process.env.SENDER_NAME || "the team";

  try {
    await createEvent({
      startTime,
      endTime: startTime + durationMin * 60,
      title: `${host} <> ${name || email}`,
      leadEmail: email,
      leadName: name || "",
      description: "Booked from email.",
    });
    // They booked: stop any pending follow-up bumps
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

function page(title, sub) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title></head>
  <body style="margin:0;background:#f0f2f5;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
    <div style="background:#fff;border-radius:12px;padding:40px;max-width:440px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)">
      <div style="font-size:44px;margin-bottom:12px">${title.startsWith("You're") ? "&#9989;" : "&#9888;&#65039;"}</div>
      <h1 style="font-size:20px;margin:0 0 10px">${escapeHtml(title)}</h1>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0">${escapeHtml(sub)}</p>
    </div>
  </body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
