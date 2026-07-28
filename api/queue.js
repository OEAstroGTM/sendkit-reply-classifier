// GET /api/queue?key=YOUR_SETUP_SECRET
// The "needs response" queue: conversations that carry one of the 6 tags
// AND whose most recent message is from the lead (nobody replied yet).

import { CATEGORY_SET, extractTags, listConversations } from "../lib/inbox.js";
import { getConversation } from "../lib/sendkit.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const list = await listConversations(50);
    const tagged = list.filter((c) => extractTags(c).some((t) => CATEGORY_SET.has(t)));

    const queue = [];
    for (const convo of tagged.slice(0, 20)) {
      const id = convo._id || convo.id;
      try {
        const detail = (await getConversation(id)).data || {};
        const messages = detail.messages || [];
        if (!messages.length) continue;
        const last = messages[messages.length - 1];
        const lastIsInbound = last.direction === "inbound" || last.type === "received";
        if (!lastIsInbound) continue; // we already answered

        queue.push({
          id,
          lead: convo.leadName || detail.leadName || convo.leadEmail || detail.leadEmail || "",
          email: convo.leadEmail || detail.leadEmail || "",
          subject: convo.subject || detail.subject || "",
          tags: extractTags(convo).filter((t) => CATEGORY_SET.has(t)),
          lastMessagePreview: stripHtml(last.body || last.text || last.html || "").slice(0, 300),
          lastMessageAt: last.createdAt || last.date || convo.updatedAt || "",
        });
      } catch (e) {
        console.warn(`queue: could not inspect ${id}: ${e.message}`);
      }
    }

    return res.status(200).json({ awaitingResponse: queue.length, queue });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function stripHtml(s) {
  return String(s).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
