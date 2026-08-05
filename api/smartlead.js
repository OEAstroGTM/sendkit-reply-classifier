// GET /api/smartlead?key=...&action=campaigns
// GET /api/smartlead?key=...&action=audit&campaign_id=123[&max=60][&offset=0]
//     Separates genuine human replies from autoresponders/bounces and returns
//     a compact list with the lead's own words.
// GET /api/smartlead?key=...&action=thread&campaign_id=123&email=lead@x.com

import {
  listCampaigns, campaignStats, leadByEmail, messageHistory,
  replyToLead, unsubscribeLead, analyticsByDate, isMachineReply, isOptOut, isDecline, ownWords, clearCache,
} from "../lib/smartlead.js";
import { toHtml, generateReply, generateBump } from "../lib/reply.js";
import { linkifySlots } from "../lib/booking.js";
import { createEvent, cancelEvent, formatSlot, getGrantFor } from "../lib/nylas.js";
import batch from "../drafts/smartlead-batch.json" with { type: "json" };
import holdList from "../drafts/followup-hold.json" with { type: "json" };

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const action = req.query.action || "campaigns";
  // ?fresh=1 forces a re-read instead of using the cached responses
  if (req.query.fresh === "1") clearCache();

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

    // ?action=draft&campaign_id=123&email=lead@x.com
    // Writes a reply for one lead: reads the thread, pulls live availability
    // in the lead's timezone, returns text + HTML with booking links.
    if (action === "draft") {
      const { campaign_id, email } = req.query;
      if (!campaign_id || !email) return res.status(400).json({ error: "Need campaign_id and email" });
      const lead = await leadByEmail(email);
      const hist = await messageHistory(campaign_id, lead.id);
      const msgs = hist.history || [];
      const lastReply = [...msgs].reverse().find((m) => m.type === "REPLY");
      if (!lastReply) return res.status(400).json({ error: "No lead reply on this thread" });

      const said = ownWords(lastReply.email_body);
      const persona = (lastReply.to || "").split("@")[0].split(".")[0];
      const personaName = persona ? persona.charAt(0).toUpperCase() + persona.slice(1) : "";
      const category = req.query.category || "Interested";

      const { body, html, slots } = await generateReply({
        category,
        replyText: said,
        leadName: lead.first_name || "",
        subject: lastReply.subject || "",
        leadEmail: lead.email,
        baseUrl: `https://${req.headers.host}`,
        senderName: personaName,
        leadTimezone: guessTimezone(lead),
      });
      return res.status(200).json({ email: lead.email, persona: personaName, said: said.slice(0, 400), body, html, slots });
    }

    // ?action=bump&campaign_id=123&email=lead@x.com  — draft a nudge
    if (action === "bump") {
      const { campaign_id, email } = req.query;
      if (!campaign_id || !email) return res.status(400).json({ error: "Need campaign_id and email" });
      const lead = await leadByEmail(email);
      const hist = await messageHistory(campaign_id, lead.id);
      const msgs = hist.history || [];
      const lastReplyIdx = [...msgs].map((m) => m.type).lastIndexOf("REPLY");
      const lastReply = msgs[lastReplyIdx];
      const bumpsSent = Math.max(0, msgs.slice(lastReplyIdx + 1).length - 1);
      const schedule = (process.env.FOLLOWUP_DAYS || "3,7").split(",");
      const persona = (lastReply?.to || "").split("@")[0].split(".")[0];

      const { body, html, slots } = await generateBump({
        leadName: lead.first_name || "",
        senderName: persona ? persona.charAt(0).toUpperCase() + persona.slice(1) : "",
        said: ownWords(lastReply?.email_body),
        bumpNumber: bumpsSent + 1,
        isFinal: bumpsSent + 1 >= schedule.length,
        leadEmail: lead.email,
        baseUrl: `https://${req.headers.host}`,
        leadTimezone: guessTimezone(lead),
      });
      return res.status(200).json({ email: lead.email, bumpNumber: bumpsSent + 1, body, html, slots });
    }

    // ?action=stats[&campaign_id=a,b]  — inbox management performance.
    // Defaults to every ACTIVE campaign. Reports how the replies are being
    // handled, not just how the campaign is sending.
    if (action === "stats") {
      const POSITIVE = new Set(["Interested", "Meeting Request", "Information Request"]);
      let ids = (req.query.campaign_id || "").split(",").map((s) => s.trim()).filter(Boolean);
      let names = {};
      const all = await listCampaigns();
      const list = Array.isArray(all) ? all : all.campaigns || [];
      for (const c of list) names[String(c.id)] = { name: c.name, status: c.status };
      // Live campaigns only. DRAFTED never went out; ARCHIVED is finished work.
      if (!ids.length) ids = list.filter((c) => c.status !== "DRAFTED" && c.status !== "ARCHIVED").map((c) => String(c.id));

      // Performance is a rolling window. ?days=0 for all time.
      const windowDays = req.query.days === undefined ? 30 : Number(req.query.days);
      const since = windowDays > 0
        ? new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10)
        : null;
      // Smartlead ignores sent_time_start_date on this endpoint, so the window
      // is applied here against each reply's own timestamp.
      const sinceMs = since ? new Date(since).getTime() : null;

      const perCampaign = await Promise.all(ids.map(async (id) => {
        try {
          // lifetime sends for this campaign (used for the per-1k efficiency figure)
          const head = await campaignStats(id, { limit: "1", offset: "0" });
          const sent = Number(head.total_stats || 0);

          // every replied record
          const rows = [];
          let offset = 0, total = 0, pages = 0;
          while (pages < 8) {
            const page = await campaignStats(id, { email_status: "replied", limit: "100", offset: String(offset) });
            total = Number(page.total_stats || 0);
            const r = page.data || [];
            if (!r.length) break;
            rows.push(...r);
            offset += r.length; pages++;
            if (offset >= total) break;
          }

          const lifetimeReplies = total;
          const windowed = sinceMs
            ? rows.filter((r) => new Date(r.reply_time).getTime() >= sinceMs)
            : rows;
          total = windowed.length;

          const byCategory = {};
          let machines = 0;
          const positives = [];
          for (const r of windowed) {
            const cat = r.lead_category || "(uncategorized)";
            byCategory[cat] = (byCategory[cat] || 0) + 1;
            const delay = Math.round((new Date(r.reply_time) - new Date(r.sent_time)) / 1000);
            if (delay < 60) machines++;
            if (POSITIVE.has(cat)) positives.push({ name: r.lead_name, email: r.lead_email, category: cat, delaySeconds: delay });
          }

          // answered vs awaiting, plus how quickly we responded
          const checked = await Promise.all(positives.slice(0, 40).map(async (p) => {
            try {
              const lead = await leadByEmail(p.email);
              const hist = await messageHistory(id, lead.id);
              const msgs = hist.history || [];
              const last = msgs[msgs.length - 1];
              const lastReplyIdx = [...msgs].map((m) => m.type).lastIndexOf("REPLY");
              const lastReply = msgs[lastReplyIdx];
              // Same rule the queue uses: an autoresponder is not someone waiting
              const machine = isMachineReply(ownWords(lastReply?.email_body), p.delaySeconds);
              const awaiting = !machine && last && last.type === "REPLY";
              let responseHours = null;
              if (!awaiting && lastReply) {
                // first outbound after their most recent inbound
                const after = msgs.slice(lastReplyIdx + 1).find((m) => m.type !== "REPLY");
                if (after) responseHours = (new Date(after.time) - new Date(lastReply.time)) / 3600000;
              }
              return { ...p, awaiting, responseHours, hoursWaiting: awaiting && lastReply
                ? (Date.now() - new Date(lastReply.time).getTime()) / 3600000 : null };
            } catch { return null; }
          }));
          const seen = checked.filter(Boolean);
          const answered = seen.filter((x) => !x.awaiting);
          const responded = answered.filter((x) => typeof x.responseHours === "number");

          return {
            campaignId: id,
            name: names[id]?.name || id,
            status: names[id]?.status || "",
            sent, lifetimeReplies, replies: total,
            machines,
            humanReplies: total - machines,
            positives: positives.length,
            positivesPer1k: sent ? +(positives.length / sent * 1000).toFixed(2) : 0,
            answered: answered.length,
            awaiting: seen.filter((x) => x.awaiting).length,
            oldestWaitingHours: Math.round(Math.max(0, ...seen.filter((x) => x.awaiting).map((x) => x.hoursWaiting || 0))),
            medianResponseHours: responded.length
              ? +median(responded.map((x) => x.responseHours)).toFixed(1) : null,
            byCategory,
          };
        } catch (e) {
          return { campaignId: id, name: names[id]?.name || id, error: e.message.slice(0, 160) };
        }
      }));

      const ok = perCampaign.filter((c) => !c.error);
      const sum = (k) => ok.reduce((n, c) => n + (c[k] || 0), 0);
      const medians = ok.map((c) => c.medianResponseHours).filter((n) => typeof n === "number");
      return res.status(200).json({
        generatedAt: new Date().toISOString(),
        windowDays, since,
        totals: {
          sent: sum("sent"), replies: sum("replies"),
          machines: sum("machines"), humanReplies: sum("humanReplies"),
          positives: sum("positives"),
          answered: sum("answered"), awaiting: sum("awaiting"),
          answeredPct: sum("positives") ? Math.round(sum("answered") / sum("positives") * 100) : 0,
          machinePct: sum("replies") ? Math.round(sum("machines") / sum("replies") * 100) : 0,
          positivesPer1k: sum("sent") ? +(sum("positives") / sum("sent") * 1000).toFixed(2) : 0,
          medianResponseHours: medians.length ? +median(medians).toFixed(1) : null,
          oldestWaitingHours: Math.max(0, ...ok.map((c) => c.oldestWaitingHours || 0)),
        },
        campaigns: perCampaign,
      });
    }


    // ?action=followups[&campaign_id=a,b][&days=30]
    // Leads we answered who then went quiet. Smartlead's sequence stops once a
    // lead replies, so nothing chases these unless we do.
    if (action === "followups") {
      const POSITIVE = new Set(["Interested", "Meeting Request", "Information Request"]);
      let ids = (req.query.campaign_id || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!ids.length) {
        const all = await listCampaigns();
        const list = Array.isArray(all) ? all : all.campaigns || [];
        // Same reasoning as the inbox scan: paused campaigns still have threads.
        ids = list.filter((c) => c.status !== "DRAFTED" && c.status !== "ARCHIVED")
                  .map((c) => String(c.id));
      }
      const windowDays = req.query.days === undefined ? 30 : Number(req.query.days);
      const sinceMs = windowDays > 0 ? Date.now() - windowDays * 86400000 : null;
      // Cadence: the list is worked every weekday, but each contact is only
      // touched on these days-since-quiet. ?schedule=2,5,10 overrides.
      const bumpDays = (req.query.schedule || process.env.FOLLOWUP_DAYS || "2,5,10")
        .split(",").map((n) => Number(n.trim())).filter((n) => !Number.isNaN(n));
      const maxBumps = bumpDays.length;
      // Booked meetings and promised calls never get nudged.
      const HOLD = new Map(holdList.hold.map((h) => [h.email.toLowerCase(), h.reason]));
      // Nothing goes out at the weekend. Availability is Mon-Thu and Sundays are closed.
      const dow = new Date().getUTCDay();
      const sendingDay = dow >= 1 && dow <= 5;

      const out = [];
      for (const id of ids) {
        const rows = [];
        let offset = 0, total = 0, pages = 0;
        while (pages < 8) {
          const page = await campaignStats(id, { email_status: "replied", limit: "100", offset: String(offset) });
          total = Number(page.total_stats || 0);
          const r = page.data || [];
          if (!r.length) break;
          rows.push(...r); offset += r.length; pages++;
          if (offset >= total) break;
        }
        const positives = rows.filter((r) => POSITIVE.has(r.lead_category) &&
          (!sinceMs || new Date(r.reply_time).getTime() >= sinceMs));

        const checked = await Promise.all(positives.slice(0, 40).map(async (r) => {
          try {
            const lead = await leadByEmail(r.lead_email);
            if (lead.is_unsubscribed) return null;
            const hist = await messageHistory(id, lead.id);
            const msgs = hist.history || [];
            const last = msgs[msgs.length - 1];
            if (!last || last.type === "REPLY") return null;      // still our turn, that's the reply queue

            // how many outbound messages since their last word = bumps already sent
            const lastReplyIdx = [...msgs].map((m) => m.type).lastIndexOf("REPLY");
            const lastReply = msgs[lastReplyIdx];
            const outboundSince = msgs.slice(lastReplyIdx + 1).length;
            const bumpsSent = Math.max(0, outboundSince - 1);      // first one was the actual answer
            const daysQuiet = (Date.now() - new Date(last.time).getTime()) / 86400000;
            const nextBumpAt = bumpDays[bumpsSent];

            return {
              campaign_id: id,
              leadId: lead.id,
              name: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email,
              email: lead.email,
              company: lead.company_name || "",
              location: lead.location || "",
              phone: lead.phone_number || "",
              category: r.lead_category,
              persona: (lastReply?.to || "").split("@")[0].split(".")[0],
              theySaid: ownWords(lastReply?.email_body).slice(0, 220),
              weSaid: ownWords(last.email_body).slice(0, 220),
              ourLastMessageAt: last.time,
              daysQuiet: +daysQuiet.toFixed(1),
              bumpsSent,
              exhausted: bumpsSent >= maxBumps,
              hold: HOLD.get(lead.email.toLowerCase()) || null,
              due: !HOLD.has(lead.email.toLowerCase()) && sendingDay &&
                   bumpsSent < maxBumps && nextBumpAt !== undefined && daysQuiet >= nextBumpAt,
              nextBumpInDays: nextBumpAt === undefined ? null : +Math.max(0, nextBumpAt - daysQuiet).toFixed(1),
            };
          } catch { return null; }
        }));
        out.push(...checked.filter(Boolean));
      }

      out.sort((a, b) => b.daysQuiet - a.daysQuiet);
      return res.status(200).json({
        schedule: bumpDays,
        sendingDay,
        total: out.length,
        due: out.filter((x) => x.due).length,
        held: out.filter((x) => x.hold).length,
        waiting: out.filter((x) => !x.due && !x.hold && !x.exhausted).length,
        exhausted: out.filter((x) => x.exhausted).length,
        dueNow: out.filter((x) => x.due).map((x) => ({
          name: x.name, email: x.email, company: x.company, campaign_id: x.campaign_id,
          daysQuiet: x.daysQuiet, bumpsSent: x.bumpsSent, persona: x.persona,
        })),
        followups: out,
      });
    }

    // ?action=inbox[&campaign_id=a,b][&max=60]
    // The real work list. Scans EVERY active campaign and decides from the
    // reply text itself, not from Smartlead's category tags, because roughly
    // 84% of replies come back uncategorized and were invisible to ?action=queue.
    if (action === "inbox") {
      let ids = (req.query.campaign_id || "").split(",").map((x) => x.trim()).filter(Boolean);
      const all = await listCampaigns();
      const list = Array.isArray(all) ? all : all.campaigns || [];
      const names = {};
      for (const c of list) names[String(c.id)] = c.name;
      // PAUSED stops sending, it does not stop people replying, so paused
      // campaigns still hold live conversations. Only DRAFTED (never sent)
      // and ARCHIVED (finished) are genuinely out of scope.
      if (!ids.length) ids = list
        .filter((c) => c.status !== "DRAFTED" && c.status !== "ARCHIVED")
        .map((c) => String(c.id));

      const max = Math.min(Number(req.query.max || 60), 120);
      const perCampaign = Math.min(Number(req.query.threads || 25), 40);
      const awaiting = [], optouts = [], declines = [];
      let scanned = 0, instantMachines = 0;

      for (const id of ids) {
        // Read the tail of the list, where new arrivals land
        const probe = await campaignStats(id, { email_status: "replied", limit: "1", offset: "0" });
        const total = Number(probe.total_stats || 0);
        const offset = Math.max(total - max, 0);
        const stats = await campaignStats(id, {
          email_status: "replied", limit: String(max), offset: String(offset),
        });
        const rows = stats.data || [];
        scanned += rows.length;

        // Anything answered within a minute was not typed by a person
        const candidates = [];
        for (const r of rows) {
          const delay = (new Date(r.reply_time) - new Date(r.sent_time)) / 1000;
          if (delay < 60) { instantMachines++; continue; }
          candidates.push({ ...r, delaySeconds: Math.round(delay) });
        }

        const checked = await Promise.all(candidates.slice(0, perCampaign).map(async (c) => {
          try {
            const lead = await leadByEmail(c.lead_email);
            const hist = await messageHistory(id, lead.id);
            const msgs = hist.history || [];
            const last = msgs[msgs.length - 1];
            const lastReply = [...msgs].reverse().find((m) => m.type === "REPLY");
            const text = ownWords(lastReply?.email_body);
            return {
              campaign_id: id, campaign: names[id] || id,
              leadId: lead.id,
              name: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || c.lead_name,
              email: c.lead_email,
              company: lead.company_name || "",
              title: lead.custom_fields?.Current_Job_Title || "",
              location: lead.location || "",
              phone: lead.phone_number || "",
              category: c.lead_category || "(uncategorized)",
              persona: (lastReply?.to || "").split("@")[0].split(".")[0],
              repliedAt: lastReply?.time || c.reply_time,
              hoursWaiting: lastReply?.time
                ? Math.round((Date.now() - new Date(lastReply.time).getTime()) / 3600000) : null,
              suppressed: !!lead.is_unsubscribed,
              optOut: isOptOut(text),
              decline: isDecline(text),
              machine: isMachineReply(text, c.delaySeconds),
              ourTurn: !!last && last.type === "REPLY",
              said: text.slice(0, 300),
            };
          } catch { return null; }
        }));

        for (const x of checked.filter(Boolean)) {
          if (x.optOut) { if (!x.suppressed) optouts.push(x); continue; }
          if (x.machine || !x.ourTurn || x.suppressed) continue;
          if (x.decline) { declines.push(x); continue; }
          awaiting.push(x);
        }
      }

      awaiting.sort((a, b) => (b.hoursWaiting ?? 0) - (a.hoursWaiting ?? 0));
      return res.status(200).json({
        generatedAt: new Date().toISOString(),
        campaignsScanned: ids.length,
        repliesScanned: scanned,
        instantMachines,
        awaitingCount: awaiting.length,
        // Polite no's. Nothing to answer, but they must not enter follow-ups.
        declined: declines.map((x) => ({ name: x.name, email: x.email, company: x.company, said: x.said.slice(0, 100) })),
        // Asked to be removed and not yet suppressed. Handle these first.
        optOutsToSuppress: optouts.map((x) => ({ name: x.name, email: x.email, said: x.said.slice(0, 120) })),
        awaiting,
      });
    }

    // ?action=queue&campaign_id=123
    // Positives that are still waiting on us: reads each positive thread and
    // keeps only those where the lead spoke last. This is the work list.
    if (action === "queue") {
      const campaignId = req.query.campaign_id;
      if (!campaignId) return res.status(400).json({ error: "Need campaign_id" });
      const POSITIVE = new Set(["Interested", "Meeting Request", "Information Request"]);

      // 1. Collect positives across all replied records
      const positives = [];
      let offset = 0, total = 0, pages = 0;
      while (pages < 8) {
        const page = await campaignStats(campaignId, {
          email_status: "replied", limit: "100", offset: String(offset),
        });
        total = Number(page.total_stats || 0);
        const rows = page.data || [];
        if (!rows.length) break;
        for (const r of rows) {
          if (POSITIVE.has(r.lead_category)) {
            positives.push({
              name: r.lead_name, email: r.lead_email, category: r.lead_category,
              delaySeconds: Math.round((new Date(r.reply_time) - new Date(r.sent_time)) / 1000),
            });
          }
        }
        offset += rows.length; pages++;
        if (offset >= total) break;
      }

      // 2. Read each thread in parallel and keep the ones awaiting a reply
      const checked = await Promise.all(positives.slice(0, 40).map(async (p) => {
        try {
          const lead = await leadByEmail(p.email);
          if (lead.is_unsubscribed) return null;
          const hist = await messageHistory(campaignId, lead.id);
          const msgs = hist.history || [];
          const last = msgs[msgs.length - 1];
          if (!last || last.type !== "REPLY") return null;   // we already answered
          const lastReply = [...msgs].reverse().find((m) => m.type === "REPLY");
          const text = ownWords(lastReply?.email_body);
          if (isMachineReply(text, p.delaySeconds)) return null;
          return {
            ...p,
            leadId: lead.id,
            company: lead.company_name || "",
            title: lead.custom_fields?.Current_Job_Title || "",
            location: lead.location || "",
            phone: lead.phone_number || "",
            persona: (lastReply?.to || "").split("@")[0].split(".")[0],
            repliedAt: lastReply?.time || "",
            hoursWaiting: lastReply?.time
              ? Math.round((Date.now() - new Date(lastReply.time).getTime()) / 3600000) : null,
            said: text.slice(0, 300),
          };
        } catch { return null; }
      }));

      // Anything older than this is cold, not a work item. ?days=0 for all.
      const maxAgeDays = req.query.days === undefined ? 30 : Number(req.query.days);
      const all = checked.filter(Boolean)
        .sort((a, b) => (b.hoursWaiting ?? 0) - (a.hoursWaiting ?? 0));
      const fresh = maxAgeDays > 0
        ? all.filter((x) => (x.hoursWaiting ?? 0) <= maxAgeDays * 24)
        : all;
      return res.status(200).json({
        campaignId, totalReplied: total,
        positives: positives.length,
        awaitingReply: fresh.length,
        staleHidden: all.length - fresh.length,
        maxAgeDays,
        queue: fresh,
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

      const emailHtml = linkifySlots(toHtml(body), Array.isArray(p.slots) ? p.slots : [], {
        email: lead.email, name: lead.first_name || "",
        baseUrl: `https://${req.headers.host}`,
        durationMin: Number(process.env.MEETING_MINUTES || 30),
      });
      const result = await replyToLead(campaign_id, {
        email_stats_id: lastReply.stats_id,
        email_body: emailHtml,
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

    // ?action=invite&email=lead@x.com&start=<unix>&host=naufal@koldifyleads.co
    // Creates the calendar event on the host's own calendar with a Google Meet
    // link, and emails the invite to the lead.
    if (action === "invite") {
      const { email, start, host } = req.query;
      if (!email || !start) return res.status(400).json({ error: "Need email and start (unix seconds)" });
      const startTime = Number(start);
      const durationMin = Number(req.query.duration || process.env.MEETING_MINUTES || 30);
      let lead = null;
      try { lead = await leadByEmail(email); } catch { /* invite can still go out */ }
      const leadName = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ");
      const grant = await getGrantFor(host);
      const title = req.query.title ||
        `Koldify <> ${leadName || email}${lead?.company_name ? ` (${lead.company_name})` : ""}`;
      const event = await createEvent({
        startTime,
        endTime: startTime + durationMin * 60,
        title,
        leadEmail: email,
        leadName,
        description: "Introductory call.",
        hostEmail: host,
      });
      return res.status(200).json({
        booked: true,
        host: grant.email,
        lead: email,
        leadName,
        when: formatSlot(startTime, req.query.tz || process.env.TIMEZONE || "America/New_York"),
        leadLocal: req.query.for ? formatSlot(startTime, req.query.for) : undefined,
        conferencing: event.data?.conferencing || null,
        eventId: event.data?.id || null,
      });
    }

    // ?action=cancel-event&event=<id>&host=<email>
    if (action === "cancel-event") {
      const { event, host } = req.query;
      if (!event) return res.status(400).json({ error: "Need event id" });
      await cancelEvent(event, host);
      return res.status(200).json({ cancelled: true, event, host: host || "(default grant)" });
    }

    // ?action=sends&from=YYYY-MM-DD&to=YYYY-MM-DD  — volume in a real date window
    if (action === "sends") {
      const from = req.query.from, to = req.query.to;
      if (!from || !to) return res.status(400).json({ error: "Need from and to (YYYY-MM-DD)" });
      // ?raw=1&campaign_id=x dumps the untouched payload so the shape can be read
      if (req.query.raw === "1") {
        const cid = req.query.campaign_id || "3721834";
        const a = await analyticsByDate(cid, from, to);
        return res.status(200).json({ campaignId: cid, keys: Object.keys(a || {}), raw: a });
      }
      const all = await listCampaigns();
      const list = Array.isArray(all) ? all : all.campaigns || [];
      const live = list.filter((c) => c.status !== "DRAFTED");

      const per = await Promise.all(live.map(async (c) => {
        try {
          // Returns one summary object for the window, not a row per day.
          const a = await analyticsByDate(String(c.id), from, to);
          const n = (v) => Number(v || 0);
          return {
            id: String(c.id), name: c.name, status: c.status,
            sent: n(a.sent_count),
            uniqueSent: n(a.unique_sent_count),
            replies: n(a.reply_count),
            bounces: n(a.bounce_count),
            unsubscribes: n(a.unsubscribed_count),
            replyRate: n(a.sent_count) ? +(n(a.reply_count) / n(a.sent_count) * 100).toFixed(2) : 0,
            bounceRate: n(a.sent_count) ? +(n(a.bounce_count) / n(a.sent_count) * 100).toFixed(2) : 0,
          };
        } catch (e) {
          return { id: String(c.id), name: c.name, status: c.status, error: e.message.slice(0, 200) };
        }
      }));
      const ok = per.filter((x) => !x.error);
      return res.status(200).json({
        window: { from, to },
        totalSent: ok.reduce((n, x) => n + x.sent, 0),
        totalReplies: ok.reduce((n, x) => n + x.replies, 0),
        totalBounces: ok.reduce((n, x) => n + x.bounces, 0),
        campaigns: per.sort((a, b) => (b.sent || 0) - (a.sent || 0)),
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

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Rough timezone from the lead record, so proposed times land in their day.
const TZ_BY_COUNTRY = {
  india:"Asia/Kolkata", "united arab emirates":"Asia/Dubai", uae:"Asia/Dubai",
  "saudi arabia":"Asia/Riyadh", egypt:"Africa/Cairo", nigeria:"Africa/Lagos",
  indonesia:"Asia/Makassar", poland:"Europe/Warsaw", italy:"Europe/Rome",
  finland:"Europe/Helsinki", netherlands:"Europe/Amsterdam", germany:"Europe/Berlin",
  austria:"Europe/Vienna", ireland:"Europe/Dublin", "united kingdom":"Europe/London",
  brazil:"America/Sao_Paulo", mexico:"America/Mexico_City", "costa rica":"America/Costa_Rica",
  canada:"America/Toronto", australia:"Australia/Sydney", singapore:"Asia/Singapore",
  "south africa":"Africa/Johannesburg", ghana:"Africa/Accra", bulgaria:"Europe/Sofia",
  pakistan:"Asia/Karachi", "united states":"America/New_York",
};
function guessTimezone(lead) {
  const loc = String(lead?.location || "").toLowerCase();
  for (const [k, tz] of Object.entries(TZ_BY_COUNTRY)) if (loc.includes(k)) return tz;
  const tld = String(lead?.email || "").split(".").pop().toLowerCase();
  const byTld = { in:"Asia/Kolkata", ae:"Asia/Dubai", sa:"Asia/Riyadh", pl:"Europe/Warsaw",
    it:"Europe/Rome", fi:"Europe/Helsinki", de:"Europe/Berlin", uk:"Europe/London",
    br:"America/Sao_Paulo", mx:"America/Mexico_City", id:"Asia/Makassar", ng:"Africa/Lagos" };
  return byTld[tld] || process.env.TIMEZONE || "America/New_York";
}
