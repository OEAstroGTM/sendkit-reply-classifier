// GET /api/recent?key=YOUR_SETUP_SECRET
// Lists recent inbox conversations with their tags, for the dashboard.

const BASE = "https://api.sendkit.ai";

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const r = await fetch(`${BASE}/v1/inbox?limit=25`, {
      headers: { "X-Api-Key": process.env.SENDKIT_API_KEY },
    });
    const json = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(json).slice(0, 300));

    const list = json.data?.conversations || json.data || [];
    const rows = (Array.isArray(list) ? list : []).map((c) => ({
      id: c._id || c.id,
      lead: c.leadName || c.lead?.name || c.leadEmail || c.lead?.email || "",
      email: c.leadEmail || c.lead?.email || "",
      subject: c.subject || "",
      tags: c.tags || (c.tag ? [c.tag] : []),
      unread: !!c.unread,
      updatedAt: c.updatedAt || c.lastMessageAt || "",
    }));
    return res.status(200).json({ conversations: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
