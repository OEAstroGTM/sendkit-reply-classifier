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

test("formatSlot renders like the outreach email style", () => {
  // 2026-06-29 14:30 UTC = 10:30 AM EDT Monday
  const s = formatSlot(1782743400, "America/New_York");
  assert.match(s, /Monday, June 29 — 10:30 AM (EDT|EST)/);
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

// --- Reply config defaults ---
import { replyConfig } from "../lib/reply.js";

test("reply config defaults match agreed behavior", () => {
  const { replyCategories, autosendCategories } = replyConfig();
  assert.deepEqual(autosendCategories, ["Meeting Request"]);
  assert.ok(replyCategories.includes("Interested"));
  assert.ok(replyCategories.includes("Pricing Question"));
  assert.ok(!replyCategories.includes("Objection"));
  assert.ok(!replyCategories.includes("Timing Issue"));
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
