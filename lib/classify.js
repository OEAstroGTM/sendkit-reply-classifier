// Reply classification using Claude Haiku via the Anthropic API (plain fetch, no SDK)

export const CATEGORIES = [
  "Interested",
  "Meeting Request",
  "More Info Needed",
  "Objection",
  "Pricing Question",
  "Timing Issue",
];

const SYSTEM_PROMPT = `You classify replies to cold outreach emails into exactly one category.

Categories and definitions:
- "Interested": Positive response showing interest in the offer, but no explicit meeting ask yet. ("This sounds interesting", "Tell me how this works, sounds good")
- "Meeting Request": Explicitly asks for or agrees to a call, meeting, or demo, or shares availability/booking intent. ("Can we hop on a call Tuesday?", "Send me your calendar link")
- "More Info Needed": Asks for more details, materials, case studies, or clarification before deciding. ("Can you send more info?", "Do you have case studies?")
- "Objection": Pushes back, declines, says not a fit, already has a solution, or raises a concern/skepticism. ("We already use X", "Not interested", "I don't think this applies to us")
- "Pricing Question": Asks about cost, pricing, plans, or budget. ("How much does this cost?", "What are your plans?")
- "Timing Issue": Interested or neutral but timing is wrong — busy now, revisit next quarter, follow up later. ("Circle back in Q3", "We're mid-migration, try me in a few months")

Rules:
- If the reply fits multiple categories, pick the dominant intent. A meeting ask beats everything; an explicit pricing question beats general interest.
- If the reply is an auto-responder, out-of-office, unsubscribe request, bounce notice, or is empty/unclassifiable, use "None".
- Respond with ONLY a JSON object, no markdown: {"category": "<one of the six or None>", "confidence": <0-1>, "reason": "<one short sentence>"}`;

export async function classifyReply({ replyText, subject, leadName, campaignName }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");

  const userContent = [
    subject ? `Email subject: ${subject}` : null,
    campaignName ? `Campaign: ${campaignName}` : null,
    leadName ? `Lead: ${leadName}` : null,
    `Reply:\n"""\n${(replyText || "").slice(0, 6000)}\n"""`,
  ].filter(Boolean).join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-haiku-4-5",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";
  return parseClassification(text);
}

export function parseClassification(text) {
  // Tolerate stray markdown fences or prose around the JSON
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { category: "None", confidence: 0, reason: "Unparseable model output" };
  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return { category: "None", confidence: 0, reason: "Invalid JSON from model" }; }

  const category = normalizeCategory(parsed.category);
  return {
    category,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    reason: String(parsed.reason || "").slice(0, 300),
  };
}

export function normalizeCategory(raw) {
  if (!raw) return "None";
  const c = String(raw).trim().toLowerCase();
  const hit = CATEGORIES.find((cat) => cat.toLowerCase() === c);
  return hit || "None";
}
