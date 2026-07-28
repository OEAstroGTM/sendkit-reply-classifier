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
  // SendKit exposes both a `tags` array and a single `aiTag` string — merge them.
  const arr = [
    ...(Array.isArray(convo.tags) ? convo.tags : convo.tags ? [convo.tags] : []),
    convo.aiTag,
  ];
  return arr
    .map((t) => (typeof t === "string" ? t : t?.name || t?.tag || ""))
    .filter(Boolean);
}

// Latest message from the lead. SendKit messages: type "sent" (ours) or
// "reply" (theirs), with text in `content` / `htmlContent`.
export function latestInbound(messages, { skipAutoReplies = true } = {}) {
  return [...(messages || [])].reverse().find(
    (m) =>
      (m.type === "reply" || m.isFromLead || m.direction === "inbound") &&
      (!skipAutoReplies || !m.isAutoReply)
  );
}

export function messageText(m) {
  if (!m) return "";
  return stripHtml(m.content || m.htmlContent || m.body || m.text || m.html || "");
}

export function isInbound(m) {
  return !!m && (m.type === "reply" || m.isFromLead || m.direction === "inbound");
}

export function stripHtml(s) {
  return String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
