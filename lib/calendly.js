// Calendly booking links. Replaces the Nylas slot machinery in the reply path.
//
// Why no times: Nylas offered slots across a fixed participant list that still
// included someone who has left, and rendering those slots produced booking
// links into /api/book, which silently created 58 phantom events. A Calendly
// single-use link lets the lead pick from real availability, and it dies after
// one booking so it cannot be forwarded around.
//
// It also fixes timezones for free. Most of the quiet cohort is India and
// south-east Asia; guessing times across a ten-hour offset never worked.

const BASE = "https://api.calendly.com";

async function cal(method, path, body) {
  const token = process.env.CALENDLY_TOKEN;
  if (!token) throw new Error("CALENDLY_TOKEN is not set");
  const r = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Calendly ${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

let _etCache = { at: 0, uri: "" };

async function eventTypeUri() {
  const want = process.env.CALENDLY_EVENT_TYPE || "";
  if (want.startsWith("https://api.calendly.com/")) return want;
  if (Date.now() - _etCache.at < 600000 && _etCache.uri) return _etCache.uri;

  const me = (await cal("GET", "/users/me")).resource || {};
  const org = me.current_organization;
  const list = await cal("GET", `/event_types?organization=${encodeURIComponent(org)}&count=100`);
  const all = list.collection || [];

  let hit = null;
  if (want) hit = all.find((e) => (e.scheduling_url || "").replace(/\/$/, "") === want.replace(/\/$/, ""));
  if (!hit) hit = all.find((e) => e.active && e.pooling_type === "round_robin");
  if (!hit) hit = all.find((e) => e.active);
  if (!hit) throw new Error("no usable Calendly event type");

  _etCache = { at: Date.now(), uri: hit.uri };
  return hit.uri;
}

// One booking, then the link is dead. Prefilled so the lead retypes nothing.
export async function bookingLink({ name = "", email = "" } = {}) {
  const owner = await eventTypeUri();
  const r = await cal("POST", "/scheduling_links", {
    max_event_count: 1,
    owner,
    owner_type: "EventType",
  });
  let url = r.resource?.booking_url || "";
  const q = new URLSearchParams();
  if (name) q.set("name", name);
  if (email) q.set("email", email);
  const qs = q.toString();
  if (url && qs) url += (url.includes("?") ? "&" : "?") + qs;
  return url;
}

// Never let a booking-link failure kill a reply. A reply without a link still
// answers the person; no reply at all is the actual failure.
export async function safeBookingLink(opts) {
  try {
    return await bookingLink(opts);
  } catch (e) {
    console.error("calendly link failed:", e.message);
    return "";
  }
}
