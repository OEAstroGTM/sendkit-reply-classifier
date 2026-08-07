// Shared touch ledger, stored as a file in the repo and read/written at
// runtime through the GitHub contents API. Serverless instances do not share
// memory, so four LinkedIn accounts working the same list need one source of
// truth or they will contact the same person twice.

const REPO = process.env.LEDGER_REPO || "OEAstroGTM/sendkit-reply-classifier";
const PATH = process.env.LEDGER_PATH || "drafts/linkedin-touches.json";

function token() {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error("GITHUB_TOKEN env var is not set");
  return t;
}

async function gh(method, url, body) {
  // Fail fast rather than letting the function sit until the platform kills it,
  // which returns an empty body and hides whatever actually went wrong.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `GitHub ${method} timed out after 8s` : `GitHub ${method} failed: ${e.message}`);
  } finally { clearTimeout(timer); }
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`GitHub ${method} ${res.status}: ${text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return JSON.parse(text);
}

const api = () => `https://api.github.com/repos/${REPO}/contents/${PATH}`;

export async function readLedger() {
  const j = await gh("GET", `${api()}?ref=main&t=${Date.now()}`);
  const raw = Buffer.from(j.content || "", "base64").toString("utf8");
  let parsed; try { parsed = JSON.parse(raw); } catch { parsed = { touches: [] }; }
  return { sha: j.sha, data: parsed };
}

export async function addTouch(entry) {
  const { sha, data } = await readLedger();
  data.touches = data.touches || [];
  // Idempotent: the same account contacting the same lead twice is one record
  const already = data.touches.find(
    (t) => t.email?.toLowerCase() === entry.email.toLowerCase()
  );
  if (already) return { added: false, existing: already, total: data.touches.length };
  data.touches.push({ ...entry, at: new Date().toISOString() });
  await gh("PUT", api(), {
    message: `LinkedIn touch: ${entry.email} by ${entry.account}`,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"),
    sha,
    branch: "main",
  });
  return { added: true, total: data.touches.length };
}
// redeploy 2026-08-07T18:22:48Z
