// GET /api/respond?key=YOUR_SETUP_SECRET&id=CONVERSATION_ID&mode=preview|draft|send
// Generates the AI reply (with calendar times) for one specific conversation.
//   mode=preview (default) — returns the reply, touches nothing
//   mode=draft            — saves it as a draft on the conversation
//   mode=send             — sends it immediately

import { generateReply } from "../lib/reply.js";
import { getConversation, sendReply, saveDraft } from "../lib/sendkit.js";
import { CATEGORY_SET, extractTags } from "../lib/inbox.js";

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
    const messages = detail.messages || [];
    const inbound = [...messages].reverse().find(
      (m) => m.direction === "inbound" || m.type === "received"
    );
    if (!inbound) return res.status(400).json({ error: "No inbound message found on this conversation" });

    const replyText = stripHtml(inbound.body || inbound.text || inbound.html || "");
    const leadName = detail.leadName || detail.lead?.name || "";
    const tags = extractTags(detail).filter((t) => CATEGORY_SET.has(t));
    const category = req.query.category || tags[0] || "Interested";

    const { body, html, slotLines } = await generateReply({
      category,
      replyText,
      leadName,
      subject: detail.subject || "",
    });

    let action = "preview only, nothing saved or sent";
    if (mode === "draft") { await saveDraft(id, html); action = "draft saved on conversation"; }
    if (mode === "send") { await sendReply(id, html); action = "reply sent"; }

    return res.status(200).json({
      conversationId: id,
      lead: leadName || detail.leadEmail || "",
      category,
      action,
      proposedTimes: slotLines,
      replyBody: body,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function stripHtml(s) {
  return String(s).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
