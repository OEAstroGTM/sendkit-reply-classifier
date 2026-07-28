// AI reply generation: writes a short, personalized response that proposes
// meeting times, in the style of a human SDR follow-up.

import { getAvailableSlots, pickSlots } from "./nylas.js";
import { bookUrl } from "./booking.js";

// Which categories get an AI reply, and which of those are sent automatically
// (the rest are saved as drafts for human review).
export function replyConfig() {
  const parse = (v, fallback) =>
    (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback);
  return {
    replyCategories: parse(process.env.REPLY_CATEGORIES, [
      "Interested", "Meeting Request", "More Info Needed", "Pricing Question",
    ]),
    autosendCategories: parse(process.env.AUTOSEND_CATEGORIES, ["Meeting Request"]),
  };
}

const REPLY_SYSTEM = `You write replies to positive responses on cold outreach emails, on behalf of the sender. Your goal is to book a meeting.

Rules of engagement (voice):
- Write like a normal person typing a quick work email. Brief, warm, conversational.
- Use everyday English. Short words, short sentences. If a 5th grader wouldn't say it, don't write it.
- Banned words and phrases: leverage, streamline, robust, seamless, delve, utilize, facilitate, synergy, elevate, empower, unlock, supercharge, cutting-edge, best-in-class, touch base, circle back, "I hope this email finds you well", "I trust this finds you", "per my last email".
- Never use em dashes (—) or semicolons. Use commas or start a new sentence.
- No emojis, no exclamation marks, no corporate fluff.
- Keep the whole email under 90 words, not counting the time list.

Structure:
- Greet the lead by first name if provided ("Hey Greg,").
- Acknowledge what they said in one natural sentence, lightly mirroring their words.
- If a company overview URL is provided, work it into a sentence as a markdown link with natural anchor text, like: here's a [quick overview of what we do](URL).
- Offer the meeting times EXACTLY as provided, one per line, each prefixed with "• ". Do not invent, reword, or reorder times.
- Close with one short line like "Looking forward to connecting soon." and sign with the sender's first name if provided.

Category behavior:
- Interested: thank them, one brief value line, propose the times.
- Meeting Request: skip the pitch, confirm you'd love to talk, propose the times immediately.
- More Info Needed: answer briefly ONLY using the product notes provided (never invent facts), say a quick call is the fastest way to cover details, propose times.
- Pricing Question: NEVER state prices or make up numbers unless pricing is explicitly in the product notes. Say pricing depends on their setup and you can walk through it on a quick call, propose times.
- Never invent product claims, customer names, statistics, or prices.

Output ONLY the email body as plain text with markdown links. No subject line, no quotes around it.`;

// Hard guarantee regardless of what the model does: strip em/en dashes.
export function scrubDashes(text) {
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/, ,/g, ",");
}

// Deterministic plain-text+markdown -> email HTML conversion.
// Controls spacing: single <br> inside a paragraph/list, double between paragraphs.
export function toHtml(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const linked = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2">$1</a>'
  );
  return linked
    .split(/\n{2,}/)                       // paragraphs
    .map((p) => p.trim().replace(/\n/g, "<br>"))
    .filter(Boolean)
    .join("<br><br>");
}

export async function generateReply({ category, replyText, leadName, subject, leadEmail, baseUrl, senderName }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");

  // 1. Real availability from Nylas
  const slots = await getAvailableSlots();
  const picked = pickSlots(slots, 3);
  const slotLines = picked.map((s) => s.label);
  if (slotLines.length === 0) throw new Error("No available time slots found in calendar");

  // 2. Build context
  const signAs = senderName || process.env.SENDER_NAME || "";
  const ctx = [
    `Category: ${category}`,
    leadName ? `Lead first name: ${leadName.split(" ")[0]}` : "Lead first name: unknown",
    signAs
      ? `Sender name: ${signAs}. Sign the email with exactly this name. NEVER sign with the lead's name.`
      : "Sender name unknown: end the email after the closing line with no name signature. NEVER sign with the lead's name.",
    process.env.COMPANY_URL ? `Company overview URL: ${process.env.COMPANY_URL}` : null,
    process.env.PRODUCT_NOTES ? `Product notes (the ONLY facts you may use):\n${process.env.PRODUCT_NOTES}` : "Product notes: none provided — do not state any product specifics.",
    `Meeting times to offer (use verbatim):\n${slotLines.join("\n")}`,
    subject ? `Original subject: ${subject}` : null,
    `The lead's reply:\n"""\n${(replyText || "").slice(0, 4000)}\n"""`,
  ].filter(Boolean).join("\n\n");

  // 3. Generate
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_REPLY_MODEL || process.env.CLAUDE_MODEL || "claude-haiku-4-5",
      max_tokens: 500,
      system: REPLY_SYSTEM,
      messages: [{ role: "user", content: ctx }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  const body = scrubDashes((data.content?.[0]?.text || "").trim());
  if (!body) throw new Error("Empty reply from model");

  // Make each proposed time a clickable one-click booking link
  let html = toHtml(body);
  if (leadEmail && baseUrl) {
    const durationMin = Number(process.env.MEETING_MINUTES || 30);
    for (const s of picked) {
      const url = bookUrl(baseUrl, {
        email: leadEmail,
        name: leadName || "",
        startTime: s.start_time,
        durationMin,
      });
      html = html.split(s.label).join(
        `<a href="${url}" style="color:#1a56db">${s.label}</a>`
      );
    }
  }

  return { body, html, slotLines };
}
