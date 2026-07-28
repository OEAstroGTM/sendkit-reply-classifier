// GET /api/backfill?key=YOUR_SETUP_SECRET&limit=10
// Classifies and tags existing untagged conversations (the backlog from
// before the agent went live). TAGS ONLY — never sends or drafts replies.

import { classifyReply } from "../lib/classify.js";
import { getConversation, tagConversations } from "../lib/sendkit.js";
import { CATEGORY_SET, extractTags, listConversations, latestInbound, messageText } from "../lib/inbox.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const limit = Math.min(Number(req.query.limit || 10), 20);

  try {
    const all = await listConversations(50);
    const untagged = all.filter((c) => !extractTags(c).some((t) => CATEGORY_SET.has(t)));
    const batch = untagged.slice(0, limit);
    const results = [];

    for (const convo of batch) {
      const id = convo._id || convo.id;
      try {
        const detail = (await getConversation(id)).data || {};
        const inbound = latestInbound(detail.messages);
        const text = messageText(inbound);
        if (!text) { results.push({ id, subject: convo.subject, category: "skipped (no lead reply)" }); continue; }

        const r = await classifyReply({ replyText: text, subject: convo.subject || "" });
        if (r.category !== "None") await tagConversations([id], r.category);
        results.push({ id, subject: convo.subject || "", category: r.category, confidence: r.confidence });
      } catch (e) {
        results.push({ id, subject: convo.subject || "", category: `error: ${e.message.slice(0, 100)}` });
      }
    }

    return res.status(200).json({
      scanned: batch.length,
      remainingUntagged: Math.max(untagged.length - batch.length, 0),
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function stripHtml(s) {
  return String(s).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
