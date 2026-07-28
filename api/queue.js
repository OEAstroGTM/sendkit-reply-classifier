// GET /api/queue?key=YOUR_SETUP_SECRET
// The "needs response" queue: conversations whose SendKit tag (tags array or
// aiTag) matches one of the 6 categories AND whose latest message is from the
// lead (no one has replied yet). Auto-replies (OOO etc.) don't count.

import { CATEGORY_SET, extractTags, listConversationsWithAnyTag, latestInbound, messageText, isInbound, isOptOut } from "../lib/inbox.js";
import { getConversation } from "../lib/sendkit.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    // OR across all 6 tags via SendKit's tag filter (whole workspace)
    const tagged = await listConversationsWithAnyTag(100);

    const queue = [];
    for (const convo of tagged.slice(0, 25)) {
      const id = convo._id || convo.id;
      try {
        const detail = (await getConversation(id)).data || {};
        const messages = detail.messages || [];
        const last = messages[messages.length - 1];
        if (!isInbound(last)) continue;        // we already answered
        const inbound = latestInbound(messages); // skips auto-replies
        if (!inbound) continue;

        const lead = detail.lead || {};
        queue.push({
          id,
          optOut: isOptOut(inbound.subject, messageText(inbound)),
          lead: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email || "",
          email: lead.email || "",
          company: lead.companyName || "",
          subject: inbound.subject || messages[0]?.subject || "",
          tags: extractTags({ ...convo, ...detail }).filter((t) => CATEGORY_SET.has(t)),
          lastMessagePreview: messageText(inbound).slice(0, 300),
          lastMessageAt: inbound.receivedAt || "",
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
