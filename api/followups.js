// GET  /api/followups?key=...                      -> all pending follow-ups across tagged conversations
// GET  /api/followups?key=...&cancel=1&id=..&replyId=..  -> cancel one

import { listConversationsWithAnyTag } from "../lib/inbox.js";
import { listScheduledReplies, cancelScheduledReply } from "../lib/sendkit.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (req.query.cancel === "1") {
      const { id, replyId } = req.query;
      if (!id || !replyId) return res.status(400).json({ error: "Need &id= and &replyId=" });
      await cancelScheduledReply(id, replyId);
      return res.status(200).json({ cancelled: true });
    }

    const tagged = await listConversationsWithAnyTag(100);
    const followups = [];
    for (const convo of tagged.slice(0, 30)) {
      const id = convo._id || convo.id;
      try {
        const scheduled = (await listScheduledReplies(id)).data || [];
        const lead = convo.lead || {};
        for (const r of scheduled) {
          followups.push({
            conversationId: id,
            replyId: r._id || r.id,
            lead: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email || convo.leadEmail || "",
            email: lead.email || convo.leadEmail || "",
            scheduledFor: r.scheduledFor || r.scheduled_for || "",
            preview: String(r.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160),
          });
        }
      } catch { /* conversation without scheduled endpoint access: skip */ }
    }

    followups.sort((a, b) => String(a.scheduledFor).localeCompare(String(b.scheduledFor)));
    return res.status(200).json({ pending: followups.length, followups });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
