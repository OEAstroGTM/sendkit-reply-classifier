// GET /api/smartlead?key=...&action=campaigns
// GET /api/smartlead?key=...&action=audit&campaign_id=123[&max=60][&offset=0]
//     Separates genuine human replies from autoresponders/bounces and returns
//     a compact list with the lead's own words.
// GET /api/smartlead?key=...&action=thread&campaign_id=123&email=lead@x.com

import {
  listCampaigns, campaignStats, leadByEmail, messageHistory,
  replyToLead, unsubscribeLead, analyticsByDate, addLeadsToCampaign, isMachineReply, isOptOut, isDecline, ownWords, clearCache, setFresh,
} from "../lib/smartlead.js";
import { RateLimitError } from "../lib/limiter.js";
import { toHtml, generateReply, generateBump } from "../lib/reply.js";
import { linkifySlots } from "../lib/booking.js";
import { readLedger, addTouch } from "../lib/ledger.js";
import { createEvent, cancelEvent, formatSlot, getGrantFor, listEvents } from "../lib/nylas.js";
import batch from "../drafts/smartlead-batch.json" with { type: "json" };
import holdList from "../drafts/followup-hold.json" with { type: "json" };
import restartList from "../drafts/followup-restart.json" with { type: "json" };

export const config = { maxDuration: 60 };

// Every campaign that can hold a live conversation. DRAFTED never sent and
// ARCHIVED is finished; PAUSED still holds open threads, so it stays in.
let _cidCache = { at: 0, ids: [] };
async function liveCampaignIds() {
  if (Date.now() - _cidCache.at < 300000 && _cidCache.ids.length) return _cidCache.ids;
  const list = await listCampaigns();
  const ids = (Array.isArray(list) ? list : list?.data || [])
    .filter((c) => c.status !== "DRAFTED" && c.status !== "ARCHIVED")
    .map((c) => String(c.id));
  if (ids.length) _cidCache = { at: Date.now(), ids };
  return ids;
}

export default async function handler(req, res) {
  if (!process.env.SETUP_SECRET || req.query.key !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const action = req.query.action || "campaigns";
  // ?fresh=1 forces a re-read instead of using the cached responses. setFresh
  // also bypasses the shared Redis tier for this request, then resets next call.
  setFresh(req.query.fresh === "1");

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
      // Restarted leads count bumps from the restart point, not from zero,
      // so an exhausted sequence can be reopened without losing the history.
      const RESTART = new Map((restartList.restart || [])
        .map((r) => [r.email.toLowerCase(), Number(r.bumpsAtRestart || 0)]));
      // Nothing goes out at the weekend. Availability is Mon-Thu and Sundays are closed.
      const dow = new Date().getUTCDay();
      const sendingDay = dow >= 1 && dow <= 5;

      // One flat queue across every campaign. Scoping this per campaign meant
      // the unscoped call walked them sequentially and timed out, so in practice
      // it was only ever run against one or two and the rest went unchecked.
      // Collect candidates from all campaigns first (cheap stats reads), then
      // page the expensive thread reads with ?skip= and ?limit=.
      const candidates = [];
      await Promise.all(ids.map(async (id) => {
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
        for (const r of rows) {
          if (!POSITIVE.has(r.lead_category)) continue;
          if (sinceMs && new Date(r.reply_time).getTime() < sinceMs) continue;
          candidates.push({ ...r, __campaign: String(id) });
        }
      }));
      // Freshest conversations first, so a truncated run still covers what matters.
      candidates.sort((a, b) => new Date(b.reply_time) - new Date(a.reply_time));

      const skip = Math.max(0, Number(req.query.skip || 0));
      const limit = Math.min(Number(req.query.limit || 30), 60);
      const window = candidates.slice(skip, skip + limit);
      const failed = [];

      const out = [];
      {
        const checked = await Promise.all(window.map(async (r) => {
          const id = r.__campaign;
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
            const rawBumps = Math.max(0, outboundSince - 1);        // first one was the actual answer
            const bumpsSent = Math.max(0, rawBumps - (RESTART.get(lead.email.toLowerCase()) || 0));
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
              restarted: RESTART.has(lead.email.toLowerCase()) || undefined,
              exhausted: bumpsSent >= maxBumps,
              hold: HOLD.get(lead.email.toLowerCase()) || null,
              due: !HOLD.has(lead.email.toLowerCase()) && sendingDay &&
                   bumpsSent < maxBumps && nextBumpAt !== undefined && daysQuiet >= nextBumpAt,
              nextBumpInDays: nextBumpAt === undefined ? null : +Math.max(0, nextBumpAt - daysQuiet).toFixed(1),
            };
          } catch (e) {
            // Never swallow. A rate-limited thread read used to delete the lead
            // from the count, so "0 due" could mean "nothing owed" or "we could
            // not look". Those are very different answers.
            return { __failed: true, email: r.lead_email, campaign_id: id, error: String(e.message || e).slice(0, 160) };
          }
        }));
        for (const f of checked.filter((x) => x && x.__failed)) failed.push(f);
        out.push(...checked.filter((x) => x && !x.__failed));
      }

      out.sort((a, b) => b.daysQuiet - a.daysQuiet);
      return res.status(200).json({
        schedule: bumpDays,
        sendingDay,
        campaignsScanned: ids.length,
        candidatesTotal: candidates.length,
        skip,
        // Anything left unread means the counts below are a floor, not a total.
        moreToScan: candidates.length > skip + limit || failed.length > 0,
        failedCount: failed.length,
        failed,
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

      // Cap raised from 120: campaign 3781785 alone holds 146 replies, so the
      // old ceiling made full coverage impossible however you paged it.
      const max = Math.min(Number(req.query.max || 60), 400);
      const perCampaign = Math.min(Number(req.query.threads || 25), 40);
      // Thread reads are the slow part, so a single call can only inspect a
      // slice before the function times out. ?skip=N walks further down the
      // candidate list, which lets several calls cover a campaign completely
      // instead of silently reporting a clean queue on a truncated view.
      const skip = Math.max(0, Number(req.query.skip || 0));
      const awaiting = [], optouts = [], declines = [], failed = [];
      let scanned = 0, instantMachines = 0, candidatesTotal = 0;
      let repliesTotal = 0, truncated = false;

      // Campaigns are read in parallel. Walking them sequentially meant the
      // unscoped call timed out once the account had more than a couple of
      // live campaigns, which is why the board only ever called it with a
      // small max and quietly showed a fraction of the queue.
      const machineFloor = Number(process.env.MACHINE_DELAY_SECONDS || 15);
      const candidates = [];
      await Promise.all(ids.map(async (id) => {
        // Records come back in internal lead-id order, NOT reply order, so
        // reading the tail misses recent replies from leads added earlier.
        // Four interested leads were invisible for hours because of exactly
        // that. Page the whole replied set, then sort by reply_time.
        const probe = await campaignStats(id, { email_status: "replied", limit: "1", offset: "0" });
        const total = Number(probe.total_stats || 0);
        const pageSize = 100;
        const pages = Math.min(Math.ceil(total / pageSize), 8);
        const all = [];
        for (let p = 0; p < pages; p++) {
          const page = await campaignStats(id, {
            email_status: "replied", limit: String(pageSize), offset: String(p * pageSize),
          });
          const r = page.data || [];
          if (!r.length) break;
          all.push(...r);
        }
        const sorted = all.sort((a, b) => new Date(b.reply_time) - new Date(a.reply_time));
        // `max` truncates the reply set before anything else runs. A campaign
        // with 200 replies scanned at max=40 used to report a clean queue on
        // the strength of 40 records and say nothing about the other 160.
        repliesTotal += sorted.length;
        if (sorted.length > max) truncated = true;
        const rows = sorted.slice(0, max);
        scanned += rows.length;

        // Cheap pre-filter before spending two API calls on a thread. Kept
        // deliberately low: people do reply inside a minute from a phone.
        for (const r of rows) {
          const delay = (new Date(r.reply_time) - new Date(r.sent_time)) / 1000;
          if (delay < machineFloor) { instantMachines++; continue; }
          candidates.push({ ...r, __campaign: String(id), delaySeconds: Math.round(delay) });
        }
      }));

      // One queue across every campaign, newest first, so skip/threads page the
      // whole account rather than each campaign separately.
      candidates.sort((a, b) => new Date(b.reply_time) - new Date(a.reply_time));
      candidatesTotal = candidates.length;

      {
        const window = candidates.slice(skip, skip + perCampaign);
        const checked = await Promise.all(window.map(async (c) => {
          const id = c.__campaign;
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
          } catch (e) {
            // Never swallow this. A 429 or a timeout here used to delete the
            // lead from the report entirely: no entry, no count, no warning.
            // That is how five leads sat unanswered in a campaign that was
            // reporting awaitingCount: 1.
            return { __failed: true, email: c.lead_email, error: String(e.message || e).slice(0, 160) };
          }
        }));

        for (const f of checked.filter((x) => x && x.__failed)) failed.push(f);
        for (const x of checked.filter((x) => x && !x.__failed)) {
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
        skip,
        // True when anything was left unread: candidates past this slice, or
        // replies cut off by `max`, or threads that failed to load. Any one of
        // those means the queue below is incomplete and must not be read as
        // "nothing is waiting".
        moreToScan: candidatesTotal > skip + perCampaign || truncated || failed.length > 0,
        candidatesTotal,
        repliesTotal,
        truncated,
        instantMachines,
        // Threads that could not be read this pass, usually rate limiting.
        // Re-run for these specifically rather than assuming they are clean.
        failedCount: failed.length,
        failed,
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
          // ?when=ISO schedules instead of sending now, for leads who told us
          // when they are back rather than going quiet.
          const when = req.query.when;
          const r = await replyToLead(d.campaign_id, {
            email_stats_id: lastReply.stats_id,
            email_body: emailHtml,
            reply_message_id: lastReply.message_id,
            reply_email_time: lastReply.time,
            to_email: lead.email,
            to_first_name: lead.first_name || "",
            to_last_name: lead.last_name || "",
            add_signature: false,
            // Colleagues to bring onto the thread, from the draft or ?cc=
            ...((d.cc || req.query.cc) ? { cc: d.cc || req.query.cc } : {}),
            ...(when ? { scheduled_time: when } : {}),
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
      const alsoInvite = (req.query.with || "").split(",").map((x) => x.trim()).filter(Boolean);
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
        alsoInvite,
      });
      return res.status(200).json({
        booked: true,
        host: grant.email,
        alsoInvited: alsoInvite,
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
      // notify=0 removes it without mailing the lead a cancellation, which is
      // what you want when the meeting is being moved to another host and a
      // fresh invite has already gone out.
      const notifyCancel = req.query.notify !== "0";
      await cancelEvent(event, host, notifyCancel);
      return res.status(200).json({ cancelled: true, event, notified: notifyCancel, host: host || "(default grant)" });
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

    // ?action=add-lead&campaign_id=..&email=..&first_name=..&company=..
    // Used when a lead tells us we have the wrong address: the existing thread
    // is dead, so the corrected address has to enter the sequence as a new lead.
    if (action === "add-lead") {
      const { campaign_id, email } = req.query;
      if (!campaign_id || !email) return res.status(400).json({ error: "Need campaign_id and email" });
      const lead = {
        email,
        first_name: req.query.first_name || "",
        last_name: req.query.last_name || "",
        company_name: req.query.company || "",
      };
      const result = await addLeadsToCampaign(campaign_id, {
        lead_list: [lead],
        settings: {
          ignore_global_block_list: false,
          ignore_unsubscribe_list: false,
          ignore_duplicate_leads_in_other_campaign: false,
        },
      });
      return res.status(200).json({ added: lead, campaign_id, result });
    }

    // ?action=slack-react&channel=C..&ts=..&emoji=white_check_mark
    // ?action=slack-react&channel=C..&match=email@x.com&emoji=..   (finds the message)
    // The Claude Slack connector cannot write to externally shared (Slack Connect)
    // channels, so reactions go through a native bot token instead.
    if (action === "slack-react") {
      // Always answers 200: non-200 bodies come back empty through some
      // clients, which hides the actual Slack error.
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return res.status(200).json({ ok: false, error: "SLACK_BOT_TOKEN env var is not set" });
      const channel = req.query.channel || process.env.SLACK_CHANNEL_ID;
      const emoji = req.query.emoji || "white_check_mark";
      if (!channel) return res.status(200).json({ ok: false, error: "Need channel" });

      const slack = async (method, params) => {
        const r = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        return r.json();
      };

      // Resolve a timestamp: either given directly, or by finding the newest
      // message whose text contains `match` (an email works well).
      // `ts` gets stripped by some HTTP clients, so accept aliases too
      let stamps = String(req.query.stamp || req.query.ts || req.query.mts || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      if (!stamps.length && req.query.match) {
        const hist = await slack("conversations.history", { channel, limit: "200" });
        if (!hist.ok) return res.status(200).json({ ok: false, error: `slack conversations.history: ${hist.error}` });
        const needles = req.query.match.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        stamps = (hist.messages || [])
          .filter((m) => needles.some((n) => String(m.text || "").toLowerCase().includes(n)))
          .map((m) => m.ts);
      }
      if (!stamps.length) return res.status(200).json({ ok: false, error: "No matching messages in the last 200" });

      const results = [];
      for (const ts of stamps) {
        const r = await slack("reactions.add", { channel, timestamp: ts, name: emoji });
        results.push({ ts, ok: r.ok, error: r.error || null });
      }
      return res.status(200).json({
        ok: true, channel, emoji,
        reacted: results.filter((x) => x.ok).length,
        alreadyDone: results.filter((x) => x.error === "already_reacted").length,
        failed: results.filter((x) => !x.ok && x.error !== "already_reacted"),
        results,
      });
    }

    // ?action=card&campaign_id=..&email=..   -> clean screenshot-ready thread
    // ?action=card                             -> today's LinkedIn target list
    // Both render HTML so a browser agent can read or capture them directly.
    if (action === "card") {
      const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const shell = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(title)}</title><style>
body{margin:0;background:#fff;color:#111;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
.wrap{width:680px;margin:0 auto;padding:28px}
h1{font-size:17px;margin:0 0 4px}.sub{color:#6b7280;font-size:13px;margin-bottom:18px}
.msg{border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:10px}
.msg.them{background:#f6f8fb;border-color:#d8e0ec}
.who{font-weight:600;font-size:13px}.when{color:#8b90a0;font-size:12px;float:right}
.body{margin-top:8px;white-space:pre-wrap;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:#6b7280;font-weight:500;padding:7px 8px;border-bottom:1px solid #e5e7eb}
td{padding:9px 8px;border-bottom:1px solid #f0f2f5;vertical-align:top}
a{color:#1a56db}
</style></head><body><div class="wrap">${body}</div></body></html>`;

      const { campaign_id, email } = req.query;

      // --- single thread, rendered for screenshotting ---
      if (email) {
        const cid = campaign_id || "3762048";
        const lead = await leadByEmail(email);
        const hist = await messageHistory(cid, lead.id);
        const msgs = (hist.history || []).filter((m) => ownWords(m.email_body));
        const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email;
        const rows = msgs.map((m) => {
          const them = m.type === "REPLY";
          const who = them ? name : (m.from || "").split("@")[0].split(".").map(
            (x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ");
          const when = m.time ? new Date(m.time).toLocaleString("en-US",
            { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
          return `<div class="msg ${them ? "them" : ""}">
            <span class="who">${esc(who)}</span><span class="when">${esc(when)}</span>
            <div class="body">${esc(ownWords(m.email_body).slice(0, 900))}</div></div>`;
        }).join("");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(shell(`${name} thread`,
            `<h1>${esc(name)}${lead.company_name ? ` · ${esc(lead.company_name)}` : ""}</h1>
             <div class="sub">${esc(lead.email)}</div>${rows}`));
      }

      // --- the day's LinkedIn targets: positive, answered, gone quiet ---
      const ids = (req.query.campaign_id || "3762048").split(",").map((x) => x.trim());
      const minDays = Number(req.query.mindays || 2);
      const HOLD = new Set(holdList.hold.map((h) => h.email.toLowerCase()));
      // Anyone already contacted on LinkedIn drops off the list entirely
      let TOUCHED = new Set();
      try {
        const { data } = await readLedger();
        TOUCHED = new Set((data.touches || []).map((x) => String(x.email).toLowerCase()));
      } catch { /* no token yet, fall back to showing everyone */ }
      const POSITIVE = new Set(["Interested", "Meeting Request", "Information Request"]);
      const out = [];
      for (const id of ids) {
        const probe = await campaignStats(id, { email_status: "replied", limit: "1", offset: "0" });
        const total = Number(probe.total_stats || 0);
        const all = [];
        for (let p = 0; p < Math.min(Math.ceil(total / 100), 8); p++) {
          const page = await campaignStats(id, { email_status: "replied", limit: "100", offset: String(p * 100) });
          const r = page.data || []; if (!r.length) break; all.push(...r);
        }
        const rows = all.filter((r) => POSITIVE.has(r.lead_category))
          .sort((a, b) => new Date(b.reply_time) - new Date(a.reply_time)).slice(0, 40);
        const checked = await Promise.all(rows.map(async (r) => {
          try {
            const key = String(r.lead_email).toLowerCase();
            if (HOLD.has(key) || TOUCHED.has(key)) return null;
            const lead = await leadByEmail(r.lead_email);
            if (lead.is_unsubscribed) return null;
            const hist = await messageHistory(id, lead.id);
            const m = hist.history || [];
            const last = m[m.length - 1];
            if (!last || last.type === "REPLY") return null;   // still our turn
            const quiet = (Date.now() - new Date(last.time).getTime()) / 86400000;
            if (quiet < minDays) return null;
            const firstReply = m.find((x) => x.type === "REPLY");
            const persona = (firstReply?.to || "").split("@")[0].split(".")[0];
            const Persona = persona ? persona.charAt(0).toUpperCase() + persona.slice(1) : "my colleague";
            return {
              name: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email,
              first: lead.first_name || "",
              company: lead.company_name || "", email: lead.email,
              persona: Persona,
              days: quiet.toFixed(1), campaign_id: id,
            };
          } catch { return null; }
        }));
        out.push(...checked.filter(Boolean));
      }
      out.sort((a, b) => Number(b.days) - Number(a.days));
      const base = `https://${req.headers.host}/api/smartlead?key=${encodeURIComponent(req.query.key)}&action=card`;
      const line = (x) => `Hi ${x.first || x.name.split(" ")[0]}, my coworker ${x.persona} emailed you `
        + `about ${x.company || "your business"} and we're trying to get some time on the books. `
        + `Let me know if we can do it here, might be faster.`;
      const body = `<h1>LinkedIn targets</h1>
        <div class="sub">Positive replies we answered that have been quiet ${minDays}+ days. ${out.length} today.
        Use the message exactly as written, the coworker name changes per lead.</div>
        <table><tr><th>Name</th><th>Company</th><th>Quiet</th><th>Message to send</th><th>Thread</th></tr>` +
        (out.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.company)}</td><td>${esc(x.days)}d</td>
          <td>${esc(line(x))}</td>
          <td><a href="${base}&campaign_id=${esc(x.campaign_id)}&email=${encodeURIComponent(x.email)}">open thread</a></td></tr>`).join("")
          || `<tr><td colspan="5">Nobody due.</td></tr>`) + `</table>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(shell("LinkedIn targets", body));
    }

    // ?action=touched&email=..&account=..[&note=..]  — record a LinkedIn touch
    // ?action=touches                                 — read the ledger
    if (action === "touched") {
      const { email, account } = req.query;
      // Always answers 200 so the caller (and a browser agent) can read what
      // happened instead of getting an opaque failure.
      if (!email || !account) return res.status(200).json({ ok: false, error: "Need email and account" });
      try {
        const r = await addTouch({
          email, account,
          name: req.query.name || "",
          company: req.query.company || "",
          note: req.query.note || "",
        });
        return res.status(200).json({ ok: true, ...r });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message });
      }
    }
    if (action === "touches") {
      const { data } = await readLedger();
      const byAccount = {};
      for (const x of data.touches || []) byAccount[x.account] = (byAccount[x.account] || 0) + 1;
      return res.status(200).json({ total: (data.touches || []).length, byAccount, touches: data.touches || [] });
    }

    // ?action=slack-sync[&channel=..][&max=25][&skip=0][&dry=1]
    // Reads the lead-notification channel, works out which leads we have
    // already answered, and ticks those messages. No list to pass in, which
    // matters because comma-separated params get stripped in transit.
    if (action === "slack-sync") {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return res.status(200).json({ ok: false, error: "SLACK_BOT_TOKEN env var is not set" });
      const channel = req.query.channel || process.env.SLACK_CHANNEL_ID;
      if (!channel) return res.status(200).json({ ok: false, error: "Need channel" });
      const emoji = req.query.emoji || "white_check_mark";
      const max = Math.min(Number(req.query.max || 25), 60);
      const skip = Math.max(0, Number(req.query.skip || 0));
      const dry = req.query.dry === "1";
      const HOLD = new Map(holdList.hold.map((h) => [h.email.toLowerCase(), h.reason]));

      const slack = async (method, params) => {
        const r = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        return r.json();
      };
      const hist = await slack("conversations.history", { channel, limit: "200" });
      if (!hist.ok) return res.status(200).json({ ok: false, error: `slack history: ${hist.error}` });

      // One notification per lead; keep the newest message per email
      const seen = new Map();
      for (const m of hist.messages || []) {
        const mail = (String(m.text || "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];
        if (!mail) continue;
        const key = mail.toLowerCase().replace(/[|>].*$/, "");
        const done = (m.reactions || []).some((r) => r.name === emoji);
        if (!seen.has(key)) seen.set(key, { ts: m.ts, done });
      }
      const all = [...seen.entries()];
      const window = all.slice(skip, skip + max);

      const out = await Promise.all(window.map(async ([email, info]) => {
        if (info.done) return { email, skipped: "already ticked" };
        if (HOLD.has(email)) return { email, skipped: `held: ${HOLD.get(email)}` };
        try {
          const lead = await leadByEmail(email);
          if (!lead?.id) return { email, skipped: "lead not found" };
          // A lead can sit in any campaign, so try each until a thread appears.
          // Never hardcode this list: new campaigns appear without warning and a
          // stale default silently skips every lead inside them.
          const tryIds = req.query.campaigns
            ? String(req.query.campaigns).split(",")
            : await liveCampaignIds();
          let msgs = [];
          for (const cid of tryIds) {
            try {
              const h2 = await messageHistory(cid.trim(), lead.id);
              if ((h2.history || []).length) { msgs = h2.history; break; }
            } catch { /* not in this campaign */ }
          }
          const last = msgs[msgs.length - 1];
          if (!last) return { email, skipped: "no thread in any campaign" };
          if (last.type === "REPLY") return { email, skipped: "still awaiting our reply" };
          return { email, ts: info.ts, answered: true };
        } catch (e) { return { email, skipped: `lookup failed: ${e.message.slice(0, 60)}` }; }
      }));

      const toTick = out.filter((x) => x.answered);
      let ticked = 0;
      if (!dry) {
        for (const x of toTick) {
          const r = await slack("reactions.add", { channel, timestamp: x.ts, name: emoji });
          if (r.ok || r.error === "already_reacted") ticked++;
          else x.error = r.error;
        }
      }
      return res.status(200).json({
        ok: true, channel, emoji, dry,
        leadsInChannel: all.length, inspected: window.length,
        moreToScan: all.length > skip + max,
        ticked, wouldTick: toTick.length,
        detail: out,
      });
    }

    // GET/POST ?action=unsubscribe&email=...  — global suppression
    // Audits what is actually on a calendar, and can bulk-cancel the phantom
    // bookings created when /api/book still wrote on GET (mail security
    // scanners fetched every proposed slot link and booked all of them).
    // ?action=events&host=x@y.com&days=30[&match=the team <>][&cancel=1]
    if (action === "events") {
      const days = Math.min(Number(req.query.days || 30), 120);
      const start = Math.floor(Date.now() / 1000) - 3600;
      const end = start + days * 86400;
      const host = req.query.host || "";
      const match = req.query.match || "the team <>";
      const doCancel = req.query.cancel === "1";
      try {
        const { grant, events } = await listEvents({ hostEmail: host, start, end, limit: 200 });
        const rows = events.map((ev) => ({
          id: ev.id,
          title: ev.title || "",
          start: ev.when?.start_time || null,
          label: ev.when?.start_time ? formatSlot(ev.when.start_time, process.env.TIMEZONE || "America/New_York") : null,
          created: ev.created_at || null,
          participants: (ev.participants || []).map((x) => x.email),
          phantom: String(ev.title || "").startsWith(match),
        })).sort((a, b) => (a.start || 0) - (b.start || 0));
        const phantoms = rows.filter((r) => r.phantom);
        // A person books one time. A lead holding two or more slots was booked
        // by a link scanner, so those are safe to remove. minDupes=1 removes
        // singles too, which risks cancelling a real self-service booking.
        const minDupes = Math.max(1, Number(req.query.minDupes || 2));
        const perLead = new Map();
        for (const r of phantoms) {
          for (const em of r.participants) perLead.set(em, (perLead.get(em) || 0) + 1);
        }
        // A colleague on the invite means a human assigned this meeting, so it
        // is real whatever the title says. Never cancel those.
        const ours = /@koldifyleads\.(co|com)$/i;
        const keepHosted = req.query.keepHosted !== "0";
        const targets = phantoms.filter((r) =>
          r.participants.some((em) => (perLead.get(em) || 0) >= minDupes) &&
          !(keepHosted && r.participants.some((em) => ours.test(em))));
        const notify = req.query.notify !== "0";
        let cancelled = [];
        if (doCancel) {
          for (const r of targets) {
            try { await cancelEvent(r.id, host, notify); cancelled.push(r.id); }
            catch (e) { cancelled.push(`FAILED ${r.id}: ${e.message}`); }
          }
        }
        return res.status(200).json({
          ok: true, calendar: grant.email, days, match,
          total: rows.length, phantomCount: phantoms.length,
          minDupes, notify, targetCount: targets.length,
          byLead: Object.fromEntries([...perLead.entries()].sort((a, b) => b[1] - a[1])),
          cancelled: doCancel ? cancelled.length : 0,
          cancelledIds: doCancel ? cancelled : undefined,
          phantoms, events: req.query.all === "1" ? rows : undefined,
        });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message });
      }
    }

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
    // Rate limiting is expected under load — surface it as a retryable signal
    // instead of a 500 whose body some fetch clients silently drop.
    if (e instanceof RateLimitError) {
      return res.status(200).json({ ok: false, error: "rate_limited", retryAfter: e.retryAfterSec, detail: e.message });
    }
    // Answer 200 with the message so the failure is visible rather than empty.
    return res.status(200).json({ ok: false, error: e.message });
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
