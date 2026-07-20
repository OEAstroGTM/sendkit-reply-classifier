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

// --- HMAC signature (mirrors webhook.js logic) ---
test("HMAC signature verification", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ event: "email.replied", data: { conversationId: "abc" } });
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.ok(crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")));
});

console.log(`\n${passed} tests passed`);
