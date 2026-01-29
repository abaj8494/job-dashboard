#!/usr/bin/env npx ts-node
/**
 * Local Email Sync Script
 *
 * Runs locally with Ollama to classify emails, then sends
 * pre-classified data to the remote JobSync server.
 *
 * Usage:
 *   npx ts-node scripts/jobsync-local-sync.ts
 *
 * Or add to notmuch post-new hook for automatic sync.
 *
 * Environment variables:
 *   JOBSYNC_API_URL - Remote server URL (e.g., https://jobs.abaj.ai/api/email-sync)
 *   JOBSYNC_API_KEY - API key for authentication
 *   OLLAMA_BASE_URL - Ollama URL (default: http://localhost:11434)
 */

import { exec } from "child_process";
import { promisify } from "util";
import { simpleParser } from "mailparser";
import * as fs from "fs";
import * as path from "path";

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

const LOG_FILE = path.join(
  process.env.HOME || "~",
  ".jobsync",
  "local-sync.log"
);

function log(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  fs.appendFileSync(LOG_FILE, logMessage);
}

interface ParsedEmail {
  messageId: string;
  subject: string;
  from: string;
  fromName?: string;
  to: string;
  date: Date;
  textBody?: string;
  htmlBody?: string;
  isOutbound: boolean;
}

interface ClassificationResult {
  type: string;
  confidence: number;
  extractedData: {
    company?: string;
    jobTitle?: string;
    location?: string;
    applicationUrl?: string;
    recruiterName?: string;
    salaryRange?: string;
  };
}

async function queryNewEmails(): Promise<string[]> {
  const emailClauses = MONITORED_EMAILS.map(
    (email) => `(from:${email} OR to:${email})`
  ).join(" OR ");

  const query = `tag:new AND (${emailClauses}) AND NOT tag:spam AND NOT tag:trash AND NOT tag:jobsync-processed`;

  try {
    const { stdout } = await execAsync(`notmuch search --output=files "${query}"`);
    return stdout.trim().split("\n").filter(Boolean);
  } catch (error) {
    log(`Notmuch query failed: ${error}`);
    return [];
  }
}

async function parseEmailFile(filePath: string): Promise<ParsedEmail | null> {
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
      messageId: parsed.messageId || `generated-${Date.now()}`,
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
    log(`Failed to parse email ${filePath}: ${error}`);
    return null;
  }
}

async function classifyWithOllama(
  email: ParsedEmail
): Promise<ClassificationResult | null> {
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

  const userPrompt = `Classify this email:

Direction: ${email.isOutbound ? "SENT" : "RECEIVED"}
From: ${email.fromName || email.from}
To: ${email.to}
Subject: ${email.subject}
Date: ${email.date.toISOString()}

Body:
${email.textBody?.substring(0, 3000) || "(No text body)"}`;

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
    log(`Ollama classification failed: ${error}`);
    return null;
  }
}

async function markEmailProcessed(messageId: string): Promise<void> {
  try {
    const escapedId = messageId.replace(/'/g, "'\\''");
    await execAsync(`notmuch tag -new +jobsync-processed -- 'id:${escapedId}'`);
  } catch (error) {
    log(`Failed to tag email: ${error}`);
  }
}

function isJobRelated(classification: ClassificationResult): boolean {
  return classification.type !== "other";
}

async function sendToServer(
  imports: Array<{
    messageId: string;
    subject: string;
    fromEmail: string;
    fromName?: string;
    toEmail: string;
    emailDate: string;
    bodyText?: string;
    bodyHtml?: string;
    classification: string;
    confidence: number;
    isOutbound: boolean;
    extractedData?: object;
  }>
): Promise<boolean> {
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
    log(`Failed to send to server: ${error}`);
    return false;
  }
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

  // Query for new emails
  const emailPaths = await queryNewEmails();
  log(`Found ${emailPaths.length} new emails`);

  if (emailPaths.length === 0) {
    log("No new emails to process");
    return;
  }

  const toSend: Array<{
    messageId: string;
    subject: string;
    fromEmail: string;
    fromName?: string;
    toEmail: string;
    emailDate: string;
    bodyText?: string;
    bodyHtml?: string;
    classification: string;
    confidence: number;
    isOutbound: boolean;
    extractedData?: object;
  }> = [];

  let processed = 0;
  let skipped = 0;

  for (const filePath of emailPaths) {
    const parsed = await parseEmailFile(filePath);
    if (!parsed) {
      skipped++;
      continue;
    }

    const classification = await classifyWithOllama(parsed);
    if (!classification) {
      skipped++;
      await markEmailProcessed(parsed.messageId);
      continue;
    }

    if (!isJobRelated(classification) || classification.confidence < 0.6) {
      log(`Skipping non-job email: ${parsed.subject}`);
      await markEmailProcessed(parsed.messageId);
      skipped++;
      continue;
    }

    toSend.push({
      messageId: parsed.messageId,
      subject: parsed.subject,
      fromEmail: parsed.from,
      fromName: parsed.fromName,
      toEmail: parsed.to,
      emailDate: parsed.date.toISOString(),
      bodyText: parsed.textBody?.substring(0, 10000),
      bodyHtml: parsed.htmlBody?.substring(0, 50000),
      classification: classification.type,
      confidence: classification.confidence,
      isOutbound: parsed.isOutbound,
      extractedData: classification.extractedData,
    });

    await markEmailProcessed(parsed.messageId);
    processed++;
  }

  log(`Processed ${processed}, skipped ${skipped}`);

  if (toSend.length > 0) {
    log(`Sending ${toSend.length} emails to server...`);
    const success = await sendToServer(toSend);
    if (success) {
      log("Sync completed successfully");
    } else {
      log("Sync failed - check server logs");
    }
  }
}

main().catch((error) => {
  log(`Fatal error: ${error}`);
  process.exit(1);
});
