#!/usr/bin/env node
/**
 * Local Email Sync Script
 *
 * Runs locally with Ollama to classify emails, then sends
 * pre-classified data to the remote JobSync server.
 *
 * Usage:
 *   node scripts/jobsync-local-sync.js
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const { CLASSIFICATION_TYPES, classifyByRules, htmlToText } = require("./lib/classification-rules");
const { extractByRules, mergeExtractedData, needsLLMFallback, buildExtractionPrompt, parseLLMResponse } = require("./lib/extraction-rules");

const execAsync = promisify(exec);

// Configuration from environment
const JOBSYNC_API_URL =
  process.env.JOBSYNC_API_URL || "http://localhost:3000/api/email-sync";
const JOBSYNC_API_KEY = process.env.JOBSYNC_API_KEY || "";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const MONITORED_EMAILS = (
  process.env.MONITORED_EMAILS || "j@abaj.ai,aayushbajaj7@gmail.com"
).split(",");
const CONCURRENCY = parseInt(process.env.JOBSYNC_CONCURRENCY || "4", 10);

const JOBSYNC_DIR = path.join(process.env.HOME || "~", ".jobsync");
const LOG_FILE = path.join(JOBSYNC_DIR, "local-sync.log");
const CORRECTIONS_FILE = path.join(JOBSYNC_DIR, "corrections.json");
const IS_TTY = process.stdout.isTTY;

// CLASSIFICATION_TYPES, classifyByRules, htmlToText imported from ./lib/classification-rules.js

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

function progressBar(current, total, width = 30) {
  const percent = total > 0 ? current / total : 0;
  const filled = Math.round(width * percent);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${current}/${total} (${(percent * 100).toFixed(0)}%)`;
}

function updateProgress(current, total, message = "") {
  if (IS_TTY) {
    // Clear line and show progress
    process.stdout.write(`\r${progressBar(current, total)} ${message}`.padEnd(100));
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
 * Save corrections to file
 */
function saveCorrections(data) {
  try {
    fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log(`Failed to save corrections: ${e.message}`);
  }
}

/**
 * Build few-shot examples from recent corrections
 */
function buildFewShotExamples(corrections, maxExamples = 5) {
  if (!corrections || corrections.length === 0) return "";

  // Get most recent corrections
  const recent = corrections.slice(-maxExamples);

  const examples = recent.map((c, i) => {
    return `Example ${i + 1} (CORRECTED - was "${c.originalType}", should be "${c.correctedType}"):
Subject: ${c.subject}
From: ${c.from}
Direction: ${c.isOutbound ? "SENT" : "RECEIVED"}
Body preview: ${(c.bodyPreview || "").substring(0, 500)}
CORRECT classification: ${c.correctedType}`;
  }).join("\n\n");

  return `\n\nHere are some examples of previous corrections to learn from:\n${examples}\n\nNow classify the following email:`;
}

/**
 * Run async tasks with limited concurrency
 */
async function runWithConcurrency(items, fn, concurrency) {
  const results = [];
  let index = 0;
  let completed = 0;

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
      completed++;
    }
  }

  // Start workers
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

async function classifyWithOllama(email, corrections = []) {
  const systemPrompt = `You are an email classifier for job search tracking. Classify emails into one of these categories:
- job_application: Email SENT BY the user applying for a job
- job_response: Company acknowledging receipt of application
- interview: Interview invitation or scheduling
- rejection: Application rejected
- offer: Job offer received
- follow_up: Follow-up correspondence about an application
- other: Not job-related

Also extract: company name, job title, location, application URL, recruiter name, salary range (if mentioned).

Respond ONLY with valid JSON in this exact format:
{"type":"category","confidence":0.95,"extractedData":{"company":"Name","jobTitle":"Title","location":"City","applicationUrl":"url","recruiterName":"Name","salaryRange":"range"}}`;

  // Add few-shot examples from corrections if available
  const fewShotExamples = buildFewShotExamples(corrections);

  const userPrompt = `${fewShotExamples}

Direction: ${email.isOutbound ? "SENT" : "RECEIVED"}
From: ${email.fromName || email.from}
To: ${email.to}
Subject: ${email.subject}
Date: ${email.date.toISOString()}

Body:
${(email.textBody || "(No text body)").substring(0, 3000)}`;

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `${systemPrompt}\n\n${userPrompt}`,
        stream: false,
        format: "json",
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

async function markEmailProcessed(messageId, classificationType = null) {
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

/**
 * Extract metadata using rules, with optional LLM fallback
 */
async function extractMetadata(email, useLLMFallback = true) {
  // First try rule-based extraction
  let extracted = extractByRules(email);

  // If missing critical fields and LLM fallback is enabled, use Ollama
  if (useLLMFallback && needsLLMFallback(extracted)) {
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

async function sendToServer(imports) {
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
    return true;
  } catch (error) {
    log(`Failed to send to server: ${error.message}`);
    return false;
  }
}

async function processOneEmail(filePath, index, total, corrections = []) {
  const parsed = await parseEmailFile(filePath);
  if (!parsed) {
    return { status: "parse_failed" };
  }

  const shortSubject = parsed.subject.substring(0, 40).replace(/\n/g, " ");

  // Try rule-based classification first (fast, no LLM needed)
  let classification = classifyByRules(parsed);
  let classificationSource = "rules";

  if (classification) {
    log(`[${index + 1}/${total}] [RULE:${classification.reason}] ${shortSubject} -> ${classification.type}`);
  } else {
    // Fall back to Ollama for complex cases
    log(`[${index + 1}/${total}] [LLM] Classifying: ${shortSubject}...`);
    classification = await classifyWithOllama(parsed, corrections);
    classificationSource = "ollama";

    if (!classification) {
      log(`[${index + 1}/${total}]   -> Classification failed, will retry later`);
      return { status: "classify_failed" };
    }

    log(`[${index + 1}/${total}]   -> ${classification.type} (${(classification.confidence * 100).toFixed(0)}%)`);
  }

  if (!isJobRelated(classification) || classification.confidence < 0.6) {
    await markEmailProcessed(parsed.messageId, classification.type);
    return { status: "skipped", reason: "not job-related", source: classificationSource };
  }

  // Extract comprehensive metadata using rules + LLM fallback
  const ruleExtracted = await extractMetadata(parsed, true);

  // Merge with any LLM-extracted data from classification (prefer rule-based)
  const extractedData = mergeExtractedData(
    classification.extractedData || {},
    ruleExtracted
  );

  await markEmailProcessed(parsed.messageId, classification.type);
  return {
    status: "job_related",
    source: classificationSource,
    data: {
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
    },
  };
}

async function main() {
  // Ensure log directory exists
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  log("Starting local email sync...");

  if (!JOBSYNC_API_KEY) {
    log("ERROR: JOBSYNC_API_KEY not set");
    process.exit(1);
  }

  log(`API URL: ${JOBSYNC_API_URL}`);
  log(`Concurrency: ${CONCURRENCY}`);

  // Load corrections for few-shot learning
  const correctionsData = loadCorrections();
  const corrections = correctionsData.corrections || [];
  if (corrections.length > 0) {
    log(`Loaded ${corrections.length} corrections for few-shot learning`);
  }

  // Query for new emails
  const emailPaths = await queryNewEmails();

  if (emailPaths.length === 0) {
    log("No new emails to process");
    return;
  }

  log(`Processing ${emailPaths.length} emails with ${CONCURRENCY} concurrent workers...`);

  // Process all emails with concurrency (pass corrections to each worker)
  const results = await runWithConcurrency(
    emailPaths,
    (filePath, index, total) => processOneEmail(filePath, index, total, corrections),
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
    } else if (result.status === "job_related") {
      toSend.push(result.data);
      jobRelated++;
    } else if (result.status === "classify_failed") {
      failed++;
    } else {
      skipped++;
    }
  }

  log(`Results: ${jobRelated} job-related, ${skipped} skipped, ${failed} failed`);

  if (toSend.length > 0) {
    log(`Sending ${toSend.length} emails to server...`);
    const success = await sendToServer(toSend);
    if (success) {
      log("Sync completed successfully");
    } else {
      log("Sync failed - check server logs");
    }
  } else {
    log("No job-related emails to send");
  }
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
