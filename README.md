# SendKit Reply Classifier

Automatically classifies every reply to your SendKit campaigns into one of six categories and tags the conversation in your SendKit inbox. Optionally logs every classified reply to a Google Sheet.

Categories: **Interested · Meeting Request · More Info Needed · Objection · Pricing Question · Timing Issue**

How it works: SendKit fires an `email.replied` webhook → this app (one Vercel serverless function) reads the reply, classifies it with Claude Haiku (~$0.0002 per reply), tags the conversation via the SendKit API, and appends a row to your sheet.

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
| `SHEETS_WEBHOOK_URL` | (optional, see step 4) |

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

Sanity-check the classifier directly:

```
https://YOUR-APP.vercel.app/api/classify-test?key=YOUR_SETUP_SECRET&text=How much does this cost per month?
```

Expected: `{"category":"Pricing Question", ...}`

Then use SendKit's webhook **Send test payload** button, or wait for a real reply. Check Vercel → your project → Logs to watch it run.

## Notes

- Auto-replies, out-of-office, and unsubscribes are classified "None" and left untagged (still logged to the sheet).
- The webhook always returns 200 to avoid endless SendKit retries; errors show up in Vercel logs.
- Free-tier friendly: Vercel Hobby covers this workload easily; the only per-reply cost is the Claude call.
- Keep keys in Vercel env vars only — never commit them.
