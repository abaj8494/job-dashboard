#!/usr/bin/env node
/**
 * jobsync mail classifier (server-free).
 *
 * Tags monitored mail with jobsync/<type> (job_application, job_response,
 * interview, rejection, offer, follow_up, other) and sends each job-related
 * result to jobs.abaj.ai, which files it with no review step: it creates the
 * job or links to it, dated by the mail, and moves its status forward
 * (scripts/lib/server-sync.js). Sent mail gets the jobsync-server tag.
 * Owner corrections (jobsync-was/<original> tags, set by the Emacs helpers)
 * are recorded for few-shot learning and sent to the server too.
 *
 * Classification: scripts/lib/mail-classifier.js (local prefilter, then
 * Claude on headers only, then a short redacted excerpt only when needed),
 * via the headless Claude Code CLI on the owner's subscription.
 *
 * Privacy: the log holds message ids, labels, stages and cost, never subjects,
 * senders or body text. The server gets extracted fields only (company,
 * title, location, type, confidence, mail date, messageId).
 *
 * Usage:
 *   node scripts/jobsync-mail-classify.js [--dry-run] [--refile] [--since YYYY-MM-DD] [--limit N]
 *
 *   --dry-run  classify and print labels; no tags, no server, no corrections
 *   --refile   also re-classify job mail tagged before the server step existed
 *              (jobsync/<job type> without jobsync-server) and send it
 *   --since    oldest mail date to consider (default JOBSYNC_SINCE or 2026-10-09)
 *   --limit    most messages per run (default JOBSYNC_MAX_PER_RUN or 100; 0 = all)
 *
 * One run at a time: a lock in ~/.jobsync makes an overlapping run exit at once.
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { simpleParser } = require("mailparser");

const { CLASSIFICATION_TYPES, htmlToText } = require("./lib/classification-rules");
const { preflight, alertCliFailure, DEFAULTS } = require("./lib/claude-classifier");
const { createMailClassifier } = require("./lib/mail-classifier");
const server = require("./lib/server-sync");

const execFileAsync = promisify(execFile);

// Subscription only: never let the CLI fall back to an API key.
delete process.env.ANTHROPIC_API_KEY;

const HOME = process.env.HOME || os.homedir();
const JOBSYNC_DIR = path.join(HOME, ".jobsync");
const LOG_FILE = process.env.JOBSYNC_MAIL_LOG || path.join(JOBSYNC_DIR, "mail-classify.log");
const LOCK_FILE = path.join(JOBSYNC_DIR, "mail-classify.lock");
const CORRECTIONS_FILE = path.join(JOBSYNC_DIR, "corrections.json");
const CONFIG_FILE = path.join(JOBSYNC_DIR, "config");
const NOTMUCH = process.env.NOTMUCH || (fs.existsSync("/opt/homebrew/bin/notmuch") ? "/opt/homebrew/bin/notmuch" : "notmuch");
const CONCURRENCY = parseInt(process.env.JOBSYNC_CONCURRENCY || "2", 10);

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DRY_RUN = process.argv.includes("--dry-run");
const REFILE = process.argv.includes("--refile");
const SERVER_TAG = "jobsync-server";
const SINCE = argValue("--since", process.env.JOBSYNC_SINCE || "2026-10-09");
const LIMIT = parseInt(argValue("--limit", process.env.JOBSYNC_MAX_PER_RUN || "100"), 10);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(JOBSYNC_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {
    // ignore
  }
  if (process.stdout.isTTY || DRY_RUN) console.log(line);
}

/** MONITORED_EMAILS from the environment or ~/.jobsync/config (that one variable only). */
function monitoredEmails() {
  let value = process.env.MONITORED_EMAILS;
  if (!value) {
    try {
      const m = /^\s*(?:export\s+)?MONITORED_EMAILS=["']?([^"'\n]*)["']?/m.exec(fs.readFileSync(CONFIG_FILE, "utf8"));
      value = m && m[1];
    } catch (e) {
      // fall through
    }
  }
  const list = String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("MONITORED_EMAILS is not set (environment or ~/.jobsync/config)");
  return list;
}

// ---------------------------------------------------------------------------
// Lock: one run at a time
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function acquireLock() {
  fs.mkdirSync(JOBSYNC_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const holder = parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10);
      if (holder && pidAlive(holder)) return false;
      fs.rmSync(LOCK_FILE, { force: true }); // stale lock from a dead run
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10) === process.pid) fs.rmSync(LOCK_FILE);
  } catch (e) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// notmuch
// ---------------------------------------------------------------------------

async function notmuch(args) {
  const { stdout } = await execFileAsync(NOTMUCH, args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function lines(s) {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

function baseQuery(emails) {
  const who = emails.map((e) => `(from:${e} OR to:${e})`).join(" OR ");
  return `(${who}) AND NOT tag:spam AND NOT tag:trash AND NOT folder:abaj/Trash AND NOT folder:abaj/Junk`;
}

function unclassifiedQuery(emails, since) {
  const classified = CLASSIFICATION_TYPES.map((t) => `tag:jobsync/${t}`).join(" OR ");
  return `date:${since}.. AND ${baseQuery(emails)} AND NOT (${classified})`;
}

/** Job mail tagged before it was sent to the server (catch-up with --refile). */
function unsentJobQuery(emails, since) {
  const job = server.JOB_TYPES.map((t) => `tag:jobsync/${t}`).join(" OR ");
  return `date:${since}.. AND ${baseQuery(emails)} AND (${job}) AND NOT tag:${SERVER_TAG}`;
}

async function messageIds(query) {
  return lines(await notmuch(["search", "--output=messages", "--sort=oldest-first", query])).map((id) => id.replace(/^id:/, ""));
}

function idTerm(id) {
  return `id:"${id.replace(/"/g, '""')}"`;
}

async function readMessage(id, emails) {
  const files = lines(await notmuch(["search", "--output=files", idTerm(id)]));
  const tags = lines(await notmuch(["search", "--output=tags", idTerm(id)]));
  if (!files.length) return null;
  const parsed = await simpleParser(fs.readFileSync(files[0]));
  const from = parsed.from?.value?.[0]?.address || "";
  const to = (Array.isArray(parsed.to) ? parsed.to[0] : parsed.to)?.value?.[0]?.address || "";
  return {
    tags,
    email: {
      messageId: id,
      from,
      fromName: parsed.from?.value?.[0]?.name || "",
      to,
      subject: parsed.subject || "(No subject)",
      date: parsed.date || new Date(),
      isOutbound: emails.some((e) => e.toLowerCase() === from.toLowerCase()),
      isList: parsed.headers.has("list-id") || parsed.headers.has("list-unsubscribe"),
      textBody: parsed.text || htmlToText(parsed.html || ""),
    },
  };
}

async function tagMessage(id, add, remove = []) {
  const ops = [...add.map((t) => `+${t}`), ...remove.map((t) => `-${t}`)];
  await notmuch(["tag", ...ops, "--", idTerm(id)]);
}

// ---------------------------------------------------------------------------
// Corrections (jobsync-was/<original> set by the owner in Emacs)
// ---------------------------------------------------------------------------

function loadCorrections() {
  try {
    const data = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, "utf8"));
    return { corrections: Array.isArray(data.corrections) ? data.corrections : [], ...data };
  } catch (e) {
    return { corrections: [] };
  }
}

async function scanCorrections(emails, classifier) {
  const was = CLASSIFICATION_TYPES.map((t) => `tag:jobsync-was/${t}`).join(" OR ");
  const ids = await messageIds(was);
  if (!ids.length) return 0;

  const data = loadCorrections();
  let recorded = 0;
  for (const id of ids) {
    const msg = await readMessage(id, emails);
    if (!msg) {
      // No file left to read the correction from; drop the marker so it is not retried forever.
      await tagMessage(id, [], [...CLASSIFICATION_TYPES.map((t) => `jobsync-was/${t}`), "jobsync-corrected"]);
      log(`${id} correction marker dropped: message has no file`);
      continue;
    }
    const originalType = (msg.tags.find((t) => t.startsWith("jobsync-was/")) || "").slice("jobsync-was/".length);
    const correctedType = (msg.tags.find((t) => t.startsWith("jobsync/")) || "").slice("jobsync/".length);
    if (!CLASSIFICATION_TYPES.includes(originalType) || !CLASSIFICATION_TYPES.includes(correctedType)) continue;

    if (originalType !== correctedType) {
      // Headers only: the corrections go into every system prompt.
      data.corrections.push({
        messageId: id,
        from: msg.email.from,
        fromName: msg.email.fromName,
        to: msg.email.to,
        subject: msg.email.subject,
        isOutbound: msg.email.isOutbound,
        originalType,
        correctedType,
        correctedAt: new Date().toISOString(),
        highVariance: true,
      });
      recorded++;

      if (correctedType === "other") {
        server.enqueue("delete", id);
        log(`${id} correction ${originalType} -> ${correctedType}; server delete queued`);
      } else {
        // The owner set the type; Claude only reads the details for it.
        const r = await classifier.classify(msg.email, { tags: msg.tags, label: id, forceStage2: true });
        const imp = server.toImport(msg.email, { ...(r || { confidence: 1, stage: null, extractedData: {} }), type: correctedType }, { ownerSet: true });
        server.enqueue("correct", id, imp);
        await tagMessage(id, [], [SERVER_TAG]);
        log(`${id} correction ${originalType} -> ${correctedType}; server update queued${r ? "" : " (details not read)"}`);
      }
    }
    await tagMessage(id, [], [`jobsync-was/${originalType}`, "jobsync-corrected"]);
  }

  if (recorded) {
    data.lastScan = new Date().toISOString();
    const tmp = `${CORRECTIONS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, CORRECTIONS_FILE);
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { error: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main() {
  if (!acquireLock()) {
    log("another run holds the lock; exiting");
    return 0;
  }
  const started = Date.now();
  try {
    const emails = monitoredEmails();

    const pf = await preflight();
    if (!pf.ok) {
      alertCliFailure("preflight", pf.detail, log);
      return 1;
    }
    if (pf.status.authMethod !== "claude.ai") {
      alertCliFailure("preflight", `refusing to run on authMethod=${pf.status.authMethod}; subscription login required`, log);
      return 1;
    }
    log(`run start${DRY_RUN ? " (dry run)" : ""}: since=${SINCE} limit=${LIMIT || "none"} model=${DEFAULTS.model} preflight ${pf.detail}`);

    const classifier = createMailClassifier({ corrections: loadCorrections().corrections, log });

    if (!DRY_RUN) {
      const n = await scanCorrections(emails, classifier);
      if (n) log(`recorded ${n} correction(s)`);
    }

    let ids = await messageIds(unclassifiedQuery(emails, SINCE));
    const pending = ids.length;
    if (LIMIT > 0) ids = ids.slice(0, LIMIT);
    const refileIds = REFILE ? (await messageIds(unsentJobQuery(emails, SINCE))).filter((id) => !ids.includes(id)) : [];
    log(`${pending} unclassified message(s); processing ${ids.length}${REFILE ? `; refiling ${refileIds.length}` : ""}`);

    const counts = Object.fromEntries(CLASSIFICATION_TYPES.map((t) => [t, 0]));
    let failed = 0;
    let gone = 0;
    let queued = 0;
    const stages = { 0: 0, 1: 0, 2: 0 };
    const threshold = classifier.config.threshold;
    const refiling = new Set(refileIds);

    await mapLimit([...ids, ...refileIds], CONCURRENCY, async (id) => {
      const msg = await readMessage(id, emails);
      if (!msg) {
        // Removed from the index since the query (moved, trashed or deleted by a sync).
        log(`${id} gone from the index; skipped`);
        gone++;
        return;
      }
      const r = await classifier.classify(msg.email, { tags: msg.tags, label: id });
      if (!r) {
        failed++;
        return; // left untagged (or unsent); the next run retries
      }
      // Refiling: the type is the tag the owner has already seen; Claude
      // supplies the company, title and location.
      const tagged = refiling.has(id) ? (msg.tags.find((t) => t.startsWith("jobsync/")) || "").slice("jobsync/".length) : null;
      const result = tagged && server.JOB_TYPES.includes(tagged) ? { ...r, type: tagged } : r;
      counts[result.type]++;
      stages[r.stage]++;

      let serverNote = "";
      const imp = server.toImport(msg.email, result, { threshold });
      if (imp) {
        serverNote = ` server=${imp.reviewRequired ? "review" : "file"}${imp.extractedData.company && imp.extractedData.jobTitle ? "" : "(partial)"}`;
        if (DRY_RUN) {
          serverNote += "(dry)";
        } else {
          server.enqueue("import", id, imp);
          queued++;
        }
      }
      if (!DRY_RUN && !tagged) await tagMessage(id, [`jobsync/${result.type}`]);
      log(`${id} -> ${result.type}${tagged && tagged !== r.type ? ` (classifier said ${r.type})` : ""} stage=${r.stage} src=${r.source} conf=${r.confidence.toFixed(2)}${serverNote}`);
    });

    let sent = "server off";
    if (!DRY_RUN) {
      const cfg = server.loadServerConfig();
      if (!cfg.ok) {
        sent = `server ${cfg.off ? "off" : "not configured"} (${cfg.reason}); ${server.loadOutbox().items.length} queued`;
      } else {
        const f = await server.flush(cfg, { log, onSent: (item) => tagMessage(item.messageId, [SERVER_TAG]) });
        const left = server.loadOutbox().items.length;
        sent = `server sent=${f.sent} filed=${f.filed} pending=${f.pending}${f.kept ? ` kept=${f.kept}` : ""}${left ? ` queued=${left}` : ""}${f.error ? ` error=${f.error}` : ""}`;
      }
    }

    const t = classifier.totals;
    const total = ids.length + refileIds.length;
    const summary =
      `run done: ${total} processed, ${failed} failed (left for retry), ${gone} gone, ` +
      `${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")} | ` +
      `stage0=${stages[0]} stage1=${stages[1]} stage2=${stages[2]} | queued +${queued} | ${sent} | ` +
      `claude calls=${t.calls} cost=$${t.cost.toFixed(4)} model_time=${(t.durationMs / 1000).toFixed(1)}s wall=${((Date.now() - started) / 1000).toFixed(1)}s` +
      `${pending > ids.length ? ` | ${pending - ids.length} left for later runs` : ""}`;
    log(summary);
    if (!process.stdout.isTTY && !DRY_RUN) console.log(summary);
    if (t.tripped) alertCliFailure("classification", "circuit breaker tripped", log);
    return failed && failed === total - gone ? 1 : 0;
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      log(`fatal: ${e.message}`);
      releaseLock();
      process.exit(1);
    });
}

module.exports = { unclassifiedQuery, unsentJobQuery, baseQuery, monitoredEmails, acquireLock, releaseLock };
