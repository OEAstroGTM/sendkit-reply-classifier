// Signed one-click booking links. Each proposed time in a reply links to
// /api/book?...&sig=... — the signature stops anyone from forging bookings.

import crypto from "node:crypto";

function secret() {
  const s = process.env.LINK_SECRET || process.env.SETUP_SECRET;
  if (!s) throw new Error("Set SETUP_SECRET (or LINK_SECRET) for booking links");
  return s;
}

export function signSlot(email, startTime, durationMin, conversationId = "") {
  return crypto
    .createHmac("sha256", secret())
    .update(`${email}|${startTime}|${durationMin}|${conversationId}`)
    .digest("hex")
    .slice(0, 24);
}

export function verifySlot(email, startTime, durationMin, sig, conversationId = "") {
  try {
    const expected = signSlot(email, startTime, durationMin, conversationId);
    return crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Turns each slot's label in already-rendered HTML into a signed booking link.
// Pairs by timestamp, so the visible label can be in the lead's own timezone
// and still link to the correct moment.
export function linkifySlots(html, slots = [], { email, name, baseUrl, durationMin = 30, conversationId = "" } = {}) {
  if (!email || !baseUrl) return html;
  let out = html;
  for (const s of slots) {
    if (!s?.label || !s?.start_time) continue;
    const url = bookUrl(baseUrl, {
      email, name, startTime: s.start_time, durationMin, conversationId,
    });
    out = out.split(s.label).join(`<a href="${url}" style="color:#1a56db">${s.label}</a>`);
  }
  return out;
}

export function bookUrl(baseUrl, { email, name, startTime, durationMin, conversationId = "" }) {
  const p = new URLSearchParams({
    e: email,
    t: String(startTime),
    d: String(durationMin),
    ...(name ? { n: name } : {}),
    ...(conversationId ? { c: conversationId } : {}),
    sig: signSlot(email, startTime, durationMin, conversationId),
  });
  return `${baseUrl}/api/book?${p}`;
}
