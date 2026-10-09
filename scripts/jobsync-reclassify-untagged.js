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
 *   Flags: --limit N, --dry-run, --force (ignore progress file), --concurrency N, --batch N
 *
 * Order of operations per batch (default 20 mails): classify -> sync the
 * server (POST/PATCH/DELETE, each confirmed) -> only then move notmuch tags
 * and record progress for the confirmed mails. A failed classification or an
 * unconfirmed server call leaves that mail's tags untouched and unrecorded, so
 * the next run retries it; a batch whose server sync fails entirely stops the
 * run. Progress is saved after every batch, so an interrupted run loses at
 * most one batch of classification spend.
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
const BATCH = Math.max(1, parseInt(flagValue("--batch") || process.env.JOBSYNC_RECLASSIFY_BATCH || "20", 10));

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

/**
 * POST new imports. Returns { ok, failed:Set<messageId> }. ok requires a
 * numeric `processed` count (guards the http->https redirect-to-GET silent
 * drop); `failed` are the ids the server reported it could not store.
 */
async function sendToServer(imports) {
  const none = { ok: false, failed: new Set() };
  if (imports.length === 0) return { ok: true, failed: new Set() };
  if (!JOBSYNC_API_KEY) {
    log("JOBSYNC_API_KEY not set; cannot POST imports");
    return none;
  }
  if (DRY_RUN) {
    log(`[dry-run] would POST ${imports.length} imports`);
    return { ok: true, failed: new Set() };
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
      return none;
    }

    const result = await response.json();
    if (typeof result.processed !== "number") {
      log(`ERROR: server did not confirm the import (no 'processed' count); ensure JOBSYNC_API_URL uses https://. URL=${JOBSYNC_API_URL}`);
      return none;
    }
    const failed = new Set(Array.isArray(result.failedMessageIds) ? result.failedMessageIds : []);
    log(`Server POST: ${result.processed} processed, ${result.skipped} skipped, ${result.filed ?? 0} filed, ${result.pending ?? 0} pending, ${failed.size} failed`);
    if (failed.size > 0) log(`  not stored (left for retry): ${[...failed].join(", ")}`);
    return { ok: true, failed };
  } catch (error) {
    log(`Failed to send to server: ${error.message}`);
    return none;
  }
}

/**
 * PATCH corrections + extractedData updates. Returns
 * { ok, failed:Set<messageId>, notFound:Set<messageId> }.
 */
async function patchServer(corrections, updates) {
  const none = { ok: false, failed: new Set(), notFound: new Set() };
  if (corrections.length === 0 && updates.length === 0) return { ok: true, failed: new Set(), notFound: new Set() };
  if (!JOBSYNC_API_KEY) {
    log("JOBSYNC_API_KEY not set; cannot PATCH");
    return none;
  }
  if (DRY_RUN) {
    log(`[dry-run] would PATCH ${corrections.length} corrections, ${updates.length} updates`);
    return { ok: true, failed: new Set(), notFound: new Set() };
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
      return none;
    }

    const result = await response.json();
    if (typeof result.updated !== "number") {
      log(`ERROR: server did not confirm the PATCH (no 'updated' count); ensure JOBSYNC_API_URL uses https://`);
      return none;
    }
    const failed = new Set(Array.isArray(result.failedMessageIds) ? result.failedMessageIds : []);
    const notFound = new Set(Array.isArray(result.notFoundMessageIds) ? result.notFoundMessageIds : []);
    log(`Server PATCH: ${result.updated} updated, ${result.notFound} not found, ${result.filed ?? 0} filed, ${failed.size} failed`);
    return { ok: true, failed, notFound };
  } catch (error) {
    log(`Failed to patch server: ${error.message}`);
    return none;
  }
}

/**
 * DELETE demoted imports one by one. Returns the set of messageIds whose
 * delete was NOT confirmed (network/5xx); "not found" and "kept (approved)"
 * count as confirmed since the server state is known.
 */
async function deleteFromServer(messageIds) {
  const failed = new Set();
  if (messageIds.length === 0) return failed;
  if (!JOBSYNC_API_KEY) {
    log("JOBSYNC_API_KEY not set; cannot DELETE");
    messageIds.forEach((id) => failed.add(id));
    return failed;
  }
  if (DRY_RUN) {
    log(`[dry-run] would DELETE ${messageIds.length} imports`);
    return failed;
  }

  let deleted = 0;
  let notFound = 0;
  let kept = 0;

  for (const messageId of messageIds) {
    try {
      const cleanId = messageId.replace(/^<|>$/g, "");
      const url = `${JOBSYNC_API_URL}?messageId=${encodeURIComponent(cleanId)}`;

      const response = await fetch(url, {
        method: "DELETE",
        headers: { "x-api-key": JOBSYNC_API_KEY },
      });

      if (!response.ok) {
        failed.add(messageId);
        continue;
      }
      const result = await response.json();
      if (typeof result.deleted !== "number") {
        failed.add(messageId);
      } else if (result.deleted > 0) {
        deleted++;
      } else if (result.kept) {
        kept++;
        log(`  kept on server (already filed to a job; local tag moves to other): ${messageId}`);
      } else {
        notFound++;
      }
    } catch (error) {
      failed.add(messageId);
    }
  }

  log(`Server DELETE: ${deleted} deleted, ${notFound} not found, ${kept} kept (already filed to a job), ${failed.size} failed`);
  return failed;
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

/**
 * Classify one message. Pure: no tags moved, no server calls. Returns the
 * decision plus the server action it needs, or a failure status.
 */
async function classifyOne({ messageId, filePath, oldType }, index, total, classifier) {
  const parsed = await parseEmailFile(filePath);
  if (!parsed) {
    return { status: "parse_failed", messageId };
  }

  const shortSubject = parsed.subject.substring(0, 40).replace(/\n/g, " ");
  const tag = `[${index + 1}/${total}]`;

  let classification = classifyByRules(parsed);

  if (classification) {
    classification = { ...classification, source: "rules", stage: 0, reviewRequired: false };
    log(`${tag} [FAST-PATH:${classification.reason}] ${shortSubject} -> ${classification.type}`);
  } else {
    log(`${tag} [CLAUDE] Classifying: ${shortSubject}...`);
    const result = await classifier.classify(parsed);
    if (!result) {
      log(`${tag}   -> Classification failed, tags left unchanged for retry`);
      return { status: "classify_failed", messageId };
    }
    classification = { ...result, source: "claude" };
    log(`${tag}   -> ${result.type} (${(result.confidence * 100).toFixed(0)}%, stage ${result.stage}${result.reviewRequired ? ", REVIEW" : ""}, $${result.cost.toFixed(4)})`);
  }

  const isJobRelated = classification.type !== "other";
  const wasJobRelated = oldType && oldType !== "other";
  const changed = !!(oldType && oldType !== classification.type);
  if (changed) log(`${tag}   moved: ${oldType} -> ${classification.type}`);

  // Decide the server action
  let action = { kind: "none" };
  if (isJobRelated || classification.reviewRequired) {
    const importData = buildImportPayload(parsed, classification);
    if (REPROCESS && wasJobRelated) {
      action = {
        kind: "patch",
        importData,
        correction: oldType !== classification.type
          ? { messageId: parsed.messageId, originalType: oldType, correctedType: classification.type }
          : null,
        // Carries the new classification + confidence so a pending import on
        // the server is auto-filed when the classifier is now confident.
        update: {
          messageId: parsed.messageId,
          extractedData: importData.extractedData,
          classification: importData.classification,
          confidence: importData.confidence,
          reviewRequired: importData.reviewRequired,
          classificationStage: importData.classificationStage,
          classificationReason: importData.classificationReason,
        },
      };
    } else {
      action = { kind: "post", importData };
    }
  } else if (REPROCESS && wasJobRelated) {
    action = { kind: "delete", messageId: parsed.messageId };
  }

  return {
    status: "classified",
    messageId,
    parsedMessageId: parsed.messageId,
    oldType,
    newType: classification.type,
    changed,
    action,
  };
}

/**
 * Sync one batch's server actions. Returns the set of messageIds (notmuch
 * ids) whose server state is confirmed, so tags/progress can be committed.
 */
async function syncBatch(decisions) {
  const confirmed = new Set();
  const posts = decisions.filter((d) => d.action.kind === "post");
  const patches = decisions.filter((d) => d.action.kind === "patch");
  const deletes = decisions.filter((d) => d.action.kind === "delete");

  decisions.filter((d) => d.action.kind === "none").forEach((d) => confirmed.add(d.messageId));

  // Patch first: anything the server has never seen comes back notFound and
  // is POSTed below as a new import instead (heals pre-existing drift).
  const fallbackPosts = [];
  if (patches.length > 0) {
    const corrections = patches.map((d) => d.action.correction).filter(Boolean);
    const updates = patches.map((d) => d.action.update);
    log(`Batch: PATCHing ${corrections.length} reclassifications, ${updates.length} extraction updates...`);
    const r = await patchServer(corrections, updates);
    if (r.ok) {
      for (const d of patches) {
        const id = d.action.update.messageId;
        if (r.failed.has(id)) continue;
        if (r.notFound.has(id)) {
          fallbackPosts.push(d);
          continue;
        }
        confirmed.add(d.messageId);
      }
      if (fallbackPosts.length > 0) log(`  ${fallbackPosts.length} not on server; POSTing as new imports`);
    }
  }

  const allPosts = [...posts, ...fallbackPosts];
  if (allPosts.length > 0) {
    log(`Batch: POSTing ${allPosts.length} imports...`);
    const r = await sendToServer(allPosts.map((d) => d.action.importData));
    if (r.ok) {
      allPosts.forEach((d) => {
        if (!r.failed.has(d.action.importData.messageId)) confirmed.add(d.messageId);
      });
    }
  }

  if (deletes.length > 0) {
    log(`Batch: DELETEing ${deletes.length} demoted imports...`);
    const failed = await deleteFromServer(deletes.map((d) => d.action.messageId));
    deletes.forEach((d) => {
      if (!failed.has(d.action.messageId)) confirmed.add(d.messageId);
    });
  }

  return confirmed;
}

async function main() {
  if (REPROCESS) {
    log(`REPROCESS MODE: Re-classifying and re-extracting ${ONLY ? `jobsync/${ONLY}` : "all tagged"} emails...${DRY_RUN ? " (DRY RUN)" : ""}`);
  } else {
    log(`Finding untagged emails...${DRY_RUN ? " (DRY RUN)" : ""}`);
  }

  if (!JOBSYNC_API_KEY && !DRY_RUN) {
    log("ERROR: JOBSYNC_API_KEY not set (source ~/.jobsync/config)");
    process.exit(1);
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
  log(`Classifier: model=${classifier.config.model} threshold=${classifier.config.threshold} concurrency=${CONCURRENCY} batch=${BATCH}`);

  let processed = 0;
  let failed = 0;
  let moved = 0;
  let unsynced = 0;
  const transitions = {};

  // Work in batches: classify -> sync server -> only then move tags and record
  // progress for the confirmed ones. A server failure stops the run so the
  // remaining mail is retried next time instead of drifting.
  let aborted = false;
  for (let offset = 0; offset < emails.length && !aborted; offset += BATCH) {
    const batch = emails.slice(offset, offset + BATCH);
    log(`--- batch ${offset / BATCH + 1}/${Math.ceil(emails.length / BATCH)} (${batch.length} mails) ---`);

    const results = await runWithConcurrency(
      batch,
      (item, index, total) => classifyOne(item, offset + index, emails.length, classifier),
      CONCURRENCY
    );

    const decisions = [];
    for (const r of results) {
      if (r.error) {
        failed++;
        log(`Worker error: ${r.error.message || r.error}`);
      } else if (r.status !== "classified") {
        failed++;
      } else {
        decisions.push(r);
      }
    }
    if (classifier.totals.tripped) {
      log(`Classifier circuit breaker tripped (${classifier.config.maxConsecutiveFailures} consecutive failures); stopping after this batch.`);
      aborted = true;
    }

    const confirmed = await syncBatch(decisions);

    for (const d of decisions) {
      if (!confirmed.has(d.messageId)) {
        unsynced++;
        continue;
      }
      await setClassificationTag(d.messageId, d.newType, d.oldType);
      processed++;
      if (d.changed) {
        moved++;
        const key = `${d.oldType} -> ${d.newType}`;
        transitions[key] = (transitions[key] || 0) + 1;
      }
      if (REPROCESS) {
        progress[d.messageId] = { oldType: d.oldType, newType: d.newType, ts: new Date().toISOString() };
      }
    }
    if (REPROCESS) saveProgress(progress);

    if (decisions.length > 0 && confirmed.size < decisions.length) {
      const pendingServer = decisions.filter((d) => d.action.kind !== "none").length;
      if (pendingServer > 0 && confirmed.size === decisions.filter((d) => d.action.kind === "none").length) {
        log(`Server sync failed for this whole batch; stopping so the remaining ${emails.length - offset - batch.length} mails are retried next run.`);
        aborted = true;
      }
    }
  }

  const t = classifier.totals;
  log(`\nResults: ${processed} processed, ${moved} moved category, ${failed} failed to classify, ${unsynced} not synced (tags unchanged, will retry)`);
  for (const [key, count] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
    log(`  ${count.toString().padStart(4)}  ${key}`);
  }
  log(`Claude: calls=${t.calls} stage1=${t.stage1} stage2=${t.stage2} failures=${t.failures} cost=$${t.cost.toFixed(4)} time=${(t.durationMs / 1000).toFixed(1)}s`);
  log(aborted ? "Stopped early because the server could not be updated." : "Done!");
  if (aborted || unsynced > 0) process.exitCode = 3;
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
