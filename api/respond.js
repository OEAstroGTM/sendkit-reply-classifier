// GET /api/respond?key=YOUR_SETUP_SECRET&id=CONVERSATION_ID&mode=preview|draft|send
// Legacy SendKit conversation mode remains for compatibility.
//
// POST /api/respond?key=YOUR_SETUP_SECRET with `latest_inbound` is the canonical
// Koldify draft contract. In that mode this function NEVER reads Smartlead or
// SendKit. Koldify supplies the real conversation, classification and Calendly
// availability; Vercel only asks Claude for draft text and returns it.

import { generateReply, renderReplyHtml, scrubDashes, toHtml } from "../lib/reply.js";
import { getConversation, sendReply, saveDraft, addToDnc } from "../lib/sendkit.js";
import { CATEGORY_SET, extractTags, latestInbound, messageText, isOptOut, senderPersona } from "../lib/inbox.js";
import { scheduleFollowups } from "../lib/followup.js";
import { drafts as sendkitDrafts } from "../lib/approved-drafts.js";

export const config = { maxDuration: 60 };

const CANONICAL_SYSTEM = `You draft replies to people who answered a cold email.

Use ONLY the facts supplied in the request. The latest inbound message is authoritative. Recent conversation is context only.

Rules:
- Answer what the lead actually said or asked first.
- No warm-up, no thanking them for replying, no mirroring their message back to them.
- Keep it short, normally 40-80 words.
- No em dashes, semicolons, emojis, exclamation marks, corporate filler, or invented claims.
- Never invent pricing, customers, results, product facts, calendar times, or links.
- If classification is decline or optout, do not pitch, do not offer a meeting, and do not include availability.
- If classification is positive and real availability is provided, offer at most three of those exact slots. Preserve each slot label and URL exactly.
- If availability is empty, do not invent times.
- Output only the plain-text email body. No subject line and no commentary about the draft.`;

function cleanCanonicalMessage(m) {
  if (!m || typeof m !== "object") return null;
  const role = String(m.type || m.direction || "").toUpperCase() === "REPLY" || m.direction === "inbound"
    ? "lead"
    : "us";
  const text = String(m.text || m.body || "").trim();
  if (!text) return null;
  return `${role}: ${text.slice(0, 1400)}`;
}

function cleanCanonicalAvailability(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x) => x && x.label && x.url)
    .slice(0, 3)
    .map((x) => ({ label: String(x.label), url: String(x.url) }));
}

async function canonicalDraft(p, res) {
  const latest = String(p.latest_inbound || "").trim();
  if (!latest) return res.status(400).json({ error: "latest_inbound required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY env var is not set" });

  const classification = String(p.classification || "unknown").toLowerCase();
  const lead = p.lead && typeof p.lead === "object" ? p.lead : {};
  const availability = cleanCanonicalAvailability(p.availability);
  const conversation = Array.isArray(p.conversation)
    ? p.conversation.map(cleanCanonicalMessage).filter(Boolean).slice(-12)
    : [];

  const context = [
    `Classification: ${classification}`,
    p.category ? `Provider category (metadata only): ${String(p.category)}` : null,
    lead.first_name ? `Lead first name: ${String(lead.first_name)}` : null,
    lead.company ? `Company: ${String(lead.company)}` : null,
    p.subject ? `Subject: ${String(p.subject)}` : null,
    conversation.length ? `Recent conversation:\n${conversation.join("\n\n")}` : null,
    `Latest inbound message:\n"""\n${latest.slice(0, 4000)}\n"""`,
    classification === "positive" && availability.length
      ? `Real Calendly availability. Use only these exact options if offering times:\n${availability.map((s) => `- [${s.label}](${s.url})`).join("\n")}`
      : classification === "positive"
        ? "No Calendly availability was supplied. Do not invent times or links."
        : "Do not offer meeting times or a booking link for this classification.",
  ].filter(Boolean).join("\n\n");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_REPLY_MODEL || process.env.CLAUDE_MODEL || "claude-haiku-4-5",
        max_tokens: 500,
        system: CANONICAL_SYSTEM,
        messages: [{ role: "user", content: context }],
      }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 400);
      return res.status(502).json({ error: `Anthropic API ${r.status}: ${detail}` });
    }
    const data = await r.json();
    const body = scrubDashes(String(data.content?.[0]?.text || "").trim());
    if (!body) return res.status(502).json({ error: "Claude returned an empty draft" });
    return res.status(200).json({
      body,
      html: toHtml(body),
      slots: availability,
      source: "canonical-context",
      classification,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 500) });
  }
}

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const isPost = req.method === "POST";
  let p = isPost ? { ...req.query, ...(req.body || {}) } : { ...req.query };

  // Canonical Koldify mode. This branch must stay above every SendKit lookup.
  if (isPost && p.latest_inbound) {
    return canonicalDraft(p, res);
  }

  // ?draft=<id> pulls an approved reply from drafts/sendkit-batch.json,
  // so exact wording can be sent without stuffing it into a URL.
  const draftId = p.draft || p.use;
  if (draftId) {
    const d = (sendkitDrafts || []).find((x) => x.id === draftId);
    if (!d) return res.status(404).json({ error: `No draft "${draftId}"` });
    p = { ...p, id: d.conversationId, body: d.body, slots: d.slots || [] };
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
