// GET /api/debug-convo?key=YOUR_SETUP_SECRET&id=CONVERSATION_ID
// Returns the raw conversation payload (truncated) so field names can be
// verified against the live API. Safe to remove once things work.

import { getConversation } from "../lib/sendkit.js";

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!req.query.id) return res.status(400).json({ error: "Add &id=CONVERSATION_ID" });
  try {
    const raw = await getConversation(req.query.id);
    const s = JSON.stringify(raw);
    return res.status(200).json({ truncated: s.length > 6000, payload: JSON.parse(s.length > 6000 ? truncate(raw) : s) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Keep structure but clip long strings so the response stays readable
function truncate(obj) {
  return JSON.stringify(obj, (k, v) => (typeof v === "string" && v.length > 400 ? v.slice(0, 400) + "…" : v));
}
