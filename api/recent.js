// GET /api/recent?key=YOUR_SETUP_SECRET          -> only conversations with one of the 6 tags
// GET /api/recent?key=...&all=1                  -> everything (tagged + untagged)
// GET /api/recent?key=...&debug=1                -> includes a raw sample for troubleshooting

import { CATEGORY_SET, extractTags, listConversations } from "../lib/inbox.js";

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const list = await listConversations(50);

    let rows = list.map((c) => ({
      id: c._id || c.id,
      lead: c.leadName || c.lead?.name || c.leadEmail || c.lead?.email || "",
      email: c.leadEmail || c.lead?.email || "",
      subject: c.subject || "",
      tags: extractTags(c).filter((t) => CATEGORY_SET.has(t)),
      unread: !!c.unread,
      updatedAt: c.updatedAt || c.lastMessageAt || "",
    }));

    const untaggedCount = rows.filter((r) => r.tags.length === 0).length;
    if (req.query.all !== "1") rows = rows.filter((r) => r.tags.length > 0);

    const out = { conversations: rows, untaggedCount };
    if (req.query.debug === "1" && list[0]) out.rawSample = list[0];
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
