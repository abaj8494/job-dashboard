#!/usr/bin/env node
/**
 * Scan for User Corrections Script
 *
 * Detects when users have manually changed jobsync classification tags
 * and records them as corrections for few-shot learning.
 *
 * Usage:
 *   node scripts/jobsync-scan-corrections.js
 *
 * How it works:
 * 1. Queries notmuch for emails with jobsync-was/* tag (indicates a correction)
 * 2. Compares jobsync-was/<original> with current jobsync/<type>
 * 3. Syncs corrections to server and records high-variance ones for few-shot learning
 *
 * The user workflow:
 * 1. Email is classified as "rejection" -> tagged with jobsync/rejection
 * 2. User presses J to rotate: adds jobsync-was/rejection (original), changes to jobsync/interview
 * 3. This script detects the change and syncs it to the server
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const { CLASSIFICATION_TYPES, isHighVarianceCorrection } = require("./lib/classification-rules");

const execAsync = promisify(exec);

const JOBSYNC_DIR = path.join(process.env.HOME || "~", ".jobsync");
const CORRECTIONS_FILE = path.join(JOBSYNC_DIR, "corrections.json");

// Load config for API settings
const JOBSYNC_API_URL =
  process.env.JOBSYNC_API_URL || "http://localhost:3000/api/email-sync";
const JOBSYNC_API_KEY = process.env.JOBSYNC_API_KEY || "";

// High-variance corrections cap (for few-shot learning)
const MAX_HIGH_VARIANCE_CORRECTIONS = 50;

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

/**
 * Load existing corrections
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
 * Save corrections
 */
function saveCorrections(data) {
  try {
    fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log(`Failed to save corrections: ${e.message}`);
  }
}


/**
 * Get the jobsync/* tags for a message
 */
async function getJobsyncTags(messageId) {
  try {
    const { stdout } = await execAsync(`notmuch search --output=tags 'id:${messageId}'`);
    const tags = stdout.trim().split("\n").filter(Boolean);
    const jobsyncTags = tags.filter(t => t.startsWith("jobsync/"));
    return jobsyncTags.map(t => t.replace("jobsync/", ""));
  } catch (e) {
    return [];
  }
}

/**
 * Parse email file to get context for few-shot learning and server import
 */
async function parseEmailForCorrection(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const parsed = await simpleParser(content);

    const fromAddress = parsed.from?.value?.[0]?.address || parsed.from?.text || "";
    const toAddress = parsed.to
      ? Array.isArray(parsed.to)
        ? parsed.to[0]?.value?.[0]?.address || ""
        : parsed.to.value?.[0]?.address || parsed.to.text || ""
      : "";
    const monitoredEmails = (process.env.MONITORED_EMAILS || "j@abaj.ai,aayushbajaj7@gmail.com").split(",");
    const isOutbound = monitoredEmails.some(
      (email) => fromAddress.toLowerCase() === email.toLowerCase()
    );

    return {
      messageId: parsed.messageId || `generated-${Date.now()}-${Math.random()}`,
      subject: parsed.subject || "(No subject)",
      from: fromAddress,
      fromName: parsed.from?.value?.[0]?.name,
      to: toAddress,
      date: parsed.date || new Date(),
      isOutbound,
      bodyPreview: (parsed.text || "").substring(0, 1000),
      textBody: parsed.text || "", // Full text for rule checking
      htmlBody: parsed.html || undefined,
    };
  } catch (e) {
    log(`Failed to parse email: ${e.message}`);
    return null;
  }
}

/**
 * Query for emails that have been corrected by the user
 *
 * Detection strategy:
 * - Find emails with jobsync-corrected tag (user explicitly marks corrections)
 * OR
 * - Find emails with multiple jobsync/* tags (indicates tag change)
 */
async function findCorrectedEmails() {
  const corrections = [];

  // Strategy 1: Look for emails explicitly tagged as corrected
  try {
    const { stdout } = await execAsync(
      `notmuch search --output=messages 'tag:jobsync-corrected'`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const messageIds = stdout.trim().split("\n").filter(Boolean);

    for (const msgId of messageIds) {
      corrections.push({ messageId: msgId.replace(/^id:/, ""), source: "explicit" });
    }
  } catch (e) {
    // No explicitly corrected emails, that's fine
  }

  // Strategy 2: Look for emails with correction marker in tags
  // User can tag with jobsync-was/<original_type> to indicate what it was originally
  for (const type of CLASSIFICATION_TYPES) {
    try {
      const { stdout } = await execAsync(
        `notmuch search --output=messages 'tag:jobsync-was/${type}'`,
        { maxBuffer: 10 * 1024 * 1024 }
      );
      const messageIds = stdout.trim().split("\n").filter(Boolean);

      for (const msgId of messageIds) {
        corrections.push({
          messageId: msgId.replace(/^id:/, ""),
          originalType: type,
          source: "was-tag"
        });
      }
    } catch (e) {
      // Continue
    }
  }

  return corrections;
}

/**
 * Send corrections to the server to update database classifications
 * Only for corrections between job-related types (not from "other")
 */
async function sendCorrectionsToServer(corrections) {
  if (!JOBSYNC_API_KEY) {
    log("JOBSYNC_API_KEY not set, skipping server sync");
    return;
  }

  if (corrections.length === 0) {
    return;
  }

  try {
    const response = await fetch(JOBSYNC_API_URL, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JOBSYNC_API_KEY,
      },
      body: JSON.stringify({
        corrections: corrections.map((c) => ({
          messageId: c.messageId,
          originalType: c.originalType,
          correctedType: c.correctedType,
        })),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log(`Server returned ${response.status}: ${text}`);
      return;
    }

    const result = await response.json();
    log(`Server sync: ${result.updated} updated, ${result.notFound} not found`);
  } catch (error) {
    log(`Failed to send corrections to server: ${error.message}`);
  }
}

/**
 * Delete emails from the server
 * Used when correcting job-related -> "other" (no longer job-related)
 */
async function deleteFromServer(items) {
  if (!JOBSYNC_API_KEY) {
    log("JOBSYNC_API_KEY not set, skipping deletions");
    return;
  }

  if (items.length === 0) {
    return;
  }

  let deleted = 0;
  let notFound = 0;

  for (const { messageId, subject } of items) {
    try {
      const cleanId = messageId.replace(/^<|>$/g, "");
      const url = `${JOBSYNC_API_URL}?messageId=${encodeURIComponent(cleanId)}`;

      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          "x-api-key": JOBSYNC_API_KEY,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        log(`Failed to delete "${subject.substring(0, 30)}...": ${text}`);
        notFound++;
        continue;
      }

      const result = await response.json();
      if (result.deleted > 0) {
        deleted++;
      } else {
        notFound++;
      }
    } catch (error) {
      log(`Failed to delete ${messageId}: ${error.message}`);
      notFound++;
    }
  }

  log(`Demotions: ${deleted} deleted from server, ${notFound} not found`);
}

/**
 * Send new imports to the server
 * Used when correcting "other" -> job-related (email wasn't on server before)
 */
async function sendNewImportsToServer(imports) {
  if (!JOBSYNC_API_KEY) {
    log("JOBSYNC_API_KEY not set, skipping new imports");
    return;
  }

  if (imports.length === 0) {
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
      log(`Server returned ${response.status}: ${text}`);
      return;
    }

    const result = await response.json();
    log(`New imports: ${result.processed} added, ${result.skipped} skipped`);
  } catch (error) {
    log(`Failed to send new imports to server: ${error.message}`);
  }
}

async function main() {
  log("Scanning for user corrections...");

  // Ensure directory exists
  if (!fs.existsSync(JOBSYNC_DIR)) {
    fs.mkdirSync(JOBSYNC_DIR, { recursive: true });
  }

  const existingData = loadCorrections();
  const correctedEmails = await findCorrectedEmails();

  log(`Found ${correctedEmails.length} emails with correction tags`);

  let newCorrections = 0;
  const correctionsList = [];  // For job-related -> job-related (PATCH)
  const newImportsList = [];   // For "other" -> job-related (POST)
  const deleteList = [];       // For job-related -> "other" (DELETE from server)

  for (const { messageId, originalType, source } of correctedEmails) {
    // Get current tags
    const currentTags = await getJobsyncTags(messageId);
    if (currentTags.length === 0) {
      continue;
    }

    // Determine corrected type (current tag)
    const correctedType = currentTags.find(t => CLASSIFICATION_TYPES.includes(t));
    if (!correctedType) {
      continue;
    }

    // For was-tag source, we already have the original type
    // For explicit source, we need to find the jobsync-was/* tag
    let origType = originalType;
    if (!origType && source === "explicit") {
      // Look for was tag
      try {
        const { stdout } = await execAsync(`notmuch search --output=tags 'id:${messageId}'`);
        const tags = stdout.trim().split("\n").filter(Boolean);
        const wasTag = tags.find(t => t.startsWith("jobsync-was/"));
        if (wasTag) {
          origType = wasTag.replace("jobsync-was/", "");
        }
      } catch (e) {
        // Skip
      }
    }

    // Skip if we can't determine original type or if it's the same
    if (!origType || origType === correctedType) {
      continue;
    }

    // Get email file for context
    let filePath;
    try {
      const { stdout } = await execAsync(`notmuch search --output=files 'id:${messageId}'`);
      filePath = stdout.trim().split("\n")[0];
    } catch (e) {
      continue;
    }

    if (!filePath) continue;

    const emailData = await parseEmailForCorrection(filePath);
    if (!emailData) continue;

    // Check if this is a high-variance correction (rules wouldn't catch it)
    const highVariance = isHighVarianceCorrection(emailData, origType, correctedType);

    // Create correction record for few-shot learning
    const correction = {
      messageId,
      originalType: origType,
      correctedType,
      subject: emailData.subject,
      from: emailData.from,
      fromName: emailData.fromName,
      to: emailData.to,
      isOutbound: emailData.isOutbound,
      bodyPreview: emailData.bodyPreview,
      correctedAt: new Date().toISOString(),
      highVariance, // Track if this is useful for few-shot learning
    };

    newCorrections++;

    // Handle differently based on original and corrected types
    if (origType === "other" && correctedType !== "other") {
      // "other" -> job-related: email wasn't on server, need to send as new import
      const importData = {
        messageId: emailData.messageId,
        subject: emailData.subject,
        fromEmail: emailData.from,
        fromName: emailData.fromName,
        toEmail: emailData.to,
        emailDate: emailData.date.toISOString(),
        bodyText: (emailData.textBody || "").substring(0, 10000),
        bodyHtml: (emailData.htmlBody || "").substring(0, 50000),
        classification: correctedType,
        confidence: 1.0, // User-corrected = 100% confidence
        isOutbound: emailData.isOutbound,
        extractedData: {}, // User can edit on server if needed
      };
      newImportsList.push(importData);
      log(`Promoting from "other": "${emailData.subject.substring(0, 40)}..." -> ${correctedType}`);
    } else if (correctedType === "other" && origType !== "other") {
      // job-related -> "other": delete from server (no longer job-related)
      deleteList.push({ messageId, subject: emailData.subject });
      if (highVariance) {
        log(`Demoting to "other" (will delete): "${emailData.subject.substring(0, 40)}..." ${origType} -> other`);
      } else {
        log(`Demoting to "other" (rule-catchable): "${emailData.subject.substring(0, 40)}..." ${origType} -> other`);
      }
    } else if (origType !== "other" && correctedType !== "other") {
      // job-related -> job-related: update existing record on server
      correctionsList.push(correction);
      if (highVariance) {
        log(`Recorded HIGH-VARIANCE correction: "${emailData.subject.substring(0, 40)}..." ${origType} -> ${correctedType}`);
      } else {
        log(`Recorded rule-catchable correction: "${emailData.subject.substring(0, 40)}..." ${origType} -> ${correctedType}`);
      }
    }

    // Only add high-variance corrections to the few-shot learning list
    if (highVariance) {
      existingData.corrections.push(correction);
    }

    // Clean up the was tag (keep only the corrected tag)
    try {
      await execAsync(`notmuch tag -jobsync-was/${origType} -jobsync-corrected -- 'id:${messageId}'`);
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  // Keep only the most recent high-variance corrections (for prompt size management)
  if (existingData.corrections.length > MAX_HIGH_VARIANCE_CORRECTIONS) {
    existingData.corrections = existingData.corrections.slice(-MAX_HIGH_VARIANCE_CORRECTIONS);
  }

  existingData.lastScan = new Date().toISOString();
  saveCorrections(existingData);

  const highVarianceCount = existingData.corrections.length;
  log(`Scan complete. Processed ${newCorrections} corrections. High-variance for few-shot: ${highVarianceCount}`);

  // Send new imports to server (for "other" -> job-related promotions)
  if (newImportsList.length > 0) {
    log(`Sending ${newImportsList.length} promoted emails to server...`);
    await sendNewImportsToServer(newImportsList);
  }

  // Send corrections to server to update existing records
  if (correctionsList.length > 0) {
    log(`Syncing ${correctionsList.length} corrections to server...`);
    await sendCorrectionsToServer(correctionsList);
  }

  // Delete from server (for job-related -> "other" demotions)
  if (deleteList.length > 0) {
    log(`Removing ${deleteList.length} demoted emails from server...`);
    await deleteFromServer(deleteList);
  }

  // Print usage instructions if no corrections found
  if (existingData.corrections.length === 0) {
    log("\nTo correct a classification:");
    log("1. Find the email in notmuch");
    log("2. Add a 'jobsync-was/<original_type>' tag (e.g., jobsync-was/rejection)");
    log("3. Change the jobsync/<type> tag to the correct one");
    log("4. Run this script again to record the correction");
    log("\nExample: Email was wrongly classified as 'rejection' but is actually 'interview':");
    log("  notmuch tag +jobsync-was/rejection -jobsync/rejection +jobsync/interview -- id:abc123");
  }
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
