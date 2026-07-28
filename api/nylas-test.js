// GET /api/nylas-test?key=YOUR_SETUP_SECRET
// Diagnoses the Nylas path step by step with timings.

import { getGrant, getAvailableSlots, pickAndFormatSlots } from "../lib/nylas.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const out = {};
  try {
    let t = Date.now();
    const grant = await getGrant();
    out.grant = { email: grant.email, ms: Date.now() - t };

    t = Date.now();
    const slots = await getAvailableSlots();
    out.availability = { slotCount: slots.length, ms: Date.now() - t };
    out.proposedTimes = pickAndFormatSlots(slots, 3);
    return res.status(200).json(out);
  } catch (e) {
    out.error = e.message;
    return res.status(500).json(out);
  }
}
