// GET /api/classify-test?key=YOUR_SETUP_SECRET&text=Sounds%20great%2C%20can%20we%20talk%20Tuesday%3F
// Quick sanity check of the classifier without needing a real SendKit reply.

import { classifyReply } from "../lib/classify.js";

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Add ?key=YOUR_SETUP_SECRET" });
  }
  const text = req.query.text;
  if (!text) return res.status(400).json({ error: "Add &text=some reply text" });

  try {
    const result = await classifyReply({ replyText: text });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
