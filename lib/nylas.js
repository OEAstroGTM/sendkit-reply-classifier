// Nylas v3 helpers — calendar availability for proposing meeting times

function base() {
  const region = (process.env.NYLAS_REGION || "us").toLowerCase();
  return `https://api.${region}.nylas.com`;
}

async function nylas(method, path, body, timeoutMs = 15000) {
  const key = process.env.NYLAS_API_KEY;
  if (!key) throw new Error("NYLAS_API_KEY env var is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(e.name === "AbortError"
      ? `Nylas ${method} ${path} timed out after ${timeoutMs}ms`
      : `Nylas ${method} ${path} network error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Nylas ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// Returns { id, email } for the calendar account.
// Uses NYLAS_GRANT_ID if set, otherwise the first valid grant on the app.
// Finds the grant for a specific mailbox, so an event can be created on that
// person's calendar rather than whichever grant happens to be first.
export async function getGrantFor(email) {
  if (!email) return getGrant();
  const grants = (await nylas("GET", "/v3/grants")).data || [];
  const hit = grants.find(
    (g) => String(g.email || "").toLowerCase() === String(email).toLowerCase()
  );
  if (!hit) throw new Error(`No Nylas grant for ${email}. Connected: ${grants.map((g) => g.email).join(", ")}`);
  return { id: hit.id, email: hit.email };
}

export async function getGrant() {
  if (process.env.NYLAS_GRANT_ID && process.env.NYLAS_GRANT_EMAIL) {
    return { id: process.env.NYLAS_GRANT_ID, email: process.env.NYLAS_GRANT_EMAIL };
  }
  const grants = (await nylas("GET", "/v3/grants")).data || [];
  const grant = grants.find((g) => g.grant_status === "valid") || grants[0];
  if (!grant) throw new Error("No Nylas grant found. Connect your calendar account in the Nylas dashboard first.");
  return { id: grant.id, email: grant.email };
}

// Fetches free time slots from the grant's primary calendar.
// Everyone whose calendar must be free for a slot to be offered.
// Defaults to every valid grant on the Nylas app, so connecting a second
// calendar automatically starts filtering against it. Override with
// NYLAS_PARTICIPANT_EMAILS="a@x.com,b@x.com".
export async function getParticipants() {
  const configured = (process.env.NYLAS_PARTICIPANT_EMAILS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured;
  try {
    const grants = (await nylas("GET", "/v3/grants")).data || [];
    const valid = grants.filter((g) => g.grant_status === "valid").map((g) => g.email).filter(Boolean);
    if (valid.length) return [...new Set(valid)];
  } catch { /* fall through */ }
  return [(await getGrant()).email];
}

export async function getAvailableSlots(opts = {}) {
  const grant = await getGrant();
  const tz = opts.timezone || process.env.TIMEZONE || "America/New_York";
  const now = Math.floor(Date.now() / 1000);
  const leadHours = Number(opts.minNoticeHours ?? process.env.MIN_NOTICE_HOURS ?? 20);
  const days = Number(opts.lookaheadDays ?? process.env.LOOKAHEAD_DAYS ?? 7);
  const duration = Number(opts.meetingMinutes ?? process.env.MEETING_MINUTES ?? 30);

  const round5 = (t) => Math.ceil(t / 300) * 300; // Nylas requires 5-min multiples
  const emails = opts.participants || (await getParticipants());
  // max-fairness = offer a slot if ANY one of the team is free, and tell us who.
  // "collective" required all three calendars to be free at once, which across
  // Felipe, Logan and Naufal left roughly one usable half hour per day.
  const method = opts.method || process.env.AVAILABILITY_METHOD || "max-fairness";
  const resp = await nylas("POST", "/v3/calendars/availability", {
    participants: emails.map((email) => ({ email, calendar_ids: ["primary"] })),
    start_time: round5(now + leadHours * 3600),
    end_time: round5(now + days * 86400),
    duration_minutes: duration,
    interval_minutes: 30,
    round_to: 15,
    availability_rules: {
      availability_method: method,
      default_open_hours: [{
        // 0=Sun … 6=Sat. Defaults to Mon-Thu, matching the booking calendar.
        // Override with WORK_DAYS, e.g. "1,2,3,4,5" to include Friday.
        days: String(opts.workDays || process.env.WORK_DAYS || "1,2,3,4")
          .split(",").map((d) => Number(d.trim())).filter((d) => d >= 0 && d <= 6),
        timezone: tz,
        start: opts.workStart || process.env.WORK_START || "9:00",
        end: opts.workEnd || process.env.WORK_END || "17:00",
      }],
    },
  });

  return resp.data?.time_slots || [];
}

// Picks up to `count` slots spread across days (max 2 per day, like a
// natural "here are a few times" email). Returns { start_time, end_time, label }.
export function pickSlots(timeSlots, count = 3, tz = process.env.TIMEZONE || "America/New_York") {
  const picked = [];
  const perDay = {};
  for (const slot of timeSlots) {
    const dayKey = new Date(slot.start_time * 1000).toLocaleDateString("en-US", { timeZone: tz });
    perDay[dayKey] = (perDay[dayKey] || 0) + 1;
    if (perDay[dayKey] > 2) continue;
    picked.push({ ...slot, label: formatSlot(slot.start_time, tz) });
    if (picked.length >= count) break;
  }
  return picked;
}

export function pickAndFormatSlots(timeSlots, count = 3, tz = process.env.TIMEZONE || "America/New_York") {
  return pickSlots(timeSlots, count, tz).map((s) => s.label);
}

// Creates a calendar event and emails the invite to the lead.
export async function createEvent({ startTime, endTime, title, leadEmail, leadName, description, hostEmail }) {
  const grant = hostEmail ? await getGrantFor(hostEmail) : await getGrant();
  const body = {
    title,
    description: description || "",
    when: { start_time: startTime, end_time: endTime },
    participants: [{ email: leadEmail, ...(leadName ? { name: leadName } : {}) }],
    // Google Calendar generates the Meet link for us. Without this the lead
    // gets an invite with no way to actually join the call.
    conferencing: {
      provider: process.env.CONFERENCING_PROVIDER || "Google Meet",
      autocreate: {},
    },
  };
  return nylas(
    "POST",
    `/v3/grants/${grant.id}/events?calendar_id=primary&notify_participants=true`,
    body
  );
}

export function formatSlot(unixSeconds, tz) {
  const d = new Date(unixSeconds * 1000);
  const date = d.toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  return `${date} at ${time}`;
}
