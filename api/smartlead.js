// GET /api/smartlead?key=...&action=campaigns
// GET /api/smartlead?key=...&action=audit&campaign_id=123[&max=60][&offset=0]
//     Separates genuine human replies from autoresponders/bounces and returns
//     a compact list with the lead's own words.
// GET /api/smartlead?key=...&action=thread&campaign_id=123&email=lead@x.com

import {
  listCampaigns, campaignStats, leadByEmail, messageHistory,
  replyToLead, unsubscribeLead, isMachineReply, ownWords,
} from "../lib/smartlead.js";
import { toHtml } from "../lib/reply.js";
import { linkifySlots } from "../lib/booking.js";
import batch from "../drafts/smartlead-batch.json" with { type: "json" };

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const action = req.query.action || "campaigns";

  try {
    if (action === "campaigns") {
      const list = await listCampaigns();
      return res.status(200).json({
        campaigns: (Array.isArray(list) ? list : list.campaigns || []).map((c) => ({
          id: c.id, name: c.name, status: c.status,
        })),
      });
    }

    if (action === "thread") {
      const { campaign_id, email } = req.query;
      if (!campaign_id || !email) return res.status(400).json({ error: "Need campaign_id and email" });
      const lead = await leadByEmail(email);
      const hist = await messageHistory(campaign_id, lead.id);
      return res.status(200).json({
        lead: { id: lead.id, name: `${lead.first_name || ""} ${lead.last_name || ""}`.trim(), email: lead.email, company: lead.company_name, location: lead.location },
        messages: (hist.history || []).map((m) => ({
          type: m.type, from: m.from, to: m.to, time: m.time,
          stats_id: m.stats_id, message_id: m.message_id,
          text: ownWords(m.email_body).slice(0, 600),
        })),
      });
    }

    // ?action=categories&campaign_id=123
    // Tallies Smartlead's own AI categories across every replied record, and
    // lists the leads it marked positive so they can be checked by hand.
    if (action === "categories") {
      const campaignId = req.query.campaign_id;
      if (!campaignId) return res.status(400).json({ error: "Need campaign_id" });
      const POSITIVE = new Set(["Interested", "Meeting Request", "Information Request"]);

      const tally = {};
      const positives = [];
      let offset = 0, total = null, pages = 0;
      while (pages < 8) {
        const page = await campaignStats(campaignId, {
          email_status: "replied", limit: "100", offset: String(offset),
        });
        total = Number(page.total_stats || 0);
        const rows = page.data || [];
        if (!rows.length) break;
        for (const r of rows) {
          const cat = r.lead_category || "(uncategorized)";
          tally[cat] = (tally[cat] || 0) + 1;
          if (POSITIVE.has(cat)) {
            positives.push({
              name: r.lead_name, email: r.lead_email, category: cat,
              delaySeconds: Math.round((new Date(r.reply_time) - new Date(r.sent_time)) / 1000),
            });
          }
        }
        offset += rows.length;
        pages++;
        if (offset >= total) break;
      }

      const positiveCount = positives.length;
      return res.status(200).json({
        campaignId, totalReplied: total, scanned: offset,
        byCategory: tally,
        positiveCount,
        // Positives that arrived too fast to be typed by a human
        positivesUnder60s: positives.filter((p) => p.delaySeconds < 60).length,
        positives: positives.slice(0, 40),
      });
    }

    if (action === "audit") {
      const campaignId = req.query.campaign_id;
      if (!campaignId) return res.status(400).json({ error: "Need campaign_id" });
      const max = Math.min(Number(req.query.max || 60), 200);
      let offset = Number(req.query.offset || 0);

      // ?recent=1 reads the tail of the list, where new arrivals land.
      // The API returns records in internal-id order, not newest-first, so
      // scanning from offset 0 always re-reads the oldest replies.
      if (req.query.recent === "1") {
        const probe = await campaignStats(campaignId, { email_status: "replied", limit: "1", offset: "0" });
        const total = Number(probe.total_stats || 0);
        offset = Math.max(total - max, 0);
      }

      // 1. Pull replied records; reply delay is the first cheap signal
      const stats = await campaignStats(campaignId, {
        email_status: "replied", limit: String(max), offset: String(offset),
      });
      const rows = stats.data || [];

      const candidates = [];
      let instantAuto = 0;
      for (const r of rows) {
        const delay = (new Date(r.reply_time) - new Date(r.sent_time)) / 1000;
        if (delay < 60) { instantAuto++; continue; }   // machine, don't spend a fetch
        candidates.push({ ...r, delaySeconds: Math.round(delay) });
      }

      // 2. Only fetch threads for plausible humans
      const detailed = await Promise.all(candidates.slice(0, 25).map(async (c) => {
        try {
          const lead = await leadByEmail(c.lead_email);
          const hist = await messageHistory(campaignId, lead.id);
          const msgs = hist.history || [];
          const lastReply = [...msgs].reverse().find((m) => m.type === "REPLY");
          const last = msgs[msgs.length - 1];
          const text = ownWords(lastReply?.email_body);
          return {
            leadId: lead.id,
            name: `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || c.lead_name,
            email: c.lead_email,
            company: lead.company_name || "",
            location: lead.location || "",
            title: lead.custom_fields?.Current_Job_Title || "",
            persona: (lastReply?.to || "").split("@")[0].split(".")[0],
            statsId: lastReply?.stats_id || c.stats_id,
            replyMessageId: lastReply?.message_id || "",
            repliedAt: lastReply?.time || c.reply_time,
            delaySeconds: c.delaySeconds,
            machine: isMachineReply(text, c.delaySeconds),
            weAnsweredAfter: last && last.type !== "REPLY",
            text: text.slice(0, 400),
          };
        } catch (e) {
          return { email: c.lead_email, error: e.message.slice(0, 120) };
        }
      }));

      const human = detailed.filter((d) => !d.error && !d.machine);
      const machine = detailed.filter((d) => !d.error && d.machine);
      return res.status(200).json({
        campaignId,
        scanned: rows.length,
        window: req.query.recent === "1" ? `newest ${max} (offset ${offset})` : `offset ${offset}`,
        totalReplied: stats.total_stats,
        instantAutoResponders: instantAuto,
        machineAfterTextCheck: machine.length,
        humanReplies: human.length,
        awaitingOurReply: human.filter((h) => !h.weAnsweredAfter).length,
        human,
        errors: detailed.filter((d) => d.error),
      });
    }

    // ?action=drafts            -> list the approved batch
    // ?action=send-draft&id=x   -> send one of them (or &id=all)
    if (action === "drafts") {
      return res.status(200).json({
        drafts: batch.drafts.map((d) => ({ id: d.id, lead: d.lead, email: d.email, body: d.body })),
      });
    }
    if (action === "send-draft") {
      const id = req.query.id;
      const targets = id === "all" ? batch.drafts : batch.drafts.filter((d) => d.id === id);
      if (!targets.length) return res.status(404).json({ error: `No draft with id "${id}"` });
      const results = [];
      for (const d of targets) {
        try {
          const lead = await leadByEmail(d.email);
          if (lead.is_unsubscribed) { results.push({ id: d.id, skipped: "unsubscribed" }); continue; }
          const hist = await messageHistory(d.campaign_id, lead.id);
          const msgs = hist.history || [];
          const lastReply = [...msgs].reverse().find((m) => m.type === "REPLY");
          if (!lastReply) { results.push({ id: d.id, error: "no lead reply on thread" }); continue; }
          // Times in the draft become one-click booking links, paired by
          // timestamp so localized labels still resolve to the right moment.
          const emailHtml = linkifySlots(toHtml(d.body), d.slots || [], {
            email: lead.email,
            name: lead.first_name || "",
            baseUrl: `https://${req.headers.host}`,
            durationMin: Number(process.env.MEETING_MINUTES || 30),
          });
          const r = await replyToLead(d.campaign_id, {
            email_stats_id: lastReply.stats_id,
            email_body: emailHtml,
            reply_message_id: lastReply.message_id,
            reply_email_time: lastReply.time,
            to_email: lead.email,
            to_first_name: lead.first_name || "",
            to_last_name: lead.last_name || "",
            add_signature: false,
          });
          results.push({ id: d.id, lead: d.lead, sent: true, response: r });
        } catch (e) {
          results.push({ id: d.id, error: e.message.slice(0, 200) });
        }
      }
      return res.status(200).json({ results });
    }

    // POST /api/smartlead?key=...  { action:"send", campaign_id, email, body, [scheduled_time] }
    // Sends the exact text given. Refuses if the lead is unsubscribed.
    if (action === "send") {
      const p = { ...req.query, ...(req.body || {}) };
      const { campaign_id, email, body } = p;
      if (!campaign_id || !email || !body) {
        return res.status(400).json({ error: "Need campaign_id, email and body" });
      }
      const lead = await leadByEmail(email);
      if (lead.is_unsubscribed) {
        return res.status(409).json({ error: "Lead is unsubscribed, refusing to send" });
      }
      const hist = await messageHistory(campaign_id, lead.id);
      const msgs = hist.history || [];
      const lastReply = [...msgs].reverse().find((m) => m.type === "REPLY");
      if (!lastReply) return res.status(400).json({ error: "No lead reply found on this thread" });

      const result = await replyToLead(campaign_id, {
        email_stats_id: lastReply.stats_id,
        email_body: toHtml(body),
        reply_message_id: lastReply.message_id,
        reply_email_time: lastReply.time,
        to_email: lead.email,
        to_first_name: lead.first_name || "",
        to_last_name: lead.last_name || "",
        add_signature: false,
        ...(p.scheduled_time ? { scheduled_time: p.scheduled_time } : {}),
      });
      return res.status(200).json({
        sent: true, lead: lead.email, campaign_id,
        statsId: lastReply.stats_id, result,
      });
    }

    // GET/POST ?action=unsubscribe&email=...  — global suppression
    if (action === "unsubscribe") {
      const email = req.query.email || req.body?.email;
      if (!email) return res.status(400).json({ error: "Need email" });
      const lead = await leadByEmail(email);
      const result = await unsubscribeLead(lead.id);
      const after = await leadByEmail(email);
      return res.status(200).json({
        email, leadId: lead.id,
        isUnsubscribed: after.is_unsubscribed,
        result,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
