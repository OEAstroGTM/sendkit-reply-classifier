// GET /api/respond?key=YOUR_SETUP_SECRET&id=CONVERSATION_ID&mode=preview|draft|send
// Generates the AI reply (with calendar times) for one conversation, using the
// tag SendKit already applied as the category.
//   mode=preview (default) — returns the reply, touches nothing
//   mode=draft            — saves it as a draft on the conversation
//   mode=send             — sends it immediately

import { generateReply } from "../lib/reply.js";
import { getConversation, sendReply, saveDraft, addToDnc } from "../lib/sendkit.js";
import { CATEGORY_SET, extractTags, latestInbound, messageText, isOptOut } from "../lib/inbox.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const id = req.query.id;
  const mode = req.query.mode || "preview";
  if (!id) return res.status(400).json({ error: "Add &id=CONVERSATION_ID" });
  if (!["preview", "draft", "send"].includes(mode)) {
    return res.status(400).json({ error: "mode must be preview, draft, or send" });
  }

  try {
    const detail = (await getConversation(id)).data || {};
    const inbound = latestInbound(detail.messages);
    if (!inbound) return res.status(400).json({ error: "No lead reply found on this conversation (auto-replies are skipped)" });

    const replyText = messageText(inbound);
    const lead = detail.lead || {};

    // Opt-out guard: never reply, offer DNC instead (?dnc=1 to apply)
    if (isOptOut(inbound.subject, replyText)) {
      let action = "blocked: opt-out language detected, no reply generated";
      if (req.query.dnc === "1") {
        await addToDnc([id]);
        action = "blocked: opt-out detected, lead added to DNC";
      }
      return res.status(200).json({ conversationId: id, lead: lead.email || "", category: "Unsubscribe", action });
    }
    const tags = extractTags(detail).filter((t) => CATEGORY_SET.has(t));
    const category = req.query.category || tags[0];
    if (!category) {
      return res.status(400).json({ error: `Conversation has no matching tag. Tags found: ${extractTags(detail).join(", ") || "none"}` });
    }

    const { body, html, slotLines } = await generateReply({
      category,
      replyText,
      leadName: lead.firstName || "",
      subject: inbound.subject || "",
    });

    let action = "preview only, nothing saved or sent";
    if (mode === "draft") { await saveDraft(id, html); action = "draft saved on conversation"; }
    if (mode === "send") { await sendReply(id, html); action = "reply sent"; }

    return res.status(200).json({
      conversationId: id,
      lead: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email || "",
      company: lead.companyName || "",
      category,
      action,
      leadSaid: replyText.slice(0, 300),
      proposedTimes: slotLines,
      replyBody: body,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
