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

async function cal_(method, path, body) {
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

  const me = (await cal_("GET", "/users/me")).resource || {};
  const org = me.current_organization;
  const list = await cal_("GET", `/event_types?organization=${encodeURIComponent(org)}&count=100`);
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
  const r = await cal_("POST", "/scheduling_links", {
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


// Real open slots, each carrying the URL that books that exact time.
//
// Calendly caps the window at 7 days per call, and rejects a start_time in the
// past, so this asks for an hour from now to at most 6 days out. One slot per
// day, so three offered times are three different days rather than three
// consecutive slots on the same morning.
export async function availableTimes({ days = 5, count = 3, timezone = "" } = {}) {
  const et = await eventTypeUri();
  const from = new Date(Date.now() + 60 * 60 * 1000);
  const to = new Date(from.getTime() + Math.min(days, 6) * 86400000);
  const q = new URLSearchParams({
    event_type: et,
    start_time: from.toISOString(),
    end_time: to.toISOString(),
  });
  const r = await cal_("GET", `/event_type_available_times?${q}`);

  const perDay = new Map();
  for (const s of r.collection || []) {
    if (s.status && s.status !== "available") continue;
    const day = String(s.start_time).slice(0, 10);
    if (!perDay.has(day)) perDay.set(day, s);
    if (perDay.size >= count) break;
  }

  const tz = timezone || process.env.DEFAULT_TIMEZONE || "America/New_York";
  return [...perDay.values()].slice(0, count).map((s) => ({
    start_time: s.start_time,
    url: s.scheduling_url,
    label: labelFor(s.start_time, tz),
  }));
}

// "Wed 20 Aug, 10:00 AM GMT+5:30" — the zone is spelled out on purpose. Half
// this list is ten hours away and an unlabelled time is worse than no time.
function labelFor(iso, tz) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short", day: "numeric", month: "short",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(iso)).replace(",", "");
  } catch {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

// A slot lookup failing must never cost us the reply. Fall back to link-only.
export async function safeAvailableTimes(opts) {
  try {
    return await availableTimes(opts);
  } catch (e) {
    console.error("calendly times failed:", e.message);
    return [];
  }
}
