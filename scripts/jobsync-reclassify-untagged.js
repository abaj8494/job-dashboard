#!/usr/bin/env node
/**
 * Re-classify Untagged Emails Script
 *
 * Finds emails with jobsync-processed but no jobsync/* classification tag
 * and re-classifies them with Ollama.
 *
 * Usage:
 *   node scripts/jobsync-reclassify-untagged.js
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");

const execAsync = promisify(exec);

// Configuration
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
const CORRECTIONS_FILE = path.join(JOBSYNC_DIR, "corrections.json");

const CLASSIFICATION_TYPES = [
  "job_application",
  "job_response",
  "interview",
  "rejection",
  "offer",
  "follow_up",
  "other"
];

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

function buildFewShotExamples(corrections, maxExamples = 5) {
  if (!corrections || corrections.length === 0) return "";
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

async function queryUntaggedEmails() {
  const classificationTags = CLASSIFICATION_TYPES
    .map(t => `tag:jobsync/${t}`)
    .join(" OR ");

  const query = `tag:jobsync-processed AND NOT (${classificationTags})`;

  try {
    const { stdout } = await execAsync(
      `notmuch search --output=messages "${query}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const messageIds = stdout.trim().split("\n").filter(Boolean);

    if (messageIds.length === 0) return [];

    // Get file paths for each message
    const results = [];
    for (const msgId of messageIds) {
      try {
        const { stdout: files } = await execAsync(
          `notmuch search --output=files '${msgId}'`
        );
        const firstFile = files.trim().split("\n")[0];
        if (firstFile) {
          results.push({ messageId: msgId.replace(/^id:/, ""), filePath: firstFile });
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
      textBody: parsed.text,
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

async function addClassificationTag(messageId, classificationType) {
  try {
    const cleanId = messageId.replace(/^<|>$/g, "");
    const escapedId = cleanId.replace(/'/g, "'\\''");

    if (classificationType && CLASSIFICATION_TYPES.includes(classificationType)) {
      await execAsync(`notmuch tag +jobsync/${classificationType} -- 'id:${escapedId}'`);
    }
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
      log(`Server returned ${response.status}: ${text}`);
      return;
    }

    const result = await response.json();
    log(`Server: ${result.processed} processed, ${result.skipped} skipped`);
  } catch (error) {
    log(`Failed to send to server: ${error.message}`);
  }
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
  log("Finding untagged emails...");

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

  // Find untagged emails
  const untagged = await queryUntaggedEmails();
  log(`Found ${untagged.length} emails without classification tags`);

  if (untagged.length === 0) {
    log("Nothing to do");
    return;
  }

  const toSend = [];
  let tagged = 0;
  let failed = 0;

  // Process with concurrency
  const results = await runWithConcurrency(
    untagged,
    async ({ messageId, filePath }, index, total) => {
      const parsed = await parseEmailFile(filePath);
      if (!parsed) {
        return { status: "parse_failed" };
      }

      const shortSubject = parsed.subject.substring(0, 40).replace(/\n/g, " ");
      log(`[${index + 1}/${total}] Classifying: ${shortSubject}...`);

      const classification = await classifyWithOllama(parsed, corrections);
      if (!classification) {
        return { status: "classify_failed" };
      }

      log(`[${index + 1}/${total}]   -> ${classification.type} (${(classification.confidence * 100).toFixed(0)}%)`);

      // Add the classification tag
      await addClassificationTag(messageId, classification.type);

      // If job-related with good confidence, prepare for server
      if (classification.type !== "other" && classification.confidence >= 0.6) {
        return {
          status: "job_related",
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
            extractedData: classification.extractedData,
          },
        };
      }

      return { status: "tagged" };
    },
    CONCURRENCY
  );

  // Aggregate results
  for (const result of results) {
    if (result.error || result.status === "classify_failed" || result.status === "parse_failed") {
      failed++;
    } else if (result.status === "job_related") {
      toSend.push(result.data);
      tagged++;
    } else {
      tagged++;
    }
  }

  log(`\nResults: ${tagged} tagged, ${failed} failed`);

  // Send newly discovered job-related emails to server
  if (toSend.length > 0) {
    log(`Sending ${toSend.length} newly discovered job-related emails to server...`);
    await sendToServer(toSend);
  }

  log("Done!");
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
