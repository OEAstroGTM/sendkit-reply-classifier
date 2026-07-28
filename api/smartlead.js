// GET /api/smartlead?key=...&action=campaigns
// GET /api/smartlead?key=...&action=audit&campaign_id=123[&max=60][&offset=0]
//     Separates genuine human replies from autoresponders/bounces and returns
//     a compact list with the lead's own words.
// GET /api/smartlead?key=...&action=thread&campaign_id=123&email=lead@x.com

import {
  listCampaigns, campaignStats, leadByEmail, messageHistory,
  isMachineReply, ownWords,
} from "../lib/smartlead.js";

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

    if (action === "audit") {
      const campaignId = req.query.campaign_id;
      if (!campaignId) return res.status(400).json({ error: "Need campaign_id" });
      const max = Math.min(Number(req.query.max || 60), 200);
      const offset = Number(req.query.offset || 0);

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
        totalReplied: stats.total_stats,
        instantAutoResponders: instantAuto,
        machineAfterTextCheck: machine.length,
        humanReplies: human.length,
        awaitingOurReply: human.filter((h) => !h.weAnsweredAfter).length,
        human,
        errors: detailed.filter((d) => d.error),
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
