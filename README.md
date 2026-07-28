# SendKit Reply Agent

Classifies every reply to your SendKit campaigns, tags the conversation, and answers positive replies with a personalized email proposing real open times from your calendar (via Nylas).

Categories: **Interested · Meeting Request · More Info Needed · Objection · Pricing Question · Timing Issue**

Behavior per category (configurable via env vars):

| Category | Action |
|---|---|
| Meeting Request | Tag + AI reply with calendar times, **sent automatically** |
| Interested, More Info Needed, Pricing Question | Tag + AI reply with calendar times, **saved as draft** for your review |
| Objection, Timing Issue | Tag only |

How it works: SendKit fires an `email.replied` webhook → this app (Vercel serverless) classifies the reply with Claude Haiku, tags the conversation, pulls free slots from your calendar via the Nylas Availability API, has Claude write a short reply offering 3 times, then sends it or saves it as a draft. Every event is logged to a Google Sheet.

**Nylas prerequisite:** in the [Nylas dashboard](https://dashboard-v3.nylas.com), connect the calendar account you book meetings on (creates a "grant"). The app auto-detects it.

## Deploy (about 10 minutes)

### 1. Put this repo on GitHub

Create a new repository at github.com/new (private is fine), then from this folder:

```bash
git init
git add .
git commit -m "SendKit reply classifier"
git remote add origin https://github.com/YOUR_USERNAME/sendkit-reply-classifier.git
git push -u origin main
```

### 2. Deploy to Vercel

Go to vercel.com/new, import the GitHub repo, and before clicking Deploy add these Environment Variables:

| Variable | Value |
|---|---|
| `SENDKIT_API_KEY` | your SendKit workspace key (`sk_...`) |
| `ANTHROPIC_API_KEY` | your Anthropic key from console.anthropic.com |
| `SETUP_SECRET` | any random string you make up |
| `NYLAS_API_KEY` | your Nylas key (`nyk_...`) — enables AI replies with times |
| `SENDER_NAME` | the name to sign replies with, e.g. `Astro` |
| `COMPANY_URL` | overview link included in replies, e.g. `http://www.kold-mail-works.com` |
| `TIMEZONE` | e.g. `America/New_York` (default) |
| `PRODUCT_NOTES` | (optional) facts the AI may use for info/pricing answers |
| `SHEETS_WEBHOOK_URL` | (optional, see step 4) |

See `.env.example` for all knobs (work hours, meeting length, which categories auto-send, etc.).

Click Deploy. You'll get a URL like `https://sendkit-reply-classifier.vercel.app`.

### 3. Run the one-time setup

Open in your browser (using your own values):

```
https://YOUR-APP.vercel.app/api/setup?key=YOUR_SETUP_SECRET
```

This verifies your SendKit key, creates the 6 tags in your workspace, and registers the `email.replied` webhook pointing back at this app. The response includes a generated webhook secret — add it in Vercel as `SENDKIT_WEBHOOK_SECRET` and redeploy so incoming webhooks are signature-verified. Set `STRICT_SIGNATURE=true` once you confirm real webhooks pass.

### 4. Google Sheet logging (optional)

Follow the instructions at the top of `apps-script/sheet-logger.gs` (5 minutes: paste script into a Google Sheet, deploy as web app, copy the URL into the `SHEETS_WEBHOOK_URL` env var, redeploy).

### 5. Test it

Sanity-check the classifier:

```
https://YOUR-APP.vercel.app/api/classify-test?key=YOUR_SETUP_SECRET&text=How much does this cost per month?
```

Expected: `{"category":"Pricing Question", ...}`

Preview a full AI reply (pulls real availability, sends nothing):

```
https://YOUR-APP.vercel.app/api/reply-test?key=YOUR_SETUP_SECRET&name=Greg&text=Sounds good, happy to chat next week
```

Then use SendKit's webhook **Send test payload** button, or wait for a real reply. Check Vercel → your project → Logs to watch it run.

## Notes

- Auto-replies, out-of-office, and unsubscribes are classified "None" and left untagged (still logged to the sheet).
- The webhook always returns 200 to avoid endless SendKit retries; errors show up in Vercel logs.
- Free-tier friendly: Vercel Hobby covers this workload easily; the only per-reply cost is the Claude call.
- Keep keys in Vercel env vars only — never commit them.
