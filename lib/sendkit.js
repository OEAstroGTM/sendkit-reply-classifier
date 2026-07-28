// SendKit API helpers (no dependencies — plain fetch)

const BASE = "https://api.sendkit.ai";

function headers() {
  const key = process.env.SENDKIT_API_KEY;
  if (!key) throw new Error("SENDKIT_API_KEY env var is not set");
  const h = { "X-Api-Key": key, "Content-Type": "application/json" };
  // Only needed for platform keys (sk_user_...)
  if (process.env.SENDKIT_WORKSPACE_ID) h["X-Workspace-Id"] = process.env.SENDKIT_WORKSPACE_ID;
  return h;
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`SendKit ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export const getAccount = () => api("GET", "/v1/account");
export const listTags = () => api("GET", "/v1/tags");
export const createTag = (name, description, color) =>
  api("POST", "/v1/tags", { name, description, color });
export const listWebhooks = () => api("GET", "/v1/webhooks");
export const createWebhook = (payload) => api("POST", "/v1/webhooks", payload);
export const getConversation = (conversationId) =>
  api("GET", `/v1/inbox/${conversationId}`);
export const tagConversations = (conversationIds, tag) =>
  api("POST", "/v1/inbox/tag", { conversationIds, tag });
export const sendReply = (conversationId, body) =>
  api("POST", `/v1/inbox/${conversationId}/reply`, { body });
export const saveDraft = (conversationId, body) =>
  api("POST", `/v1/inbox/${conversationId}/drafts`, { body });
export const addToDnc = (conversationIds) =>
  api("POST", "/v1/inbox/dnc", { conversationIds });
export const scheduleReply = (conversationId, body, scheduledForISO) =>
  api("POST", `/v1/inbox/${conversationId}/reply`, { body, scheduledFor: scheduledForISO });
export const listScheduledReplies = (conversationId) =>
  api("GET", `/v1/inbox/${conversationId}/scheduled`);
export const cancelScheduledReply = (conversationId, replyId) =>
  api("DELETE", `/v1/inbox/${conversationId}/scheduled/${replyId}`);

// The 6 classification tags, with descriptions that also guide SendKit's UI
export const TAGS = [
  { name: "Interested",       description: "Positive reply showing interest in the offer",            color: "#22c55e" },
  { name: "Meeting Request",  description: "Lead wants to book a call or meeting",                    color: "#3b82f6" },
  { name: "More Info Needed", description: "Lead asked for more details before deciding",             color: "#a855f7" },
  { name: "Objection",        description: "Lead pushed back or raised a concern",                    color: "#ef4444" },
  { name: "Pricing Question", description: "Lead asked about cost, pricing, or plans",                color: "#f59e0b" },
  { name: "Timing Issue",     description: "Interested but not now — asked to follow up later",       color: "#6b7280" },
];
