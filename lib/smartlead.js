// Smartlead adapter. Key goes in the query string, not a header.

const BASE = "https://server.smartlead.ai/api/v1";

function key() {
  const k = process.env.SMARTLEAD_API_KEY;
  if (!k) throw new Error("SMARTLEAD_API_KEY env var is not set");
  return k;
}

// Reads are cached per warm instance. The dashboard loads three panels that
// all walk the same reply history, and Smartlead rate limits well before that
// finishes. TTL is short enough that the queue stays current.
const CACHE = new Map();
const TTL_MS = Number(process.env.SMARTLEAD_CACHE_SECONDS || 300) * 1000;
let cacheEnabled = true;
export function setCacheEnabled(v) { cacheEnabled = v; }
export function clearCache() { CACHE.clear(); }

function cacheGet(k) {
  const hit = CACHE.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { CACHE.delete(k); return null; }
  return hit.value;
}

async function sl(method, path, params = {}, body, attempt = 0) {
  const qs = new URLSearchParams({ api_key: key(), ...params });
  const cacheKey = method === "GET" ? `${path}?${qs}` : null;
  if (cacheKey && cacheEnabled) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }

  const res = await fetch(`${BASE}${path}?${qs}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Back off and retry once on a rate limit rather than failing the panel
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    return sl(method, path, params, body, attempt + 1);
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Smartlead ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  if (cacheKey && cacheEnabled) CACHE.set(cacheKey, { at: Date.now(), value: json });
  return json;
}

export const listCampaigns = () => sl("GET", "/campaigns/");
export const campaignStats = (campaignId, params) =>
  sl("GET", `/campaigns/${campaignId}/statistics`, params);
// Smartlead ignores sent_time_start_date on /statistics, but this endpoint
// is genuinely date-scoped, so it is the only reliable way to count a window.
export const analyticsByDate = (campaignId, start_date, end_date) =>
  sl("GET", `/campaigns/${campaignId}/analytics-by-date`, { start_date, end_date });
export const leadByEmail = (email) => sl("GET", "/leads/", { email });
export const messageHistory = (campaignId, leadId) =>
  sl("GET", `/campaigns/${campaignId}/leads/${leadId}/message-history`);
export const replyToLead = (campaignId, payload) =>
  sl("POST", `/campaigns/${campaignId}/reply-email-thread`, {}, payload);
export const setLeadCategory = (campaignId, leadId, payload) =>
  sl("POST", `/campaigns/${campaignId}/leads/${leadId}/category`, {}, payload);
// Global suppression across all campaigns
export const unsubscribeLead = (leadId) =>
  sl("POST", `/leads/${leadId}/unsubscribe`, {}, {});

// --- Machine-reply detection -------------------------------------------------

const AUTO_PATTERNS = [
  /out of (the )?office/i,
  /\bo\.?o\.?o\.?\b/i,
  /(summer|annual|christmas) (vacation|holiday)/i,
  /eta back|back to 100%|limited inbox time/i,
  /automatic(ally)? repl(y|ies)/i,
  /auto[- ]?repl(y|ies)/i,
  /^\s*(re:\s*)?automatic reply/i,
  /i am (currently )?(away|on leave|on holiday|on vacation)/i,
  /annual leave|maternity leave|parental leave|sick leave/i,
  /will (be )?(back|return(ing)?) (on|to|the)/i,
  /limited access to (my )?e-?mail/i,
  /thank you for (your )?e-?mail.{0,60}(away|out of|return)/i,
  /undeliverable|delivery (has )?failed|delivery status notification/i,
  /your message was rejected by a moderator/i,
  /rejected by a moderator|awaiting moderator approval/i,
  /this (inbox|mailbox|address) is no longer monitored/i,
  /no longer monitored on an ongoing basis/i,
  /forwarded to our new email address/i,
  /mailbox is full|quota exceeded|address not found|recipient not found/i,
  /no longer (with|works? (at|for))/i,
  /no longer an? (employee|member of staff)/i,
  /not (actively )?monitored for (incoming )?(inquiries|enquiries|email)/i,
  /please (resend|forward) your e-?mail to/i,
  /has left the (company|organi[sz]ation)/i,
  /this is an automated (message|response)/i,
  /do not reply to this (e-?mail|message)/i,
  /ticket (has been )?(created|received)|case number/i,
  /we have received your (e-?mail|message|enquiry|inquiry)/i,
  /mailbox (is )?(disabled|deactivated|no longer (in use|monitored))/i,
  /this (address|inbox) is not monitored/i,
  /has received your (message|e-?mail) and will (get back|respond|reply)/i,
  /will get back to you as soon as possible/i,
  /we appreciate your patience/i,
  /for urgent matters,? please call/i,
  /de vacaciones|estar(é|e) de vacaciones|durante mi ausencia/i,
  // Italian
  /casella di posta.{0,20}(disattivat|non attiv)/i,
  /(sono|saro|sarò) (attualmente )?(assente|fuori sede|in ferie)/i,
  /risposta automatica|al mio rientro/i,
  /(sono|saro|sarò) fuori ufficio|rientrer(ò|o) il giorno/i,
  // German
  /abwesenheitsnotiz|abwesend|nicht im b(ü|u)ro|au(ß|ss)er haus/i,
  /automatische (antwort|empfangsbest(ä|a)tigung)/i,
  // Spanish / Portuguese
  /fuera de (la )?oficina|estar(é|e) ausente|respuesta autom(á|a)tica/i,
  /fora do escrit(ó|o)rio|ausente do escrit(ó|o)rio/i,
  // French
  /absent(e)? du bureau|je suis absent|r(é|e)ponse automatique/i,
  // Dutch
  /afwezig|niet aanwezig|automatisch antwoord/i,
  // Nordic
  /(är|ar) inte p(å|a) kontoret|semester|poissa|lomalla/i,
];

export function isMachineReply(text, delaySeconds) {
  const t = String(text || "");
  const own = t.split(/\bFrom:\s/i)[0].split(/\bOn\s.{5,80}?wrote:/i)[0];
  if (AUTO_PATTERNS.some((p) => p.test(own))) return true;
  // Nothing fires that fast by hand
  if (typeof delaySeconds === "number" && delaySeconds < 60) return true;
  return false;
}

const OPTOUT_PATTERNS = [
  /^\s*stop[.!]?\s*$/im,
  /^\s*(please )?(stop|remove|unsubscribe)[.!]?\s*$/im,
  /\bunsubscribe\b/i,
  /remove me from (your |you |the )?(mailing |email )?list/i,
  /(delete|take|drop) (me|us) (from|off) (your |you |the )?(mailing |email )?list/i,
  /(delete|remove) (me|us) from (your |you |the )?(database|records|system)/i,
  /remove (me|us|this (e-?mail|address)) from/i,
  /take me off (your )?(mailing )?list/i,
  /do not (contact|e-?mail) (me|us) again/i,
  /stop (e-?mailing|contacting) (me|us)/i,
  /opt(ing)? out/i,
  /no longer wish to receive/i,
  /(please )?(delete|erase|remove) (our|my) (contact )?(data|details|information)/i,
  /l(ö|oe)schen sie (unsere|meine) daten|daten l(ö|oe)schen/i,
  /keine weiteren (kontaktversuche|e-?mails|nachrichten)/i,
  /bitte (keine|nicht) mehr (kontaktieren|schreiben)/i,
  /ne plus me contacter|d(é|e)sinscri(re|ption)/i,
  /no me (contacten|escriban) m(á|a)s|dar de baja/i,
];

// True when the lead has asked to be removed. These must be suppressed, never
// replied to and never followed up.
export function isOptOut(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const own = t.split(/\bFrom:\s/i)[0].split(/\bOn\s[\s\S]{5,220}?wrote:/i)[0];
  return OPTOUT_PATTERNS.some((p) => p.test(own));
}

const DECLINE_PATTERNS = [
  /\bnot interested\b/i, /\bno,? thank(s| you)\b/i, /^\s*no[.!]?\s*$/im,
  /\bno need\b/i, /we (are|'re) not looking (to|for)/i,
  /not (a )?(good )?fit (for us|at this time)/i,
  /we (will|'ll) (revert|reach out|come back to you) (if|in case|when)/i,
  /at this (stage|time),? we are not/i, /\bnon siamo interessati\b/i,
  /\bkein interesse\b/i, /\bno estamos interesados\b/i,
  // "we are a B2B company - your strategy does not work for us"
  /(your|this) (strategy|approach|service|offer) (does ?n[o']?t|will not|won'?t) work for us/i,
  /not (a )?(fit|relevant) for (us|our business)/i,
  // "Not if this is the level of detail you can share"
  /^\s*not if\b/i,
  // "No" or "Stop" as the opening word, with a signature running on after it
  /^\s*(no|nope|no thanks?|no thx|nah)\b[\s,.!-]*(sent from|regards|thanks|thx|best|cheers)/i,
  /\b(we are|were|we're) not (in|looking for|requiring)\b/i,
];

// A polite "no". Not an opt-out (no legal duty to suppress) but there is
// nothing to reply to and it must never enter the follow-up cadence.
export function isDecline(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const own = t.split(/\bFrom:\s/i)[0].split(/\bOn\s[\s\S]{5,220}?wrote:/i)[0];
  return DECLINE_PATTERNS.some((p) => p.test(own));
}

export function stripHtml(s) {
  return String(s || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// The lead's own words, without the quoted thread underneath
export function ownWords(html) {
  const text = stripHtml(html);
  return text
    .split(/\bFrom:\s/i)[0]
    .split(/\bOn\s.{5,80}?wrote:/i)[0]
    .split(/\bSent:\s/i)[0]
    .trim();
}
