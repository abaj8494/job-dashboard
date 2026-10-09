#!/usr/bin/env node
/**
 * Local Email Sync Script
 *
 * Runs on the Mac from the notmuch post-new hook. Finds `tag:new` mail to the
 * monitored addresses, classifies it with the two-stage Claude classifier
 * (headless Claude Code CLI, see scripts/lib/claude-classifier.js), tags the
 * message `jobsync/<type>`, and POSTs job-related imports to the JobSync
 * server, which auto-files the confident ones.
 *
 * Usage:
 *   node scripts/jobsync-local-sync.js [--dry-run] [--limit N]
 *
 *   --dry-run   classify and print, but do not tag or send
 *   --limit N   only process the first N messages
 *
 * Failure semantics: if the claude CLI preflight fails, or a classification
 * fails, the mail is left untagged (still tag:new) so the next hook run
 * retries. Nothing is tagged or sent on a failed classification.
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const { CLASSIFICATION_TYPES, classifyByRules, htmlToText } = require("./lib/classification-rules");
const { createClassifier, preflight, alertCliFailure } = require("./lib/claude-classifier");

const execAsync = promisify(exec);

// CLI flags
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = (() => {
  const idx = process.argv.indexOf("--limit");
  return idx !== -1 && process.argv[idx + 1] ? parseInt(process.argv[idx + 1], 10) : 0;
})();

// Configuration from environment
const JOBSYNC_API_URL =
  process.env.JOBSYNC_API_URL || "http://localhost:3000/api/email-sync";
const JOBSYNC_API_KEY = process.env.JOBSYNC_API_KEY || "";
const MONITORED_EMAILS = (
  process.env.MONITORED_EMAILS || "j@abaj.ai,aayushbajaj7@gmail.com"
).split(",");
// The CLI has a few seconds of startup per call; keep concurrency low.
const CONCURRENCY = parseInt(process.env.JOBSYNC_CONCURRENCY || "2", 10);

const JOBSYNC_DIR = path.join(process.env.HOME || "~", ".jobsync");
const LOG_FILE = path.join(JOBSYNC_DIR, "local-sync.log");
const CORRECTIONS_FILE = path.join(JOBSYNC_DIR, "corrections.json");
const IS_TTY = process.stdout.isTTY;

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;

  // Only write to file (avoid duplicates when stdout is redirected to same file)
  try {
    fs.appendFileSync(LOG_FILE, logMessage + "\n");
  } catch (e) {
    // ignore
  }

  // Only write to console if running interactively
  if (IS_TTY) {
    console.log(logMessage);
  }
}

/**
 * Load corrections from file (user-corrected classifications)
 */
function loadCorrections() {
  try {
    if (fs.existsSync(CORRECTIONS_FILE)) {
      const data = fs.readFileSync(CORRECTIONS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (e) {
    log(`Failed to load corrections: ${e.message}`);
  }
  return { corrections: [], lastScan: null };
}

/**
 * Run async tasks with limited concurrency
 */
async function runWithConcurrency(items, fn, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      try {
        const result = await fn(item, currentIndex, items.length);
        results[currentIndex] = result;
      } catch (error) {
        results[currentIndex] = { error };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

async function queryNewEmails() {
  const emailClauses = MONITORED_EMAILS.map(
    (email) => `(from:${email} OR to:${email})`
  ).join(" OR ");

  // Exclude spam, trash, junk folders and already-classified emails
  // An email is "processed" if it has any jobsync/<type> tag
  const classificationTags = CLASSIFICATION_TYPES.map(t => `tag:jobsync/${t}`).join(" OR ");
  const query = `tag:new AND (${emailClauses}) AND NOT tag:spam AND NOT tag:trash AND NOT folder:abaj/Trash AND NOT folder:abaj/Junk AND NOT (${classificationTags})`;

  try {
    // Use --output=messages to get unique message IDs (avoids duplicates from multiple files)
    const { stdout: messageIds } = await execAsync(`notmuch search --output=messages "${query}"`, { maxBuffer: 10 * 1024 * 1024 });
    const ids = messageIds.trim().split("\n").filter(Boolean);

    if (ids.length === 0) return [];

    // Get one file path per unique message
    const filePaths = [];
    for (const msgId of ids) {
      try {
        const { stdout: files } = await execAsync(`notmuch search --output=files '${msgId}'`);
        const firstFile = files.trim().split("\n")[0];
        if (firstFile) filePaths.push(firstFile);
      } catch (e) {
        // Skip if can't get file for this message
      }
    }

    log(`Found ${ids.length} unique messages`);
    return filePaths;
  } catch (error) {
    log(`Notmuch query failed: ${error.message}`);
    return [];
  }
}

async function parseEmailFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const parsed = await simpleParser(content);

    const fromAddress =
      parsed.from?.value?.[0]?.address || parsed.from?.text || "";
    const toAddress = parsed.to
      ? Array.isArray(parsed.to)
        ? parsed.to[0]?.value?.[0]?.address || ""
        : parsed.to.value?.[0]?.address || parsed.to.text || ""
      : "";

    const isOutbound = MONITORED_EMAILS.some(
      (email) => fromAddress.toLowerCase() === email.toLowerCase()
    );

    // Use text/plain if available, otherwise convert HTML to text
    const textBody = parsed.text || htmlToText(parsed.html);

    return {
      messageId: parsed.messageId || `generated-${Date.now()}-${Math.random()}`,
      subject: parsed.subject || "(No subject)",
      from: fromAddress,
      fromName: parsed.from?.value?.[0]?.name,
      to: toAddress,
      date: parsed.date || new Date(),
      textBody,
      htmlBody: parsed.html || undefined,
      isOutbound,
    };
  } catch (error) {
    log(`Failed to parse email ${filePath}: ${error.message}`);
    return null;
  }
}

async function markEmailProcessed(messageId, classificationType = null) {
  if (DRY_RUN) return;
  try {
    // Strip angle brackets if present (mailparser includes them, notmuch doesn't want them)
    const cleanId = messageId.replace(/^<|>$/g, "");
    const escapedId = cleanId.replace(/'/g, "'\\''");

    // Build tag command: remove 'new', add classification tag
    // The jobsync/<type> tag itself indicates the email has been processed
    let tagCmd = "-new";
    if (classificationType && CLASSIFICATION_TYPES.includes(classificationType)) {
      tagCmd += ` +jobsync/${classificationType}`;
    }

    await execAsync(`notmuch tag ${tagCmd} -- 'id:${escapedId}'`);
  } catch (error) {
    log(`Failed to tag email ${messageId}: ${error.message}`);
  }
}

function isJobRelated(classification) {
  return classification.type !== "other";
}

async function sendToServer(imports) {
  if (DRY_RUN) {
    log(`[dry-run] would send ${imports.length} imports to ${JOBSYNC_API_URL}`);
    return true;
  }
  try {
    const response = await fetch(JOBSYNC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JOBSYNC_API_KEY,
      },
      body: JSON.stringify({ imports }),
    });

    if (!response.ok) {
      const text = await response.text();
      log(`Server returned ${response.status}: ${text}`);
      return false;
    }

    const result = await response.json();
    log(`Server response: ${JSON.stringify(result)}`);

    // Guard against a silently-dropped POST: an http:// URL that 301-redirects
    // to https:// gets downgraded to GET by fetch, so the body never arrives and
    // the server replies with GET stats ({pending,total}) instead of an import
    // result. Treat anything without a numeric `processed` count as a failure so
    // we don't report success while losing every import.
    if (typeof result.processed !== "number") {
      log(
        `ERROR: server did not confirm the import (no 'processed' count). ` +
          `This usually means JOBSYNC_API_URL redirected the POST — ensure it uses https://. ` +
          `URL=${JOBSYNC_API_URL}`
      );
      return false;
    }

    return true;
  } catch (error) {
    log(`Failed to send to server: ${error.message}`);
    return false;
  }
}

/**
 * Build the import payload the server stores. `reviewRequired` tells the
 * server whether to auto-file (false) or leave the import pending (true).
 */
function buildImportPayload(parsed, classification) {
  return {
    messageId: parsed.messageId,
    subject: parsed.subject,
    fromEmail: parsed.from,
    fromName: parsed.fromName,
    toEmail: parsed.to,
    emailDate: parsed.date.toISOString(),
    bodyText: (parsed.textBody || "").substring(0, 10000),
    bodyHtml: (parsed.htmlBody || "").substring(0, 50000),
    classification: classification.type,
    confidence: classification.confidence,
    isOutbound: parsed.isOutbound,
    extractedData: classification.extractedData || {},
    reviewRequired: !!classification.reviewRequired,
    classifier: classification.source,
    classificationStage: classification.stage || null,
    classificationReason: classification.reason || null,
  };
}

async function processOneEmail(filePath, index, total, classifier) {
  const parsed = await parseEmailFile(filePath);
  if (!parsed) {
    return { status: "parse_failed" };
  }

  const shortSubject = parsed.subject.substring(0, 40).replace(/\n/g, " ");
  const tag = `[${index + 1}/${total}]`;

  // Try rule-based classification first (fast, no LLM needed)
  let classification = classifyByRules(parsed);

  if (classification) {
    classification = {
      ...classification,
      source: "rules",
      stage: 0,
      reviewRequired: false,
      extractedData: classification.extractedData || {},
    };
    log(`${tag} [FAST-PATH:${classification.reason}] ${shortSubject} -> ${classification.type}`);
  } else {
    log(`${tag} [CLAUDE] Classifying: ${shortSubject}...`);
    const result = await classifier.classify(parsed);

    if (!result) {
      log(`${tag}   -> Classification failed, left untagged for retry`);
      return { status: "classify_failed" };
    }

    classification = { ...result, source: "claude" };
    log(
      `${tag}   -> ${result.type} (${(result.confidence * 100).toFixed(0)}%, stage ${result.stage}` +
        `${result.reviewRequired ? ", REVIEW" : ""}, $${result.cost.toFixed(4)}) ${result.reason}`
    );
  }

  if (DRY_RUN) {
    console.log(
      JSON.stringify({
        subject: parsed.subject,
        from: parsed.from,
        type: classification.type,
        confidence: classification.confidence,
        stage: classification.stage,
        reviewRequired: classification.reviewRequired,
        reason: classification.reason,
        extractedData: classification.extractedData,
      })
    );
  }

  // Confident "other": tag and move on, never imported.
  if (!isJobRelated(classification) && !classification.reviewRequired) {
    await markEmailProcessed(parsed.messageId, classification.type);
    return { status: "skipped", reason: "not job-related", source: classification.source };
  }

  // Everything else (job-related at any confidence, or an uncertain "other")
  // is sent to the server. The server files confident imports itself and
  // leaves uncertain ones pending for review.
  //
  // NOTE: do NOT tag as processed here. These are tagged in main() only after
  // the server confirms the import, so a failed send leaves them in the queue
  // to retry instead of orphaning them (tagged locally, absent on prod).
  return {
    status: "job_related",
    source: classification.source,
    data: buildImportPayload(parsed, classification),
  };
}

async function main() {
  // Ensure log directory exists
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  log(`Starting local email sync...${DRY_RUN ? " (DRY RUN)" : ""}`);

  if (!JOBSYNC_API_KEY && !DRY_RUN) {
    log("ERROR: JOBSYNC_API_KEY not set");
    process.exit(1);
  }

  log(`API URL: ${JOBSYNC_API_URL}`);
  log(`Concurrency: ${CONCURRENCY}`);

  // Query for new emails first so a preflight failure with nothing to do stays quiet.
  let emailPaths = await queryNewEmails();

  if (emailPaths.length === 0) {
    log("No new emails to process");
    return;
  }

  if (LIMIT > 0 && emailPaths.length > LIMIT) {
    log(`Limiting to ${LIMIT} of ${emailPaths.length} emails`);
    emailPaths = emailPaths.slice(0, LIMIT);
  }

  // Prove the claude CLI is usable BEFORE any spend. On failure the mail stays
  // tag:new and the next hook run retries.
  const pf = await preflight();
  if (!pf.ok) {
    alertCliFailure("preflight", pf.detail, log);
    process.exit(2);
  }
  log(`Preflight: claude CLI ok (${pf.detail})`);

  // Load corrections for the few-shot block
  const correctionsData = loadCorrections();
  const corrections = correctionsData.corrections || [];
  if (corrections.length > 0) {
    log(`Loaded ${corrections.length} corrections for few-shot learning`);
  }

  const classifier = createClassifier({ corrections, log });
  log(`Classifier: model=${classifier.config.model} threshold=${classifier.config.threshold} stage2ForExtraction=${classifier.config.stage2ForExtraction}`);

  log(`Processing ${emailPaths.length} emails with ${CONCURRENCY} concurrent workers...`);

  const results = await runWithConcurrency(
    emailPaths,
    (filePath, index, total) => processOneEmail(filePath, index, total, classifier),
    CONCURRENCY
  );

  // Aggregate results
  const toSend = [];
  let skipped = 0;
  let failed = 0;
  let jobRelated = 0;

  for (const result of results) {
    if (result.error) {
      failed++;
      log(`Worker error: ${result.error.message || result.error}`);
    } else if (result.status === "job_related") {
      toSend.push(result.data);
      jobRelated++;
    } else if (result.status === "classify_failed" || result.status === "parse_failed") {
      failed++;
    } else {
      skipped++;
    }
  }

  const t = classifier.totals;
  log(
    `Results: ${jobRelated} to import, ${skipped} skipped, ${failed} failed | ` +
      `claude calls=${t.calls} stage1=${t.stage1} stage2=${t.stage2} failures=${t.failures} cost=$${t.cost.toFixed(4)} time=${(t.durationMs / 1000).toFixed(1)}s`
  );

  if (toSend.length > 0) {
    log(`Sending ${toSend.length} emails to server...`);
    const success = await sendToServer(toSend);
    if (success) {
      // Tag as processed only now that the server has confirmed the import.
      for (const imp of toSend) {
        await markEmailProcessed(imp.messageId, imp.classification);
      }
      log("Sync completed successfully");
    } else {
      log("Sync failed - emails left untagged for retry - check server logs");
    }
  } else {
    log("No job-related emails to send");
  }
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
