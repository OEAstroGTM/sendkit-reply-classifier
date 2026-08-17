// GET/POST /api/book — retired 17 Aug 2026.
//
// This endpoint wrote to Nylas calendars. Two things killed it:
//
// 1. Corporate mail scanners (Mimecast, Proofpoint, Barracuda, SafeLinks) fetch
//    every link in an inbound message. When booking happened on GET they
//    silently booked every proposed slot and mailed leads invites they never
//    asked for — 58 phantom events over five days.
// 2. It booked across a fixed participant list that still included someone who
//    has left the company.
//
// Booking is Calendly now. This stays alive and redirects rather than 404s,
// because links to it are sitting in emails already delivered to real people.
// A dead link there is a lost meeting.

import { safeBookingLink } from "../lib/calendly.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const p = { ...req.query, ...(req.body || {}) };
  const email = p.e || p.email || "";
  const name = p.n || p.name || "";

  const link = await safeBookingLink({ name, email });
  if (link) {
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, link);
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(`<!doctype html><meta charset="utf-8">
<title>Pick a time</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#1b1f27}h1{font-size:1.3rem;font-weight:500}
p{color:#5c6472}</style>
<h1>Let's find a time</h1>
<p>This booking link has expired. Reply to the email and we'll sort out a slot.</p>`);
}
