// AI reply generation: writes a short, personalized response that proposes
// meeting times, in the style of a human SDR follow-up.

import { safeBookingLink } from "./calendly.js";
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

const REPLY_SYSTEM = `You are replying to someone who answered a cold email. Write what a busy, straight-talking person would actually type.

ANSWER THEIR QUESTION FIRST. First line after their name. No warm-up, no throat-clearing, no restating what they said back to them.

Length: under 60 words. Most good replies are three or four short lines.

Never write any of these:
- A sign-off line. No "Looking forward to it", "Talk soon", "Best", "Hope to hear from you". End on the last useful sentence and stop.
- An opener that thanks or mirrors. No "Thanks for getting back to me", "Great to hear from you", "Glad this resonated", "I appreciate you taking the time".
- Corporate words: leverage, streamline, robust, seamless, delve, utilize, facilitate, synergy, elevate, empower, unlock, supercharge, cutting-edge, best-in-class, touch base, circle back, reach out.
- Em dashes, semicolons, emojis, exclamation marks.
- A pitch they did not ask for.

Say true things:
- If you do not know, say so. "I do not know yet" beats a confident guess and people can tell the difference.
- Never invent prices, customer names, statistics, timelines or product claims. Only use the product notes.
- If they asked what it costs: flat monthly retainer, not per lead, not per meeting, no percentage. Never quote a number unless it is in the product notes.
- If they asked for something you cannot send, say that plainly and offer the alternative.

Shape:
Name,

[the answer, straight away]

[one line of substance if it genuinely helps, otherwise skip it]

[the booking line, if a link was provided]

Sign with the sender's first name only if one was given. Otherwise end with no name. Never sign with the lead's name.

Write in English whatever language they used. Output only the email body, plain text with markdown links, no subject line.`;

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

const BUMP_SYSTEM = `You are nudging someone who replied to a cold email, got an answer from us, and then went quiet.

Two lines. Three at the very most. Under 35 words.

A nudge that argues its case reads worse than one that gets out of the way. You are reminding them this exists, not selling again.

Never write:
- A sign-off line of any kind.
- "Just following up", "circling back", "touching base", "bumping this to the top of your inbox", "I wanted to check in".
- Anything guilt-tripping about them not replying.
- Em dashes, semicolons, emojis, exclamation marks.
- A new pitch, or any product claim.

If this is the final nudge, say so plainly and give them an easy out: if the timing is wrong they can just say so.

Sign with the sender's first name if given, otherwise no name. Output only the body.`;

// A short nudge for someone who went quiet after we replied.
export async function generateBump({ leadName, senderName, said, bumpNumber = 1, isFinal = false, leadEmail, baseUrl, leadTimezone }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");

  const link = await safeBookingLink({ name: leadName || "", email: leadEmail || "" });

  const ctx = [
    leadName ? `Lead first name: ${leadName.split(" ")[0]}` : "Lead first name: unknown",
    senderName ? `Sender name: ${senderName}. Sign with exactly this name.` : "No sender name: end without a signature.",
    `This is nudge number ${bumpNumber}${isFinal ? " and the last one" : ""}.`,
    said ? `What they originally said:\n"""\n${said.slice(0, 600)}\n"""` : null,
    link ? `Booking link (verbatim, on its own line): ${link}` : "No booking link. Do not invent times.",
  ].filter(Boolean).join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.CLAUDE_REPLY_MODEL || process.env.CLAUDE_MODEL || "claude-haiku-4-5",
      max_tokens: 300, system: BUMP_SYSTEM, messages: [{ role: "user", content: ctx }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const body = scrubDashes((data.content?.[0]?.text || "").trim());
  if (!body) throw new Error("Empty bump from model");
  const html = renderReplyHtml(body, { slots: [], leadEmail, leadName, baseUrl });
  return { body, html, slots: [] };
}

export async function generateReply({ category, replyText, leadName, subject, leadEmail, baseUrl, senderName, conversationId, leadTimezone }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");

  // Booking is a Calendly single-use link, not calendar times.
  //
  // Nylas offered slots across a fixed participant list that still contained
  // someone who has left, and rendering them produced links into /api/book,
  // which silently created 58 phantom events. A link also fixes timezones for
  // free: most of this list is India and south-east Asia, and guessing times
  // across a ten-hour offset never worked.
  const link = await safeBookingLink({ name: leadName || "", email: leadEmail || "" });

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
    link
      ? `Booking link (use verbatim, once, on its own line at the end): ${link}\nPhrase it plainly, e.g. "Grab a time here:" or "Easiest is to pick a slot:".`
      : "No booking link available. Do not invent times or links. Ask them what suits instead.",
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

  // slots is empty by design: booking is a Calendly link inside the body, and
  // passing slots here is what renders links into /api/book. `picked` and
  // `slotLines` were the Nylas variables and were removed with it — these two
  // lines still referenced them, so every draft died on "picked is not defined".
  const html = renderReplyHtml(body, { slots: [], leadEmail, leadName, baseUrl, conversationId });
  return { body, html, slots: [] };
}

// Converts a (possibly human-edited) plain-text reply to email HTML,
// turning each slot label found in the text into a signed booking link.
export function renderReplyHtml(body, { slots = [], leadEmail, leadName, baseUrl, conversationId = "" } = {}) {
  let html = toHtml(scrubDashes(String(body)));
  if (leadEmail && baseUrl) {
    const durationMin = Number(process.env.MEETING_MINUTES || 30);
    for (const s of slots) {
      if (!s?.label) continue;
      const url = bookUrl(baseUrl, {
        email: leadEmail,
        name: leadName || "",
        startTime: s.start_time,
        durationMin,
        conversationId,
      });
      html = html.split(s.label).join(
        `<a href="${url}" style="color:#1a56db">${s.label}</a>`
      );
    }
  }
  return html;
}
