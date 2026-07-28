// POST /api/webhook — receives SendKit "email.replied" events,
// classifies the reply with Claude, tags the conversation in SendKit,
// and optionally logs to a Google Sheet.

import crypto from "node:crypto";
import { classifyReply } from "../lib/classify.js";
import { generateReply, replyConfig } from "../lib/reply.js";
import { getConversation, tagConversations, sendReply, saveDraft } from "../lib/sendkit.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const payload = req.body || {};

  // --- Signature verification (HMAC-SHA256 of the JSON body) ---
  const secret = process.env.SENDKIT_WEBHOOK_SECRET;
  if (secret) {
    const provided =
      req.headers["x-sendkit-signature"] ||
      req.headers["x-webhook-signature"] ||
      req.headers["x-signature"] ||
      "";
    const ok = verifySignature(JSON.stringify(payload), String(provided), secret);
    if (!ok && process.env.STRICT_SIGNATURE === "true") {
      return res.status(401).json({ error: "Invalid signature" });
    }
    if (!ok) console.warn("Signature mismatch or missing — processing anyway (STRICT_SIGNATURE not enabled)");
  }

  // --- Only handle reply events (ignore test pings and other events gracefully) ---
  const event = payload.event || payload.type || payload.eventType || "";
  if (event && !/replied|reply/i.test(event)) {
    return res.status(200).json({ skipped: true, reason: `Ignoring event: ${event}` });
  }

  try {
    const d = payload.data || payload;
    const conversationId =
      d.conversationId || d.conversation_id || d.conversation?._id || d.conversation?.id || d._id || d.id;

    // Pull whatever reply content the payload carries
    let replyText = d.replyText || d.reply?.body || d.message?.body || d.body || d.text || "";
    let subject = d.subject || d.conversation?.subject || "";
    let leadEmail = d.leadEmail || d.lead?.email || d.from || "";
    let leadName = d.leadName || d.lead?.name || "";
    let campaignName = d.campaignName || d.campaign?.name || "";

    // If the payload didn't include the reply body, fetch the conversation
    if (conversationId && !replyText) {
      try {
        const conv = (await getConversation(conversationId)).data || {};
        subject = subject || conv.subject || "";
        leadEmail = leadEmail || conv.leadEmail || conv.lead?.email || "";
        leadName = leadName || conv.leadName || conv.lead?.name || "";
        const messages = conv.messages || [];
        // Last inbound (lead-sent) message
        const inbound = [...messages].reverse().find(
          (m) => m.direction === "inbound" || m.from === leadEmail || m.type === "received"
        ) || messages[messages.length - 1];
        replyText = inbound?.body || inbound?.text || inbound?.html || "";
      } catch (e) {
        console.warn(`Could not fetch conversation ${conversationId}: ${e.message}`);
      }
    }

    if (!replyText) {
      return res.status(200).json({ skipped: true, reason: "No reply text found in payload or conversation" });
    }

    // --- Classify ---
    const result = await classifyReply({
      replyText: stripHtml(replyText),
      subject,
      leadName,
      campaignName,
    });

    // --- Tag in SendKit ---
    let tagged = false;
    if (result.category !== "None" && conversationId) {
      try {
        await tagConversations([conversationId], result.category);
        tagged = true;
      } catch (e) {
        console.error(`Tagging failed: ${e.message}`);
      }
    }

    // --- AI reply with calendar times (Nylas) ---
    let replyAction = "none";
    const { replyCategories, autosendCategories } = replyConfig();
    if (
      process.env.NYLAS_API_KEY &&
      conversationId &&
      replyCategories.includes(result.category)
    ) {
      try {
        const { html } = await generateReply({
          category: result.category,
          replyText: stripHtml(replyText),
          leadName,
          subject,
        });
        if (autosendCategories.includes(result.category)) {
          await sendReply(conversationId, html);
          replyAction = "sent";
        } else {
          await saveDraft(conversationId, html);
          replyAction = "drafted";
        }
      } catch (e) {
        console.error(`Reply generation failed: ${e.message}`);
        replyAction = `error: ${e.message.slice(0, 120)}`;
      }
    }

    // --- Log to Google Sheet (optional) ---
    if (process.env.SHEETS_WEBHOOK_URL) {
      logToSheet({
        timestamp: new Date().toISOString(),
        leadEmail,
        leadName,
        campaignName,
        subject,
        category: result.category,
        confidence: result.confidence,
        reason: result.reason,
        replyAction,
        conversationId: conversationId || "",
        replyPreview: stripHtml(replyText).slice(0, 500),
      }).catch((e) => console.error(`Sheet logging failed: ${e.message}`));
    }

    return res.status(200).json({ ok: true, category: result.category, confidence: result.confidence, tagged, replyAction });
  } catch (err) {
    console.error(err);
    // Return 200 so SendKit doesn't endlessly retry unrecoverable payloads;
    // errors are visible in Vercel logs.
    return res.status(200).json({ ok: false, error: err.message });
  }
}

function verifySignature(rawBody, provided, secret) {
  if (!provided) return false;
  const sig = provided.replace(/^sha256=/, "").trim();
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function stripHtml(s) {
  return String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function logToSheet(row) {
  const res = await fetch(process.env.SHEETS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Sheet webhook returned ${res.status}`);
}
