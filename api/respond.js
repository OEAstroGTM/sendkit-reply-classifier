// GET /api/respond?key=YOUR_SETUP_SECRET&id=CONVERSATION_ID&mode=preview|draft|send
// Generates the AI reply (with calendar times) for one conversation, using the
// tag SendKit already applied as the category.
//   mode=preview (default) — returns the reply, touches nothing
//   mode=draft            — saves it as a draft on the conversation
//   mode=send             — sends it immediately

import { generateReply, renderReplyHtml } from "../lib/reply.js";
import { getConversation, sendReply, saveDraft, addToDnc } from "../lib/sendkit.js";
import { CATEGORY_SET, extractTags, latestInbound, messageText, isOptOut, senderPersona } from "../lib/inbox.js";
import { scheduleFollowups } from "../lib/followup.js";
import { drafts as sendkitDrafts } from "../lib/approved-drafts.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const isPost = req.method === "POST";
  let p = isPost ? { ...req.query, ...(req.body || {}) } : { ...req.query };

  // ?draft=<id> pulls an approved reply from drafts/sendkit-batch.json,
  // so exact wording can be sent without stuffing it into a URL.
  if (p.draft) {
    const d = (sendkitDrafts || []).find((x) => x.id === p.draft);
    if (!d) return res.status(404).json({ error: `No draft "${p.draft}"` });
    p = { ...p, id: d.conversationId, body: d.body, slots: [] };
  }
  const id = p.id;
  const mode = p.mode || "preview";
  if (!id) return res.status(400).json({ error: "Add &id=CONVERSATION_ID" });
  if (!["preview", "draft", "send"].includes(mode)) {
    return res.status(400).json({ error: "mode must be preview, draft, or send" });
  }

  // POST with a `body` = send/draft this exact text (possibly human-edited),
  // skipping regeneration. Slot labels in the text become booking links again.
  if (p.body && mode !== "preview") {
    try {
      const detail = (await getConversation(id)).data || {};
      const lead = detail.lead || {};
      const html = renderReplyHtml(p.body, {
        slots: Array.isArray(p.slots) ? p.slots : [],
        leadEmail: lead.email || "",
        leadName: lead.firstName || "",
        baseUrl: `https://${req.headers.host}`,
      });
      let followups = 0;
      if (mode === "draft") await saveDraft(id, html);
      else {
        await sendReply(id, html);
        const f = await scheduleFollowups(id, { leadName: lead.firstName || "", persona: senderPersona(detail.messages) });
        followups = f.scheduled;
      }
      return res.status(200).json({
        conversationId: id,
        lead: lead.email || "",
        action: mode === "draft" ? "draft saved on conversation" : "reply sent",
        edited: true,
        followupsScheduled: followups,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
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

    const { body, html, slotLines, slots } = await generateReply({
      category,
      replyText,
      leadName: lead.firstName || "",
      subject: inbound.subject || "",
      leadEmail: lead.email || "",
      baseUrl: `https://${req.headers.host}`,
      senderName: senderPersona(detail.messages),
      conversationId: id,
    });

    let action = "preview only, nothing saved or sent";
    let followups = 0;
    if (mode === "draft") { await saveDraft(id, html); action = "draft saved on conversation"; }
    if (mode === "send") {
      await sendReply(id, html);
      action = "reply sent";
      const f = await scheduleFollowups(id, { leadName: lead.firstName || "", persona: senderPersona(detail.messages) });
      followups = f.scheduled;
    }

    // ?format=html renders the email exactly as the lead will see it
    if (req.query.format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(
        `<body style="margin:0;background:#f0f2f5;padding:24px">
          <div style="max-width:620px;margin:0 auto;font-family:Arial,sans-serif">
            <div style="background:#fff;border-radius:8px;padding:8px 16px;margin-bottom:12px;color:#444;font-size:13px">
              To: <b>${lead.email || ""}</b> · ${category} · ${action}
            </div>
            <div style="background:#fff;border-radius:8px;padding:28px;font-size:15px;line-height:1.6;color:#111">${html}</div>
          </div>
        </body>`
      );
    }

    return res.status(200).json({
      conversationId: id,
      lead: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email || "",
      company: lead.companyName || "",
      category,
      action,
      leadSaid: replyText.slice(0, 300),
      proposedTimes: slotLines,
      replyBody: body,
      replyHtml: html,
      slots,
      followupsScheduled: followups,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
