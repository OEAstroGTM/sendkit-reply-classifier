// GET /api/reply-test?key=YOUR_SETUP_SECRET&text=Sure, can we talk next week?&name=Greg
// Full dry run: classifies the text, pulls real availability from Nylas,
// and shows the reply the agent WOULD send/draft. Nothing is sent.

import { classifyReply } from "../lib/classify.js";
import { generateReply, replyConfig } from "../lib/reply.js";

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Add ?key=YOUR_SETUP_SECRET" });
  }
  const text = req.query.text;
  if (!text) return res.status(400).json({ error: "Add &text=some reply text (and optionally &name=Greg)" });

  try {
    const classification = await classifyReply({ replyText: text });
    const { replyCategories, autosendCategories } = replyConfig();

    if (!replyCategories.includes(classification.category)) {
      return res.status(200).json({
        classification,
        wouldReply: false,
        note: `Category "${classification.category}" is tag-only (no AI reply).`,
      });
    }

    const { body, slotLines } = await generateReply({
      category: classification.category,
      replyText: text,
      leadName: req.query.name || "",
    });

    return res.status(200).json({
      classification,
      wouldReply: true,
      action: autosendCategories.includes(classification.category) ? "would AUTO-SEND" : "would save as DRAFT",
      proposedTimes: slotLines,
      replyBody: body,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
