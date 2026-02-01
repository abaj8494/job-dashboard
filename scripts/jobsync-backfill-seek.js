#!/usr/bin/env node
/**
 * Backfill SEEK Email Extraction
 *
 * Finds SEEK application confirmation emails and extracts
 * company/job title to update existing EmailImport records.
 *
 * Usage:
 *   node scripts/jobsync-backfill-seek.js [--dry-run]
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const { simpleParser } = require("mailparser");
const fs = require("fs");

const execAsync = promisify(exec);

const JOBSYNC_API_URL = process.env.JOBSYNC_API_URL || "http://localhost:3000/api/email-sync";
const JOBSYNC_API_KEY = process.env.JOBSYNC_API_KEY || "";
const DRY_RUN = process.argv.includes("--dry-run");

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

/**
 * Extract job title and company from SEEK email body
 */
function extractSeekData(textBody) {
  // Pattern: "your application for {Job Title} was successfully submitted to {Company}"
  const match = (textBody || "").match(
    /application for\s+(.+?)\s+was\s+(?:successfully\s+)?submitted\s+to\s+(.+?)(?:\.|$)/im
  );
  if (match) {
    return {
      jobTitle: match[1].trim(),
      company: match[2].trim(),
    };
  }
  return null;
}

/**
 * Parse email file
 */
async function parseEmailFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const parsed = await simpleParser(content);
    return {
      messageId: parsed.messageId,
      subject: parsed.subject || "",
      textBody: parsed.text || "",
    };
  } catch (e) {
    log(`Failed to parse ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * Update extractedData on server
 */
async function updateExtractedData(messageId, extractedData) {
  if (!JOBSYNC_API_KEY) {
    log("JOBSYNC_API_KEY not set");
    return false;
  }

  try {
    // Use PATCH endpoint to update
    const response = await fetch(JOBSYNC_API_URL, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JOBSYNC_API_KEY,
      },
      body: JSON.stringify({
        updates: [{
          messageId,
          extractedData,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log(`Server error: ${response.status} - ${text}`);
      return false;
    }

    return true;
  } catch (e) {
    log(`Failed to update ${messageId}: ${e.message}`);
    return false;
  }
}

async function main() {
  log(DRY_RUN ? "Starting SEEK backfill (DRY RUN)..." : "Starting SEEK backfill...");

  if (!JOBSYNC_API_KEY && !DRY_RUN) {
    log("ERROR: JOBSYNC_API_KEY not set");
    process.exit(1);
  }

  // Find today's SEEK emails
  const query = 'date:today from:seek tag:jobsync/job_response';

  try {
    const { stdout } = await execAsync(
      `notmuch search --output=files "${query}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const files = stdout.trim().split("\n").filter(Boolean);
    log(`Found ${files.length} SEEK emails from today`);

    if (files.length === 0) {
      log("Nothing to backfill");
      return;
    }

    let updated = 0;
    let skipped = 0;

    for (const filePath of files) {
      const email = await parseEmailFile(filePath);
      if (!email) {
        skipped++;
        continue;
      }

      const extracted = extractSeekData(email.textBody);
      if (!extracted) {
        log(`No data extracted from: ${email.subject.substring(0, 50)}...`);
        skipped++;
        continue;
      }

      log(`${email.subject.substring(0, 40)}...`);
      log(`  -> Company: ${extracted.company}`);
      log(`  -> Job Title: ${extracted.jobTitle}`);

      if (!DRY_RUN) {
        const success = await updateExtractedData(email.messageId, extracted);
        if (success) {
          updated++;
        } else {
          skipped++;
        }
      } else {
        updated++;
      }
    }

    log(`\nBackfill complete: ${updated} updated, ${skipped} skipped`);
  } catch (e) {
    log(`Query failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
