#!/usr/bin/env node
/**
 * Classify/Reclassify Emails Script
 *
 * Default mode: Finds monitored emails without any jobsync/* tag and classifies them.
 * --reprocess mode: Re-classifies and re-extracts ALL tagged emails through the
 *   Ollama-primary pipeline and syncs changes to the server.
 *
 * Usage:
 *   node scripts/jobsync-reclassify-untagged.js              # untagged only
 *   node scripts/jobsync-reclassify-untagged.js --reprocess   # re-process all tagged emails
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const { CLASSIFICATION_TYPES, classifyByRules, htmlToText } = require("./lib/classification-rules");
const { CLASSIFICATION_SYSTEM_PROMPT, buildClassificationUserPrompt } = require("./lib/prompts");
const { extractByRules, mergeExtractedData, needsLLMFallback, buildExtractionPrompt, parseLLMResponse } = require("./lib/extraction-rules");

const execAsync = promisify(exec);

// CLI flags
const REPROCESS = process.argv.includes("--reprocess");

// Configuration
const JOBSYNC_API_URL =
  process.env.JOBSYNC_API_URL || "http://localhost:3000/api/email-sync";
const JOBSYNC_API_KEY = process.env.JOBSYNC_API_KEY || "";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_EXTRACTION_MODEL = process.env.OLLAMA_EXTRACTION_MODEL || "qwen2.5:14b";
const MONITORED_EMAILS = (
  process.env.MONITORED_EMAILS || "j@abaj.ai,aayushbajaj7@gmail.com"
).split(",");
const CONCURRENCY = parseInt(process.env.JOBSYNC_CONCURRENCY || "4", 10);

const JOBSYNC_DIR = path.join(process.env.HOME || "~", ".jobsync");
const CORRECTIONS_FILE = path.join(JOBSYNC_DIR, "corrections.json");

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
 * Find monitored emails that don't have any jobsync/* tag
 */
async function queryUntaggedEmails() {
  const emailClauses = MONITORED_EMAILS.map(
    (email) => `(from:${email} OR to:${email})`
  ).join(" OR ");
  const classificationTags = CLASSIFICATION_TYPES
    .map(t => `tag:jobsync/${t}`)
    .join(" OR ");

  const query = `(${emailClauses}) AND NOT tag:spam AND NOT tag:trash AND NOT (${classificationTags})`;

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
  const emailClauses = MONITORED_EMAILS.map(
    (email) => `(from:${email} OR to:${email})`
  ).join(" OR ");
  const classificationTags = CLASSIFICATION_TYPES
    .map(t => `tag:jobsync/${t}`)
    .join(" OR ");

  const query = `(${emailClauses}) AND NOT tag:spam AND NOT tag:trash AND (${classificationTags})`;

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
        // Get file path
        const { stdout: files } = await execAsync(
          `notmuch search --output=files '${msgId}'`
        );
        const firstFile = files.trim().split("\n")[0];
        if (!firstFile) continue;

        // Get current classification tag
        const { stdout: tagsOut } = await execAsync(
          `notmuch search --output=tags '${msgId}'`
        );
        const tags = tagsOut.trim().split("\n").filter(Boolean);
        const jobsyncTag = tags.find(t => t.startsWith("jobsync/"));
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

async function classifyWithOllama(email, corrections = []) {
  const userPrompt = buildClassificationUserPrompt(email, corrections);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `${CLASSIFICATION_SYSTEM_PROMPT}\n\n${userPrompt}`,
        stream: false,
        format: "json",
        options: {
          temperature: 0.1,
          num_predict: 400,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status}`);
    }

    const data = await response.json();
    const result = JSON.parse(data.response);

    return {
      type: result.type || "other",
      confidence: result.confidence || 0.5,
      extractedData: result.extractedData || {},
    };
  } catch (error) {
    log(`Ollama classification failed: ${error.message}`);
    return null;
  }
}

/**
 * Extract metadata using rules + LLM fallback
 */
async function extractMetadata(email) {
  let extracted = extractByRules(email);

  if (needsLLMFallback(extracted)) {
    const prompt = buildExtractionPrompt(email);
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_EXTRACTION_MODEL,
          prompt,
          stream: false,
          format: "json",
          options: { temperature: 0.1, num_predict: 200 },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const llmExtracted = parseLLMResponse(data.response);
        if (llmExtracted) {
          extracted = mergeExtractedData(extracted, llmExtracted);
        }
      }
    } catch (error) {
      // LLM extraction failed, continue with rule-based results
    }
  }

  return extracted;
}

/**
 * Set classification tag on an email, removing any old jobsync/* tags first
 */
async function setClassificationTag(messageId, newType, oldType) {
  try {
    const cleanId = messageId.replace(/^<|>$/g, "");
    const escapedId = cleanId.replace(/'/g, "'\\''");

    if (!newType || !CLASSIFICATION_TYPES.includes(newType)) return;

    // Build tag command: remove old tag if present, add new one
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

async function main() {
  if (REPROCESS) {
    log("REPROCESS MODE: Re-classifying and re-extracting all tagged emails...");
  } else {
    log("Finding untagged emails...");
  }

  // Check Ollama is running
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) throw new Error("Ollama not responding");
  } catch (e) {
    log("ERROR: Ollama is not running. Please start Ollama first.");
    process.exit(1);
  }

  // Load corrections for few-shot learning
  const correctionsData = loadCorrections();
  const corrections = correctionsData.corrections || [];
  if (corrections.length > 0) {
    log(`Loaded ${corrections.length} corrections for few-shot learning`);
  }

  // Find emails to process
  const emails = REPROCESS
    ? await queryTaggedEmails()
    : await queryUntaggedEmails();

  log(`Found ${emails.length} emails to ${REPROCESS ? "reprocess" : "classify"}`);

  if (emails.length === 0) {
    log("Nothing to do");
    return;
  }

  // Collect server actions
  const newImports = [];       // POST: newly job-related (was "other" or untagged)
  const patchCorrections = []; // PATCH corrections: classification changed (job-related -> job-related)
  const patchUpdates = [];     // PATCH updates: extractedData updates
  const toDelete = [];         // DELETE: was job-related, now "other"

  let processed = 0;
  let failed = 0;

  const results = await runWithConcurrency(
    emails,
    async ({ messageId, filePath, oldType }, index, total) => {
      const parsed = await parseEmailFile(filePath);
      if (!parsed) {
        return { status: "parse_failed" };
      }

      const shortSubject = parsed.subject.substring(0, 40).replace(/\n/g, " ");

      // Classify
      let classification = classifyByRules(parsed);

      if (classification) {
        log(`[${index + 1}/${total}] [FAST-PATH:${classification.reason}] ${shortSubject} -> ${classification.type}`);
      } else {
        log(`[${index + 1}/${total}] [LLM] Classifying: ${shortSubject}...`);
        classification = await classifyWithOllama(parsed, corrections);
        if (!classification) {
          return { status: "classify_failed" };
        }
        log(`[${index + 1}/${total}]   -> ${classification.type} (${(classification.confidence * 100).toFixed(0)}%)`);
      }

      // Update notmuch tag
      await setClassificationTag(messageId, classification.type, oldType);

      const isJobRelated = classification.type !== "other" && classification.confidence >= 0.6;
      const wasJobRelated = oldType && oldType !== "other";

      if (isJobRelated) {
        // Extract metadata using rules + LLM fallback
        const ruleExtracted = await extractMetadata(parsed);
        const extractedData = mergeExtractedData(
          classification.extractedData || {},
          ruleExtracted
        );

        const importData = {
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
          extractedData,
        };

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
            extractedData,
          });
          if (oldType !== classification.type) {
            log(`[${index + 1}/${total}]   reclassified: ${oldType} -> ${classification.type}`);
          }
        } else {
          // New import: was untagged or was "other"
          newImports.push(importData);
        }

        return { status: "job_related" };
      } else {
        // Now classified as "other"
        if (REPROCESS && wasJobRelated) {
          // Was job-related, now "other": delete from server
          toDelete.push(parsed.messageId);
          log(`[${index + 1}/${total}]   demoted: ${oldType} -> other (will delete from server)`);
        }
        return { status: "tagged" };
      }
    },
    CONCURRENCY
  );

  // Aggregate counts
  for (const result of results) {
    if (result.error || result.status === "classify_failed" || result.status === "parse_failed") {
      failed++;
    } else {
      processed++;
    }
  }

  log(`\nResults: ${processed} processed, ${failed} failed`);

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
