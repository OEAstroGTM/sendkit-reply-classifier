// GET /api/queue?key=YOUR_SETUP_SECRET
// The "needs response" queue: conversations whose SendKit tag (tags array or
// aiTag) matches one of the 6 categories AND whose latest message is from the
// lead (no one has replied yet). Auto-replies (OOO etc.) don't count.

import { CATEGORY_SET, extractTags, listConversationsWithAnyTag, latestInbound, messageText, isInbound, isOptOut, reviewFlags } from "../lib/inbox.js";
import { getConversation } from "../lib/sendkit.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    // OR across all 6 tags via SendKit's tag filter (whole workspace)
    const tagged = await listConversationsWithAnyTag(100);

    // Fetched in parallel. Serially this walked 25 conversations one at a
    // time and blew past the function timeout, so the panel never rendered.
    const max = Math.min(Number(req.query.max || 12), 25);
    const inspected = await Promise.all(tagged.slice(0, max).map(async (convo) => {
      const id = convo._id || convo.id;
      try {
        const detail = (await getConversation(id)).data || {};
        const messages = detail.messages || [];
        const last = messages[messages.length - 1];
        if (!isInbound(last)) return null;        // we already answered
        const inbound = latestInbound(messages);  // skips auto-replies
        if (!inbound) return null;

        const lead = detail.lead || {};
        return {
          id,
          optOut: isOptOut(inbound.subject, messageText(inbound)),
          flags: reviewFlags(messageText(inbound)),
          lead: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email || "",
          email: lead.email || "",
          company: lead.companyName || "",
          subject: inbound.subject || messages[0]?.subject || "",
          tags: extractTags({ ...convo, ...detail }).filter((t) => CATEGORY_SET.has(t)),
          lastMessagePreview: messageText(inbound).slice(0, 300),
          lastMessageAt: inbound.receivedAt || "",
          hoursWaiting: inbound.receivedAt
            ? Math.round((Date.now() - new Date(inbound.receivedAt).getTime()) / 3600000) : null,
        };
      } catch (e) {
        console.warn(`queue: could not inspect ${id}: ${e.message}`);
        return null;
      }
    }));
    const queue = inspected.filter(Boolean)
      .sort((a, b) => (b.hoursWaiting ?? 0) - (a.hoursWaiting ?? 0));

    return res.status(200).json({ source: "sendkit", tagged: tagged.length, inspected: Math.min(tagged.length, max), awaitingResponse: queue.length, queue });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
