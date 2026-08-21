import { scrubDashes, toHtml } from "../lib/reply.js";

export const config = { maxDuration: 60 };

const SYSTEM = `You draft replies to people who answered a cold email.

Use ONLY the facts provided in the request. The latest inbound message is authoritative. The recent conversation is context only.

Rules:
- Answer what the lead actually said or asked first.
- No warm-up, no thanking them for replying, no mirroring their message back to them.
- Keep it short, normally 40-80 words.
- No em dashes, semicolons, emojis, exclamation marks, corporate filler, or invented claims.
- Do not invent pricing, customers, results, product facts, calendar times, or links.
- If classification is decline or optout, do not pitch, do not offer a meeting, and do not include availability.
- If classification is positive and real availability is provided, offer at most three of those exact slots. Preserve each slot label and URL exactly.
- If availability is empty, do not invent times.
- Output only the plain-text email body. No subject line and no commentary about the draft.`;

function cleanMessage(m) {
  if (!m || typeof m !== "object") return null;
  const role = String(m.type || m.direction || "").toUpperCase() === "REPLY" || m.direction === "inbound"
    ? "lead"
    : "us";
  const text = String(m.text || m.body || "").trim();
  if (!text) return null;
  return `${role}: ${text.slice(0, 1400)}`;
}

function cleanAvailability(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x) => x && x.label && x.url)
    .slice(0, 3)
    .map((x) => ({ label: String(x.label), url: String(x.url) }));
}

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST required" });
  }

  const p = req.body && typeof req.body === "object" ? req.body : {};
  const latest = String(p.latest_inbound || "").trim();
  if (!latest) return res.status(400).json({ error: "latest_inbound required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY env var is not set" });

  const classification = String(p.classification || "unknown").toLowerCase();
  const lead = p.lead && typeof p.lead === "object" ? p.lead : {};
  const availability = cleanAvailability(p.availability);
  const conversation = Array.isArray(p.conversation)
    ? p.conversation.map(cleanMessage).filter(Boolean).slice(-12)
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
        system: SYSTEM,
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
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err).slice(0, 500) });
  }
}
