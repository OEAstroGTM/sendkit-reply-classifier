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
    const rows = [];

    for (const convo of tagged.slice(0, 30)) {
      const id = convo._id || convo.id;
      try {
        const detail = (await getConversation(id)).data || {};
        const messages = detail.messages || [];
        const last = messages[messages.length - 1];
        if (!last || isInbound(last)) continue; // lead spoke last -> that's the review queue, not here

        const lead = detail.lead || {};
        const sentAt = last.sentAt || last.receivedAt || "";
        const daysWaiting = sentAt
          ? Math.floor((Date.now() - new Date(sentAt).getTime()) / 86400000)
          : null;

        let scheduled = [];
        try {
          scheduled = ((await listScheduledReplies(id)).data || []).map((r) => ({
            replyId: r._id || r.id,
            scheduledFor: r.scheduledFor || r.scheduled_for || "",
            preview: clean(r.body).slice(0, 140),
          }));
        } catch { /* ignore */ }

        rows.push({
          conversationId: id,
          lead: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email || "",
          email: lead.email || "",
          tags: extractTags(detail).filter((t) => CATEGORY_SET.has(t)),
          lastSentAt: sentAt,
          daysWaiting,
          ourLastMessage: clean(last.content || last.body || last.htmlContent).slice(0, 160),
          scheduled,
        });
      } catch { /* skip unreadable conversation */ }
    }

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
