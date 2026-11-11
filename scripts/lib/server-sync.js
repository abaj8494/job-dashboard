/**
 * Send classified job mail to jobs.abaj.ai, so it is filed there with no
 * review step (POST /api/email-sync, the server's auto-file path).
 *
 * Only extracted fields leave the Mac: messageId, mail date, classification,
 * confidence, company, job title, location, outbound flag. Never a subject,
 * sender, recipient or any body text.
 *
 * Results wait in ~/.jobsync/server-outbox.json until the server confirms
 * them, so a run with the server down or the Mac offline loses nothing; the
 * next run sends them. The server ignores a messageId it already has, so a
 * resend is harmless. Callers hold the classify lock, so one writer at a time.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.HOME || os.homedir();
const DEFAULT_OUTBOX = path.join(HOME, ".jobsync", "server-outbox.json");
const DEFAULT_CONFIG = path.join(HOME, ".jobsync", "config");
const EMAIL_SYNC_PATH = "/api/email-sync";
const BATCH = 25;

const JOB_TYPES = ["job_application", "job_response", "interview", "rejection", "offer", "follow_up"];

function configValue(text, name) {
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}=["']?([^"'\\n]*)["']?`, "m");
  const m = re.exec(text);
  return m ? m[1].trim() : "";
}

/**
 * Server URL and key from the environment, else ~/.jobsync/config (only
 * JOBSYNC_SERVER_SYNC, JOBSYNC_API_URL and JOBSYNC_API_KEY are read from it).
 *
 * Sending is off until JOBSYNC_SERVER_SYNC=1: the server must run the build
 * with field-only imports and auto-filing first. Until then results wait in
 * the outbox. JOBSYNC_API_URL may be the site root or the /api/email-sync URL.
 * Plain http is refused except for localhost: a redirect from http to https
 * turns a POST into a GET and every import is silently dropped.
 */
function loadServerConfig({ env = process.env, configFile = DEFAULT_CONFIG } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(configFile, "utf8");
  } catch (e) {
    // no config file
  }
  const pick = (...names) => {
    for (const n of names) if (env[n]) return String(env[n]).trim();
    for (const n of names) {
      const v = configValue(text, n);
      if (v) return v;
    }
    return "";
  };
  if (!/^(1|on|true|yes)$/i.test(pick("JOBSYNC_SERVER_SYNC"))) {
    return { ok: false, off: true, reason: "server sync off (JOBSYNC_SERVER_SYNC=1 turns it on after the deploy)" };
  }
  const url = pick("JOBSYNC_API_URL");
  const key = pick("JOBSYNC_API_KEY", "EMAIL_SYNC_API_KEY");
  if (!url || !key) return { ok: false, reason: "JOBSYNC_API_URL or JOBSYNC_API_KEY not set" };

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { ok: false, reason: "JOBSYNC_API_URL is not a URL" };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return { ok: false, reason: "JOBSYNC_API_URL must be https:// (http only for localhost)" };
  }
  const root = parsed.origin + parsed.pathname.replace(/\/+$/, "").replace(new RegExp(`${EMAIL_SYNC_PATH}$`), "");
  return { ok: true, url: root + EMAIL_SYNC_PATH, origin: parsed.origin, key };
}

function present(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The server import for one classified message, or null for "other".
 * reviewRequired=false (filed without review) when the classifier is at or
 * above its threshold, or when the owner set the type by hand.
 */
function toImport(email, result, { threshold = 0.8, ownerSet = false } = {}) {
  if (!result || !JOB_TYPES.includes(result.type)) return null;
  const d = result.extractedData || {};
  const date = email.date instanceof Date ? email.date : new Date(email.date);
  return {
    messageId: String(email.messageId || "").replace(/^<|>$/g, ""),
    emailDate: (isNaN(date.getTime()) ? new Date() : date).toISOString(),
    classification: result.type,
    confidence: Number(result.confidence) || 0,
    isOutbound: Boolean(email.isOutbound),
    reviewRequired: ownerSet ? false : !(Number(result.confidence) >= threshold),
    extractedData: { company: present(d.company), jobTitle: present(d.jobTitle), location: present(d.location) },
    classifier: "claude",
    classificationStage: typeof result.stage === "number" ? result.stage : null,
  };
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

function loadOutbox(file = DEFAULT_OUTBOX) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { version: 1, items: [] };
    throw e;
  }
  const data = JSON.parse(text); // a corrupt outbox is an error, not silently emptied
  return { version: 1, items: Array.isArray(data.items) ? data.items : [] };
}

function saveOutbox(box, file = DEFAULT_OUTBOX) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: box.items }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Queue an operation; a newer one for the same message replaces the older.
 *   op "import": POST the import (new mail).
 *   op "correct": POST, then PATCH, so an import the server already holds as
 *                 pending is refiled with the owner's type.
 *   op "delete": the owner said it is not job mail; DELETE it (the server
 *                keeps an import already filed to a job).
 */
function enqueue(op, messageId, payload = null, file = DEFAULT_OUTBOX) {
  const id = String(messageId || "").replace(/^<|>$/g, "");
  const box = loadOutbox(file);
  box.items = box.items.filter((i) => i.messageId !== id);
  box.items.push({ op, messageId: id, payload, queuedAt: new Date().toISOString(), attempts: 0 });
  saveOutbox(box, file);
  return box.items.length;
}

async function call(fetchImpl, cfg, method, url, body) {
  const res = await fetchImpl(url, {
    method,
    redirect: "error",
    headers: { "content-type": "application/json", "x-api-key": cfg.key },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    // not JSON
  }
  return { status: res.status, ok: res.ok, json };
}

/**
 * Send everything in the outbox. Items the server confirms are removed (and
 * reported through onSent); the rest stay for the next run. Never throws for
 * a network or server error; returns counts and a short error string.
 */
async function flush(cfg, { fetchImpl = globalThis.fetch, file = DEFAULT_OUTBOX, onSent = async () => {}, log = () => {} } = {}) {
  const box = loadOutbox(file);
  const out = { sent: 0, filed: 0, pending: 0, kept: 0, keptIds: [], failed: 0, error: null };
  if (!box.items.length) return out;

  const done = new Set();
  const failed = new Set();
  const note = (item, err) => {
    item.attempts = (item.attempts || 0) + 1;
    item.lastError = err;
    failed.add(item.messageId);
  };

  try {
    const posts = box.items.filter((i) => i.op === "import" || i.op === "correct");
    for (let i = 0; i < posts.length; i += BATCH) {
      const batch = posts.slice(i, i + BATCH);
      const r = await call(fetchImpl, cfg, "POST", cfg.url, { imports: batch.map((b) => b.payload) });
      if (!r.ok || !r.json || typeof r.json.processed !== "number" || typeof r.json.filed !== "number" || !Array.isArray(r.json.failedMessageIds)) {
        // No confirmation (wrong URL, auth, server error, or a server build
        // without auto-filing that cannot say which imports failed): keep all.
        const err = `POST ${r.status}${r.json && r.json.error ? ` ${String(r.json.error).slice(0, 120)}` : ""}`;
        batch.forEach((b) => note(b, err));
        out.error = err;
        continue;
      }
      out.filed += r.json.filed || 0;
      out.pending += r.json.pending || 0;
      const bad = new Set(r.json.failedMessageIds || []);
      for (const b of batch) {
        if (bad.has(b.messageId)) note(b, "server failed this import");
        else if (b.op === "import") done.add(b.messageId);
      }

      const corrections = batch.filter((b) => b.op === "correct" && !bad.has(b.messageId));
      if (corrections.length) {
        const p = await call(fetchImpl, cfg, "PATCH", cfg.url, {
          updates: corrections.map((b) => ({
            messageId: b.messageId,
            classification: b.payload.classification,
            confidence: b.payload.confidence,
            reviewRequired: false,
            ownerCorrection: true,
            extractedData: b.payload.extractedData,
          })),
        });
        if (!p.ok || !p.json) {
          corrections.forEach((b) => note(b, `PATCH ${p.status}`));
          out.error = `PATCH ${p.status}`;
        } else {
          const pBad = new Set(p.json.failedMessageIds || []);
          out.filed += p.json.filed || 0;
          for (const b of corrections) {
            if (pBad.has(b.messageId)) note(b, "server failed this update");
            else done.add(b.messageId);
          }
        }
      }
    }

    for (const item of box.items.filter((i) => i.op === "delete")) {
      const r = await call(fetchImpl, cfg, "DELETE", `${cfg.url}?messageId=${encodeURIComponent(item.messageId)}`);
      if (r.ok && r.json) {
        if (r.json.kept) {
          // Corrected to "other" but already filed to a job: the server keeps it.
          out.kept++;
          out.keptIds.push(item.messageId);
        }
        done.add(item.messageId);
      } else {
        note(item, `DELETE ${r.status}`);
        out.error = `DELETE ${r.status}`;
      }
    }
  } catch (e) {
    // Network failure: whatever was not confirmed stays queued.
    out.error = e && e.cause && e.cause.code ? e.cause.code : (e && e.name) || "network error";
    log(`server: ${out.error}; ${box.items.length - done.size} item(s) stay queued`);
  }

  const sentItems = box.items.filter((i) => done.has(i.messageId) && !failed.has(i.messageId));
  box.items = box.items.filter((i) => !sentItems.includes(i));
  out.sent = sentItems.length;
  out.failed = failed.size;
  saveOutbox(box, file);
  for (const item of sentItems) {
    try {
      await onSent(item);
    } catch (e) {
      log(`${item.messageId} sent but not tagged: ${e.message}`);
    }
  }
  return out;
}

module.exports = { JOB_TYPES, DEFAULT_OUTBOX, loadServerConfig, toImport, loadOutbox, saveOutbox, enqueue, flush };
