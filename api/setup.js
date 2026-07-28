// GET /api/setup?key=YOUR_SETUP_SECRET
// One-time setup: creates the 6 tags in SendKit and registers the
// email.replied webhook pointing at this deployment's /api/webhook.
// Safe to run more than once (existing tags/webhook are skipped).

import { TAGS, createTag, listWebhooks, createWebhook, getAccount } from "../lib/sendkit.js";
import { getGrant } from "../lib/nylas.js";

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Add ?key=YOUR_SETUP_SECRET (matching the SETUP_SECRET env var)" });
  }

  const report = { account: null, tags: [], webhook: null, nylas: null };

  // 1. Verify the API key works
  try {
    const acct = await getAccount();
    report.account = acct.data?.email || acct.email || "ok";
  } catch (e) {
    return res.status(500).json({ error: `SendKit API key check failed: ${e.message}` });
  }

  // 2. Create the 6 tags (ignore "already exists" conflicts)
  for (const tag of TAGS) {
    try {
      await createTag(tag.name, tag.description, tag.color);
      report.tags.push(`${tag.name}: created`);
    } catch (e) {
      report.tags.push(`${tag.name}: ${e.status === 409 ? "already exists" : `error - ${e.message}`}`);
    }
  }

  // 3. Register the webhook (skip if one already points at this URL)
  const webhookUrl = `https://${req.headers.host}/api/webhook`;
  try {
    const existing = (await listWebhooks()).data || [];
    const dup = existing.find((w) => w.url === webhookUrl);
    if (dup) {
      report.webhook = `already registered (${dup._id})`;
    } else {
      const created = await createWebhook({
        name: "Reply Classifier",
        url: webhookUrl,
        events: ["email.replied"],
        ...(process.env.SENDKIT_WEBHOOK_SECRET ? { secret: process.env.SENDKIT_WEBHOOK_SECRET } : {}),
        timeoutMs: 30000,
      });
      const secret = created.data?.secret;
      report.webhook = `created (${created.data?._id})`;
      if (!process.env.SENDKIT_WEBHOOK_SECRET && secret) {
        report.action_required = `SendKit generated webhook secret "${secret}". Add it to Vercel as SENDKIT_WEBHOOK_SECRET and redeploy to enable signature verification.`;
      }
    }
  } catch (e) {
    report.webhook = `error - ${e.message}`;
  }

  // 4. Verify Nylas calendar connection (needed for AI replies with times)
  if (process.env.NYLAS_API_KEY) {
    try {
      const grant = await getGrant();
      report.nylas = `calendar connected: ${grant.email}`;
    } catch (e) {
      report.nylas = `error - ${e.message}`;
    }
  } else {
    report.nylas = "NYLAS_API_KEY not set — replies with calendar times are disabled (tagging still works)";
  }

  return res.status(200).json(report);
}
