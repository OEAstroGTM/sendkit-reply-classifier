// Follow-up sequence: after a reply with times goes out, schedule short bumps
// via SendKit's scheduled replies. Cancelled automatically when the lead
// answers or books.

import { scheduleReply, listScheduledReplies, cancelScheduledReply } from "./sendkit.js";
import { toHtml } from "./reply.js";

// Days after the send for each bump, e.g. "3,7". Empty string disables.
function followupDays() {
  const raw = process.env.FOLLOWUP_DAYS ?? "3,7";
  return raw.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
}

export function followupBodies(leadFirst, persona) {
  const hey = leadFirst ? `Hey ${leadFirst},` : "Hey,";
  const sign = persona ? `\n\n${persona}` : "";
  return [
    `${hey}\n\nFloating this back up in case it got buried. If none of those times worked, tell me what does and I'll make it happen.${sign}`,
    `${hey}\n\nLast nudge from me, promise. If the timing's off just say so and I'll close the loop. Otherwise, grab any of the times above and we're set.${sign}`,
  ];
}

// Same clock time N days out, shifted off weekends (Sat -> Mon, Sun -> Mon).
export function followupDate(daysFromNow, from = new Date()) {
  const d = new Date(from.getTime() + daysFromNow * 86400000);
  const day = d.getUTCDay();
  if (day === 6) d.setTime(d.getTime() + 2 * 86400000);
  if (day === 0) d.setTime(d.getTime() + 1 * 86400000);
  return d;
}

export async function scheduleFollowups(conversationId, { leadName, persona } = {}) {
  const days = followupDays();
  if (!days.length) return { scheduled: 0, reason: "FOLLOWUP_DAYS disabled" };

  // Don't stack sequences if one is already pending
  try {
    const existing = (await listScheduledReplies(conversationId)).data || [];
    if (existing.length > 0) return { scheduled: 0, reason: "follow-ups already pending" };
  } catch { /* endpoint hiccup: proceed, worst case duplicates are visible in SendKit */ }

  const bodies = followupBodies((leadName || "").split(" ")[0], persona);
  let scheduled = 0;
  for (let i = 0; i < days.length && i < bodies.length; i++) {
    try {
      await scheduleReply(conversationId, toHtml(bodies[i]), followupDate(days[i]).toISOString());
      scheduled++;
    } catch (e) {
      console.error(`follow-up ${i + 1} scheduling failed: ${e.message}`);
    }
  }
  return { scheduled };
}

export async function cancelFollowups(conversationId) {
  try {
    const existing = (await listScheduledReplies(conversationId)).data || [];
    let cancelled = 0;
    for (const r of existing) {
      try { await cancelScheduledReply(conversationId, r._id || r.id); cancelled++; }
      catch (e) { console.error(`cancel follow-up failed: ${e.message}`); }
    }
    return { cancelled };
  } catch {
    return { cancelled: 0 };
  }
}
