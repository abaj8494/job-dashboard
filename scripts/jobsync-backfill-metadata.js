#!/usr/bin/env node
/**
 * Backfill Email Import Metadata
 *
 * Finds email imports missing company/jobTitle and extracts metadata
 * using regex patterns and LLM fallback.
 *
 * Usage:
 *   node scripts/jobsync-backfill-metadata.js [--dry-run] [--limit=N] [--llm]
 *
 * Options:
 *   --dry-run   Preview without updating
 *   --limit=N   Process only N emails (default: all)
 *   --llm       Use LLM fallback for extraction
 *   --force     Re-extract even if data exists
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const {
  extractByRules,
  buildExtractionPrompt,
  parseLLMResponse,
  mergeExtractedData,
  needsLLMFallback,
} = require("./lib/extraction-rules");
const { htmlToText } = require("./lib/classification-rules");

const execAsync = promisify(exec);

// Configuration
const JOBSYNC_API_URL =
  process.env.JOBSYNC_API_URL || "http://localhost:3000/api/email-sync";
const JOBSYNC_API_KEY = process.env.JOBSYNC_API_KEY || "";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";

// Parse arguments
const DRY_RUN = process.argv.includes("--dry-run");
const USE_LLM = process.argv.includes("--llm");
const FORCE = process.argv.includes("--force");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.replace("--limit=", ""), 10) : null;

const JOBSYNC_DIR = path.join(process.env.HOME || "~", ".jobsync");
const LOG_FILE = path.join(JOBSYNC_DIR, "backfill-metadata.log");

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  try {
    fs.appendFileSync(LOG_FILE, logMessage + "\n");
  } catch (e) {
    // ignore
  }
}

/**
 * Fetch email imports that need metadata extraction
 */
async function fetchEmailImports() {
  log("Fetching email imports from database...");

  // We'll query via a local script since we can't easily call the API for this
  // Instead, we'll use notmuch to find emails and match by messageId
  const query = FORCE
    ? 'tag:jobsync/job_response OR tag:jobsync/job_application OR tag:jobsync/interview OR tag:jobsync/rejection OR tag:jobsync/offer'
    : 'tag:jobsync/job_response OR tag:jobsync/job_application OR tag:jobsync/interview OR tag:jobsync/rejection OR tag:jobsync/offer';

  try {
    const { stdout } = await execAsync(
      `notmuch search --output=messages "${query}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const messageIds = stdout.trim().split("\n").filter(Boolean);
    log(`Found ${messageIds.length} classified emails in notmuch`);

    return messageIds;
  } catch (error) {
    log(`Failed to query notmuch: ${error.message}`);
    return [];
  }
}

/**
 * Get file path for a message ID
 */
async function getEmailFilePath(messageId) {
  try {
    // Clean message ID (remove < and > if present)
    const cleanId = messageId.replace(/^id:/, "").replace(/^<|>$/g, "");
    const { stdout } = await execAsync(
      `notmuch search --output=files "id:${cleanId}"`,
      { maxBuffer: 1024 * 1024 }
    );
    const files = stdout.trim().split("\n").filter(Boolean);
    return files[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * Parse email file
 */
async function parseEmailFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const parsed = await simpleParser(content);

    const fromAddress =
      parsed.from?.value?.[0]?.address || parsed.from?.text || "";
    const textBody = parsed.text || htmlToText(parsed.html) || "";

    return {
      messageId: parsed.messageId,
      subject: parsed.subject || "(No subject)",
      from: fromAddress,
      fromName: parsed.from?.value?.[0]?.name,
      to: parsed.to?.value?.[0]?.address || "",
      date: parsed.date || new Date(),
      textBody,
      htmlBody: parsed.html || undefined,
    };
  } catch (error) {
    log(`Failed to parse ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Call Ollama for LLM extraction
 */
async function extractWithLLM(email) {
  const prompt = buildExtractionPrompt(email);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 200,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = await response.json();
    return parseLLMResponse(data.response);
  } catch (error) {
    log(`LLM extraction failed: ${error.message}`);
    return null;
  }
}

/**
 * Update email import via API
 */
async function updateEmailImport(messageId, extractedData) {
  if (!JOBSYNC_API_KEY) {
    log("JOBSYNC_API_KEY not set");
    return false;
  }

  try {
    const response = await fetch(JOBSYNC_API_URL, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JOBSYNC_API_KEY,
      },
      body: JSON.stringify({
        updates: [
          {
            messageId,
            extractedData,
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log(`Server error: ${response.status} - ${text}`);
      return false;
    }

    return true;
  } catch (error) {
    log(`Failed to update ${messageId}: ${error.message}`);
    return false;
  }
}

/**
 * Get current tags for a message
 */
async function getMessageTags(messageId) {
  try {
    const cleanId = messageId.replace(/^id:/, "").replace(/^<|>$/g, "");
    const { stdout } = await execAsync(
      `notmuch search --output=tags "id:${cleanId}"`,
      { maxBuffer: 1024 * 1024 }
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch (error) {
    return [];
  }
}

/**
 * Main backfill function
 */
async function main() {
  const mode = DRY_RUN ? " (DRY RUN)" : "";
  const llmMode = USE_LLM ? " with LLM fallback" : " (regex only)";
  log(`Starting metadata backfill${mode}${llmMode}...`);

  if (!JOBSYNC_API_KEY && !DRY_RUN) {
    log("ERROR: JOBSYNC_API_KEY not set");
    process.exit(1);
  }

  // Ensure log directory exists
  try {
    fs.mkdirSync(JOBSYNC_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }

  const messageIds = await fetchEmailImports();

  if (messageIds.length === 0) {
    log("No emails to process");
    return;
  }

  const toProcess = LIMIT ? messageIds.slice(0, LIMIT) : messageIds;
  log(`Processing ${toProcess.length} emails...`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let needsLLM = 0;

  for (const messageId of toProcess) {
    processed++;
    const cleanId = messageId.replace(/^id:/, "");

    // Get file path
    const filePath = await getEmailFilePath(cleanId);
    if (!filePath) {
      log(`[${processed}/${toProcess.length}] No file found for ${cleanId}`);
      errors++;
      continue;
    }

    // Parse email
    const email = await parseEmailFile(filePath);
    if (!email) {
      errors++;
      continue;
    }

    // Extract metadata using rules
    let extracted = extractByRules(email);

    // Use LLM fallback if needed and enabled
    if (USE_LLM && needsLLMFallback(extracted)) {
      needsLLM++;
      const llmExtracted = await extractWithLLM(email);
      if (llmExtracted) {
        extracted = mergeExtractedData(extracted, llmExtracted);
      }
    }

    // Check if we extracted anything useful
    if (!extracted.company && !extracted.jobTitle) {
      log(
        `[${processed}/${toProcess.length}] No data extracted: ${email.subject.substring(0, 50)}...`
      );
      skipped++;
      continue;
    }

    // Log what we found
    const preview = [
      extracted.company ? `Company: ${extracted.company}` : null,
      extracted.jobTitle ? `Title: ${extracted.jobTitle}` : null,
      extracted.location ? `Location: ${extracted.location}` : null,
      extracted.source ? `Source: ${extracted.source}` : null,
      extracted.jobType ? `Type: ${extracted.jobType}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    log(`[${processed}/${toProcess.length}] ${email.subject.substring(0, 40)}...`);
    log(`  -> ${preview}`);

    // Update if not dry run
    if (!DRY_RUN) {
      const success = await updateEmailImport(email.messageId, extracted);
      if (success) {
        updated++;
      } else {
        errors++;
      }
    } else {
      updated++;
    }

    // Small delay to avoid overwhelming Ollama
    if (USE_LLM) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  log("\n=== Backfill Summary ===");
  log(`Total processed: ${processed}`);
  log(`Updated: ${updated}`);
  log(`Skipped (no data): ${skipped}`);
  log(`Errors: ${errors}`);
  if (USE_LLM) {
    log(`Required LLM: ${needsLLM}`);
  }
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
