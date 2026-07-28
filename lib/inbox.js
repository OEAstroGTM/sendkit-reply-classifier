// Shared inbox helpers: listing conversations and reading tags defensively
// (the exact field name for tags can vary, so check the common ones).

import { CATEGORIES } from "./classify.js";

export const CATEGORY_SET = new Set(CATEGORIES);

export async function listConversations(limit = 25) {
  const r = await fetch(`https://api.sendkit.ai/v1/inbox?limit=${limit}`, {
    headers: { "X-Api-Key": process.env.SENDKIT_API_KEY },
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`SendKit inbox -> ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const list = json.data?.conversations || json.data || [];
  return Array.isArray(list) ? list : [];
}

export function extractTags(convo) {
  const raw =
    convo.tags ?? convo.aiTags ?? convo.labels ?? convo.tag ?? convo.aiTag ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((t) => (typeof t === "string" ? t : t?.name || t?.tag || ""))
    .filter(Boolean);
}
