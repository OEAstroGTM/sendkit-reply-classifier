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
