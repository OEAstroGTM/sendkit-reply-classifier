// GET /api/followups?key=...              -> conversations where WE spoke last (awaiting lead reply),
//                                             each with any pending scheduled bumps
// GET /api/followups?key=...&cancel=1&id=..&replyId=..   -> cancel one bump
// GET /api/followups?key=...&schedule=1&id=..            -> schedule bumps for one conversation

import { listConversationsWithAnyTag, extractTags, CATEGORY_SET, isInbound, senderPersona } from "../lib/inbox.js";
import { getConversation, listScheduledReplies, cancelScheduledReply } from "../lib/sendkit.js";
import { scheduleFollowups } from "../lib/followup.js";

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

    if (req.query.schedule === "1") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "Need &id=" });
      const detail = (await getConversation(id)).data || {};
      const lead = detail.lead || {};
      const r = await scheduleFollowups(id, {
        leadName: lead.firstName || "",
        persona: senderPersona(detail.messages),
      });
      return res.status(200).json(r);
    }

    const tagged = await listConversationsWithAnyTag(100);

    // The list payload carries lastMessage.isFromLead, so we can filter to
    // "we spoke last" without fetching every conversation in full.
    const awaiting = tagged.filter((c) => {
      const lm = c.lastMessage;
      if (!lm) return false;
      return lm.isFromLead === false;
    });

    const rows = await Promise.all(
      awaiting.slice(0, 25).map(async (convo) => {
        const id = convo._id || convo.id;
        const lead = convo.lead || {};
        const lm = convo.lastMessage || {};
        const sentAt = lm.sentAt || lm.receivedAt || convo.updatedAt || "";
        let scheduled = [];
        try {
          scheduled = ((await listScheduledReplies(id)).data || []).map((r) => ({
            replyId: r._id || r.id,
            scheduledFor: r.scheduledFor || r.scheduled_for || "",
            preview: clean(r.body).slice(0, 140),
          }));
        } catch { /* ignore */ }
        return {
          conversationId: id,
          lead: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email || "",
          email: lead.email || "",
          tags: extractTags(convo).filter((t) => CATEGORY_SET.has(t)),
          lastSentAt: sentAt,
          daysWaiting: sentAt ? Math.floor((Date.now() - new Date(sentAt).getTime()) / 86400000) : null,
          ourLastMessage: clean(lm.content || lm.body).slice(0, 160),
          scheduled,
        };
      })
    );

    rows.sort((a, b) => (b.daysWaiting ?? -1) - (a.daysWaiting ?? -1));
    return res.status(200).json({
      awaitingReply: rows.length,
      pendingBumps: rows.reduce((n, r) => n + r.scheduled.length, 0),
      conversations: rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function clean(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
