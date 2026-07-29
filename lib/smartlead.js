// Smartlead adapter. Key goes in the query string, not a header.

const BASE = "https://server.smartlead.ai/api/v1";

function key() {
  const k = process.env.SMARTLEAD_API_KEY;
  if (!k) throw new Error("SMARTLEAD_API_KEY env var is not set");
  return k;
}

async function sl(method, path, params = {}, body) {
  const qs = new URLSearchParams({ api_key: key(), ...params });
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Smartlead ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

export const listCampaigns = () => sl("GET", "/campaigns/");
export const campaignStats = (campaignId, params) =>
  sl("GET", `/campaigns/${campaignId}/statistics`, params);
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
  /automatic(ally)? repl(y|ies)/i,
  /auto[- ]?repl(y|ies)/i,
  /^\s*(re:\s*)?automatic reply/i,
  /i am (currently )?(away|on leave|on holiday|on vacation)/i,
  /annual leave|maternity leave|parental leave|sick leave/i,
  /will (be )?(back|return(ing)?) (on|to|the)/i,
  /limited access to (my )?e-?mail/i,
  /thank you for (your )?e-?mail.{0,60}(away|out of|return)/i,
  /undeliverable|delivery (has )?failed|delivery status notification/i,
  /mailbox is full|quota exceeded|address not found|recipient not found/i,
  /no longer (with|works? (at|for))/i,
  /has left the (company|organi[sz]ation)/i,
  /this is an automated (message|response)/i,
  /do not reply to this (e-?mail|message)/i,
  /ticket (has been )?(created|received)|case number/i,
  /we have received your (e-?mail|message|enquiry|inquiry)/i,
  /mailbox (is )?(disabled|deactivated|no longer (in use|monitored))/i,
  /this (address|inbox) is not monitored/i,
  // Italian
  /casella di posta.{0,20}(disattivat|non attiv)/i,
  /(sono|saro|sarò) (attualmente )?(assente|fuori sede|in ferie)/i,
  /risposta automatica|al mio rientro/i,
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
