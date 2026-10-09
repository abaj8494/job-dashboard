#!/usr/bin/env node
/**
 * Classify/Reclassify Emails Script (Claude two-stage classifier)
 *
 * Default mode: Finds monitored emails without any jobsync/* tag and classifies them.
 * --reprocess mode: Re-classifies and re-extracts ALL tagged emails through the
 *   Claude pipeline and syncs changes to the server. This is the backfill loop:
 *   rate-limited by JOBSYNC_CONCURRENCY (default 2), idempotent on messageId
 *   (a progress file records every message already reclassified, so a rerun
 *   skips them), and it reports how many mails moved category.
 *
 * Usage:
 *   node scripts/jobsync-reclassify-untagged.js                  # untagged only
 *   node scripts/jobsync-reclassify-untagged.js --reprocess      # re-process all tagged emails
 *   node scripts/jobsync-reclassify-untagged.js --reprocess --only other   # only one old tag
 *   Flags: --limit N, --dry-run, --force (ignore progress file), --concurrency N
 *
 * Failure semantics: a failed classification leaves the mail's tags untouched
 * and is not recorded as done, so the next run retries it.
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
const REPROCESS = process.argv.includes("--reprocess");
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
function flagValue(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}
const LIMIT = parseInt(flagValue("--limit") || "0", 10);
const ONLY = flagValue("--only");

// Configuration
const JOBSYNC_API_URL =
  process.env.JOBSYNC_API_URL || "http://localhost:3000/api/email-sync";
const JOBSYNC_API_KEY = process.env.JOBSYNC_API_KEY || "";
const MONITORED_EMAILS = (
  process.env.MONITORED_EMAILS || "j@abaj.ai,aayushbajaj7@gmail.com"
).split(",");
const CONCURRENCY = parseInt(flagValue("--concurrency") || process.env.JOBSYNC_CONCURRENCY || "2", 10);

const JOBSYNC_DIR = path.join(process.env.HOME || "~", ".jobsync");
const CORRECTIONS_FILE = path.join(JOBSYNC_DIR, "corrections.json");
const PROGRESS_FILE = path.join(JOBSYNC_DIR, "reclassify-progress.json");

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function loadCorrections() {
  try {
    if (fs.existsSync(CORRECTIONS_FILE)) {
      const data = fs.readFileSync(CORRECTIONS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (e) {
    // ignore
  }
  return { corrections: [], lastScan: null };
}

/**
 * Progress file: messageId -> { oldType, newType, ts }. Makes --reprocess
 * idempotent across reruns and interruptions.
 */
function loadProgress() {
  if (FORCE) return {};
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    }
  } catch (e) {
    log(`Failed to load progress file: ${e.message}`);
  }
  return {};
}

function saveProgress(progress) {
  if (DRY_RUN) return;
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 1));
  } catch (e) {
    log(`Failed to save progress file: ${e.message}`);
  }
}

function monitoredClause() {
  return MONITORED_EMAILS.map((email) => `(from:${email} OR to:${email})`).join(" OR ");
}

function classificationTagsClause() {
  return CLASSIFICATION_TYPES.map((t) => `tag:jobsync/${t}`).join(" OR ");
}

/**
 * Find monitored emails that don't have any jobsync/* tag
 */
async function queryUntaggedEmails() {
  const query = `(${monitoredClause()}) AND NOT tag:spam AND NOT tag:trash AND NOT (${classificationTagsClause()})`;

  try {
    const { stdout } = await execAsync(
      `notmuch search --output=messages "${query}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const messageIds = stdout.trim().split("\n").filter(Boolean);
    if (messageIds.length === 0) return [];

    const results = [];
    for (const msgId of messageIds) {
      try {
        const { stdout: files } = await execAsync(
          `notmuch search --output=files '${msgId}'`
        );
        const firstFile = files.trim().split("\n")[0];
        if (firstFile) {
          results.push({ messageId: msgId.replace(/^id:/, ""), filePath: firstFile, oldType: null });
        }
      } catch (e) {
        // Skip
      }
    }

    return results;
  } catch (error) {
    log(`Query failed: ${error.message}`);
    return [];
  }
}

/**
 * Find ALL monitored emails that have a jobsync/* tag (for reprocessing)
 */
async function queryTaggedEmails() {
  const tagClause = ONLY && CLASSIFICATION_TYPES.includes(ONLY)
    ? `tag:jobsync/${ONLY}`
    : classificationTagsClause();
  const query = `(${monitoredClause()}) AND NOT tag:spam AND NOT tag:trash AND (${tagClause})`;

  try {
    const { stdout } = await execAsync(
      `notmuch search --output=messages "${query}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const messageIds = stdout.trim().split("\n").filter(Boolean);
    if (messageIds.length === 0) return [];

    const results = [];
    for (const msgId of messageIds) {
      const cleanMsgId = msgId.replace(/^id:/, "");
      try {
        const { stdout: files } = await execAsync(
          `notmuch search --output=files '${msgId}'`
        );
        const firstFile = files.trim().split("\n")[0];
        if (!firstFile) continue;

        const { stdout: tagsOut } = await execAsync(
          `notmuch search --output=tags '${msgId}'`
        );
        const tags = tagsOut.trim().split("\n").filter(Boolean);
        const jobsyncTag = tags.find((t) => t.startsWith("jobsync/"));
        const oldType = jobsyncTag ? jobsyncTag.replace("jobsync/", "") : null;

        results.push({ messageId: cleanMsgId, filePath: firstFile, oldType });
      } catch (e) {
        // Skip
      }
    }

    return results;
  } catch (error) {
    log(`Query failed: ${error.message}`);
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

    return {
      messageId: parsed.messageId || `generated-${Date.now()}-${Math.random()}`,
      subject: parsed.subject || "(No subject)",
      from: fromAddress,
      fromName: parsed.from?.value?.[0]?.name,
      to: toAddress,
      date: parsed.date || new Date(),
      textBody: parsed.text || htmlToText(parsed.html),
      htmlBody: parsed.html || undefined,
      isOutbound,
    };
  } catch (error) {
    log(`Failed to parse email ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Set classification tag on an email, removing any old jobsync/* tags first
 */
async function setClassificationTag(messageId, newType, oldType) {
  if (DRY_RUN) return;
  try {
    const cleanId = messageId.replace(/^<|>$/g, "");
    const escapedId = cleanId.replace(/'/g, "'\\''");

    if (!newType || !CLASSIFICATION_TYPES.includes(newType)) return;

    let tagCmd = `+jobsync/${newType}`;
    if (oldType && oldType !== newType && CLASSIFICATION_TYPES.includes(oldType)) {
      tagCmd = `-jobsync/${oldType} ${tagCmd}`;
    }

    await execAsync(`notmuch tag ${tagCmd} -- 'id:${escapedId}'`);
  } catch (error) {
    log(`Failed to tag email ${messageId}: ${error.message}`);
  }
}

async function sendToServer(imports) {
  if (!JOBSYNC_API_KEY || imports.length === 0) return;
  if (DRY_RUN) {
    log(`[dry-run] would POST ${imports.length} imports`);
    return;
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
      log(`Server POST returned ${response.status}: ${text}`);
      return;
    }

    const result = await response.json();
    log(`Server POST: ${result.processed} processed, ${result.skipped} skipped`);
  } catch (error) {
    log(`Failed to send to server: ${error.message}`);
  }
}

/**
 * Send corrections + extractedData updates via PATCH
 */
async function patchServer(corrections, updates) {
  if (!JOBSYNC_API_KEY) return;
  if (corrections.length === 0 && updates.length === 0) return;
  if (DRY_RUN) {
    log(`[dry-run] would PATCH ${corrections.length} corrections, ${updates.length} updates`);
    return;
  }

  try {
    const body = {};
    if (corrections.length > 0) body.corrections = corrections;
    if (updates.length > 0) body.updates = updates;

    const response = await fetch(JOBSYNC_API_URL, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JOBSYNC_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      log(`Server PATCH returned ${response.status}: ${text}`);
      return;
    }

    const result = await response.json();
    log(`Server PATCH: ${result.updated} updated, ${result.notFound} not found`);
  } catch (error) {
    log(`Failed to patch server: ${error.message}`);
  }
}

/**
 * Delete emails from the server
 */
async function deleteFromServer(messageIds) {
  if (!JOBSYNC_API_KEY || messageIds.length === 0) return;
  if (DRY_RUN) {
    log(`[dry-run] would DELETE ${messageIds.length} imports`);
    return;
  }

  let deleted = 0;
  let notFound = 0;

  for (const messageId of messageIds) {
    try {
      const cleanId = messageId.replace(/^<|>$/g, "");
      const url = `${JOBSYNC_API_URL}?messageId=${encodeURIComponent(cleanId)}`;

      const response = await fetch(url, {
        method: "DELETE",
        headers: { "x-api-key": JOBSYNC_API_KEY },
      });

      if (response.ok) {
        const result = await response.json();
        if (result.deleted > 0) deleted++;
        else notFound++;
      } else {
        notFound++;
      }
    } catch (error) {
      notFound++;
    }
  }

  log(`Server DELETE: ${deleted} deleted, ${notFound} not found`);
}

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

async function main() {
  if (REPROCESS) {
    log(`REPROCESS MODE: Re-classifying and re-extracting ${ONLY ? `jobsync/${ONLY}` : "all tagged"} emails...${DRY_RUN ? " (DRY RUN)" : ""}`);
  } else {
    log(`Finding untagged emails...${DRY_RUN ? " (DRY RUN)" : ""}`);
  }

  // Find emails to process
  let emails = REPROCESS ? await queryTaggedEmails() : await queryUntaggedEmails();

  const progress = REPROCESS ? loadProgress() : {};
  const alreadyDone = emails.filter((e) => progress[e.messageId]);
  if (alreadyDone.length > 0) {
    log(`Skipping ${alreadyDone.length} already reclassified (progress file; use --force to redo)`);
    emails = emails.filter((e) => !progress[e.messageId]);
  }

  if (LIMIT > 0 && emails.length > LIMIT) {
    log(`Limiting to ${LIMIT} of ${emails.length} emails`);
    emails = emails.slice(0, LIMIT);
  }

  log(`Found ${emails.length} emails to ${REPROCESS ? "reprocess" : "classify"}`);

  if (emails.length === 0) {
    log("Nothing to do");
    return;
  }

  // Prove the claude CLI is usable before any spend.
  const pf = await preflight();
  if (!pf.ok) {
    alertCliFailure("preflight", pf.detail, log);
    process.exit(2);
  }
  log(`Preflight: claude CLI ok (${pf.detail})`);

  const correctionsData = loadCorrections();
  const corrections = correctionsData.corrections || [];
  if (corrections.length > 0) {
    log(`Loaded ${corrections.length} corrections for few-shot learning`);
  }

  const classifier = createClassifier({ corrections, log });
  log(`Classifier: model=${classifier.config.model} threshold=${classifier.config.threshold} concurrency=${CONCURRENCY}`);

  // Collect server actions
  const newImports = [];       // POST: newly job-related (was "other" or untagged)
  const patchCorrections = []; // PATCH corrections: classification changed (job-related -> job-related)
  const patchUpdates = [];     // PATCH updates: extractedData updates
  const toDelete = [];         // DELETE: was job-related, now "other"

  let processed = 0;
  let failed = 0;
  let moved = 0;
  const transitions = {};

  const results = await runWithConcurrency(
    emails,
    async ({ messageId, filePath, oldType }, index, total) => {
      const parsed = await parseEmailFile(filePath);
      if (!parsed) {
        return { status: "parse_failed" };
      }

      const shortSubject = parsed.subject.substring(0, 40).replace(/\n/g, " ");
      const tag = `[${index + 1}/${total}]`;

      // Classify
      let classification = classifyByRules(parsed);

      if (classification) {
        classification = { ...classification, source: "rules", stage: 0, reviewRequired: false };
        log(`${tag} [FAST-PATH:${classification.reason}] ${shortSubject} -> ${classification.type}`);
      } else {
        log(`${tag} [CLAUDE] Classifying: ${shortSubject}...`);
        const result = await classifier.classify(parsed);
        if (!result) {
          log(`${tag}   -> Classification failed, tags left unchanged for retry`);
          return { status: "classify_failed" };
        }
        classification = { ...result, source: "claude" };
        log(`${tag}   -> ${result.type} (${(result.confidence * 100).toFixed(0)}%, stage ${result.stage}${result.reviewRequired ? ", REVIEW" : ""}, $${result.cost.toFixed(4)})`);
      }

      // Update notmuch tag
      await setClassificationTag(messageId, classification.type, oldType);

      const isJobRelated = classification.type !== "other";
      const wasJobRelated = oldType && oldType !== "other";
      const changed = oldType && oldType !== classification.type;
      if (changed) {
        const key = `${oldType} -> ${classification.type}`;
        transitions[key] = (transitions[key] || 0) + 1;
        log(`${tag}   moved: ${key}`);
      }

      if (isJobRelated || classification.reviewRequired) {
        const importData = buildImportPayload(parsed, classification);

        if (REPROCESS && wasJobRelated) {
          // Was job-related, still job-related: PATCH classification + extractedData
          if (oldType !== classification.type) {
            patchCorrections.push({
              messageId: parsed.messageId,
              originalType: oldType,
              correctedType: classification.type,
            });
          }
          patchUpdates.push({
            messageId: parsed.messageId,
            extractedData: importData.extractedData,
          });
        } else {
          // New import: was untagged or was "other"
          newImports.push(importData);
        }
      } else if (REPROCESS && wasJobRelated) {
        // Was job-related, now confidently "other": delete from server
        toDelete.push(parsed.messageId);
      }

      return { status: "done", messageId, oldType, newType: classification.type, changed: !!changed };
    },
    CONCURRENCY
  );

  for (const result of results) {
    if (result.error || result.status === "classify_failed" || result.status === "parse_failed") {
      failed++;
      if (result.error) log(`Worker error: ${result.error.message || result.error}`);
    } else {
      processed++;
      if (result.changed) moved++;
      if (REPROCESS) {
        progress[result.messageId] = { oldType: result.oldType, newType: result.newType, ts: new Date().toISOString() };
      }
    }
  }
  if (REPROCESS) saveProgress(progress);

  const t = classifier.totals;
  log(`\nResults: ${processed} processed, ${failed} failed, ${moved} moved category`);
  for (const [key, count] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
    log(`  ${count.toString().padStart(4)}  ${key}`);
  }
  log(`Claude: calls=${t.calls} stage1=${t.stage1} stage2=${t.stage2} failures=${t.failures} cost=$${t.cost.toFixed(4)} time=${(t.durationMs / 1000).toFixed(1)}s`);

  // Server sync
  if (newImports.length > 0) {
    log(`Sending ${newImports.length} new imports to server...`);
    await sendToServer(newImports);
  }

  if (patchCorrections.length > 0 || patchUpdates.length > 0) {
    log(`Patching server: ${patchCorrections.length} reclassifications, ${patchUpdates.length} extraction updates...`);
    await patchServer(patchCorrections, patchUpdates);
  }

  if (toDelete.length > 0) {
    log(`Deleting ${toDelete.length} demoted emails from server...`);
    await deleteFromServer(toDelete);
  }

  log("Done!");
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
