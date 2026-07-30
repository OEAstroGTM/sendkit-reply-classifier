// GET /api/slots?key=...&start=8:00&end=11:00&days=10&count=6&for=Asia/Kolkata
// Availability for a specific window. `for` additionally renders each slot in
// the lead's timezone so you can offer times that actually work for them.

import { getAvailableSlots, pickSlots, formatSlot, getParticipants } from "../lib/nylas.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // ?grants=1 lists every calendar connected to the Nylas app
  if (req.query.grants === "1") {
    try {
      const r = await fetch(
        `https://api.${(process.env.NYLAS_REGION || "us").toLowerCase()}.nylas.com/v3/grants`,
        { headers: { Authorization: `Bearer ${process.env.NYLAS_API_KEY}`, Accept: "application/json" } }
      );
      const j = await r.json();
      return res.status(200).json({
        grants: (j.data || []).map((g) => ({
          id: g.id, email: g.email, provider: g.provider, status: g.grant_status,
        })),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    const slots = await getAvailableSlots({
      workStart: req.query.start,
      workEnd: req.query.end,
      lookaheadDays: req.query.days,
      workDays: req.query.workdays,
      minNoticeHours: req.query.notice,
      meetingMinutes: req.query.duration,
    });
    const count = Math.min(Number(req.query.count || 6), 20);
    const picked = pickSlots(slots, count);
    const leadTz = req.query.for;

    return res.status(200).json({
      window: `${req.query.start || process.env.WORK_START || "9:00"}-${req.query.end || process.env.WORK_END || "17:00"}`,
      // every calendar these slots were checked against
      participants: await getParticipants(),
      found: slots.length,
      slots: picked.map((s) => ({
        start_time: s.start_time,
        end_time: s.end_time,
        label: s.label,
        ...(leadTz ? { leadLocal: safeFormat(s.start_time, leadTz) } : {}),
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function safeFormat(t, tz) {
  try { return formatSlot(t, tz); } catch { return "invalid timezone"; }
}
