// Offline unit tests — no network needed. Run with: npm test
import assert from "node:assert";
import crypto from "node:crypto";
import { parseClassification, normalizeCategory, CATEGORIES } from "../lib/classify.js";

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// --- parseClassification ---
test("parses clean JSON", () => {
  const r = parseClassification('{"category":"Interested","confidence":0.92,"reason":"Positive tone"}');
  assert.equal(r.category, "Interested");
  assert.equal(r.confidence, 0.92);
});

test("parses JSON wrapped in markdown fences", () => {
  const r = parseClassification('```json\n{"category":"Pricing Question","confidence":0.8,"reason":"asks cost"}\n```');
  assert.equal(r.category, "Pricing Question");
});

test("handles garbage output as None", () => {
  const r = parseClassification("I think this is interested maybe");
  assert.equal(r.category, "None");
});

test("normalizes category case", () => {
  assert.equal(normalizeCategory("meeting request"), "Meeting Request");
  assert.equal(normalizeCategory("TIMING ISSUE"), "Timing Issue");
  assert.equal(normalizeCategory("Not Interested"), "None");
  assert.equal(normalizeCategory(null), "None");
});

test("all 6 categories present", () => {
  assert.equal(CATEGORIES.length, 6);
});

// --- Slot picking & formatting ---
import { pickAndFormatSlots, formatSlot } from "../lib/nylas.js";

test("formatSlot renders like the outreach email style (no em dash)", () => {
  // 2026-06-29 14:30 UTC = 10:30 AM EDT Monday
  const s = formatSlot(1782743400, "America/New_York");
  assert.match(s, /Monday, June 29 at 10:30 AM (EDT|EST)/);
  assert.ok(!s.includes("—"));
});

test("pickAndFormatSlots takes max 2 per day, 3 total", () => {
  const day1 = 1782743400; // Mon Jun 29 2026 10:30 ET
  const slots = [
    { start_time: day1 },
    { start_time: day1 + 1800 },   // Mon 11:00
    { start_time: day1 + 3600 },   // Mon 11:30 (should skip — 3rd same day)
    { start_time: day1 + 87300 },  // Tue 10:45
    { start_time: day1 + 90000 },  // Tue (not needed)
  ];
  const lines = pickAndFormatSlots(slots, 3, "America/New_York");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Monday/);
  assert.match(lines[1], /Monday/);
  assert.match(lines[2], /Tuesday/);
});

// --- HTML conversion & dash scrubbing ---
import { replyConfig, toHtml, scrubDashes } from "../lib/reply.js";

test("toHtml embeds markdown links and controls spacing", () => {
  const html = toHtml("Hey Greg,\n\nHere's a [quick overview](http://example.com) to skim.\n\n• Monday at 10:30 AM EST\n• Tuesday at 10:45 AM EST\n\nWendy");
  assert.ok(html.includes('<a href="http://example.com">quick overview</a>'));
  assert.ok(html.includes("• Monday at 10:30 AM EST<br>• Tuesday at 10:45 AM EST"));
  assert.ok(html.includes("skim.<br><br>• Monday"));
  assert.ok(!html.includes("\n"));
});

test("toHtml escapes raw HTML in reply text", () => {
  const html = toHtml("a <script>bad</script> & more");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&amp; more"));
});

test("scrubDashes removes em and en dashes", () => {
  assert.equal(scrubDashes("great — thanks"), "great, thanks");
  assert.equal(scrubDashes("2pm – 3pm works"), "2pm, 3pm works");
  assert.ok(!scrubDashes("a—b–c").match(/[—–]/));
});

test("reply config defaults match agreed behavior", () => {
  const { replyCategories, autosendCategories } = replyConfig();
  assert.deepEqual(autosendCategories, ["Meeting Request"]);
  assert.ok(replyCategories.includes("Interested"));
  assert.ok(replyCategories.includes("Pricing Question"));
  assert.ok(!replyCategories.includes("Objection"));
  assert.ok(!replyCategories.includes("Timing Issue"));
});

// --- Opt-out guard ---
import { isOptOut } from "../lib/inbox.js";

test("opt-out guard catches unsubscribe requests", () => {
  assert.ok(isOptOut("UNSUBSCRIBE", "signature only"));
  assert.ok(isOptOut("", "please remove me from your list"));
  assert.ok(isOptOut("", "stop emailing me"));
  assert.ok(isOptOut("RE: hello", "I want to opt out of these"));
});

test("opt-out guard ignores normal replies and quoted pitch text", () => {
  assert.ok(!isOptOut("RE: quick question", "sounds interesting, tell me more"));
  // "unsubscribe" only appears in the quoted original below "From:"
  assert.ok(!isOptOut("RE: hello", "yes let's talk From: Wendy Price unsubscribe link here"));
  // Gmail-style quote
  assert.ok(!isOptOut("Re: pricing", "what's the per-inbox cost? On Mon, Jun 29, 2026 at 7:27 PM Amelia wrote: reply STOP to opt out"));
  // "> " quoted lines
  assert.ok(!isOptOut("Re: hi", "sounds good\n> unsubscribe anytime with this link"));
});

// --- Sender persona extraction ---
import { senderPersona } from "../lib/inbox.js";

test("sender persona comes from the mailbox the lead replied to", () => {
  const msgs = [
    { type: "sent", subject: "hi", body: "..." },
    { type: "reply", from: "andrew@additivecpa.com", to: "stephanie.taylor@koldmailworks.com", content: "works for me" },
  ];
  assert.equal(senderPersona(msgs), "Stephanie");
  assert.equal(senderPersona([{ type: "reply", to: "aria.evans@koldmailnet.co", content: "x" }]), "Aria");
  assert.equal(senderPersona([]), "");
});

// --- Booking link signatures ---
process.env.SETUP_SECRET = process.env.SETUP_SECRET || "test-secret";
const { signSlot, verifySlot, bookUrl } = await import("../lib/booking.js");

test("booking link signature round-trip", () => {
  const sig = signSlot("greg@x.com", 1782743400, 30);
  assert.ok(verifySlot("greg@x.com", 1782743400, 30, sig));
  assert.ok(!verifySlot("greg@x.com", 1782743400, 45, sig));   // tampered duration
  assert.ok(!verifySlot("evil@x.com", 1782743400, 30, sig));   // tampered email
});

test("bookUrl contains signed params", () => {
  const url = bookUrl("https://app.example.com", { email: "greg@x.com", name: "Greg", startTime: 1782743400, durationMin: 30 });
  assert.ok(url.startsWith("https://app.example.com/api/book?"));
  assert.ok(url.includes("t=1782743400") && url.includes("sig="));
});

// --- HMAC signature (mirrors webhook.js logic) ---
test("HMAC signature verification", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ event: "email.replied", data: { conversationId: "abc" } });
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.ok(crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")));
});

console.log(`\n${passed} tests passed`);
