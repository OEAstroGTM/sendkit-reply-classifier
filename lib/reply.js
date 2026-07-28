// AI reply generation: writes a short, personalized response that proposes
// meeting times, in the style of a human SDR follow-up.

import { getAvailableSlots, pickAndFormatSlots } from "./nylas.js";

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

Style rules:
- Short, warm, human. 4-8 short lines. No corporate fluff, no emojis, no exclamation overload.
- Greet the lead by first name if provided ("Hey Greg,").
- Acknowledge what they said in one natural sentence (mirror their words lightly).
- If a company overview URL is provided, include it on its own line as a plain URL.
- Then offer the meeting times EXACTLY as provided, one per line, each prefixed with "• ". Do not invent, reword, or reorder times.
- Close with one short line like "Looking forward to connecting soon." and sign with the sender's first name if provided.
- Category-specific behavior:
  * Interested: thank them, brief value line, propose the times.
  * Meeting Request: skip the pitch, confirm enthusiasm, propose the times immediately.
  * More Info Needed: answer briefly ONLY using the product notes provided (never invent facts); say a quick call is the fastest way to cover details, propose times.
  * Pricing Question: NEVER state prices or make up numbers unless pricing info is explicitly in the product notes. Say pricing depends on their setup and you can walk through it on a quick call, propose times.
- Never invent product claims, customer names, statistics, or prices.
- Output ONLY the email body as plain text. No subject line, no quotes around it, no markdown.`;

export async function generateReply({ category, replyText, leadName, subject }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");

  // 1. Real availability from Nylas
  const slots = await getAvailableSlots();
  const slotLines = pickAndFormatSlots(slots, 3);
  if (slotLines.length === 0) throw new Error("No available time slots found in calendar");

  // 2. Build context
  const ctx = [
    `Category: ${category}`,
    leadName ? `Lead first name: ${leadName.split(" ")[0]}` : "Lead first name: unknown",
    process.env.SENDER_NAME ? `Sender name: ${process.env.SENDER_NAME}` : null,
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
  const body = (data.content?.[0]?.text || "").trim();
  if (!body) throw new Error("Empty reply from model");
  return { body, slotLines };
}
