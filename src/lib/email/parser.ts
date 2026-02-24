import { simpleParser, ParsedMail } from "mailparser";
import { readFile } from "fs/promises";
import { MONITORED_EMAILS } from "./notmuch";

export interface ParsedEmail {
  messageId: string;
  subject: string;
  from: string;
  fromName: string | null;
  to: string;
  date: Date;
  textBody: string | null;
  htmlBody: string | null;
  isOutbound: boolean;
}

/**
 * Parse a Maildir email file
 */
export async function parseEmailFile(filePath: string): Promise<ParsedEmail> {
  const rawEmail = await readFile(filePath);
  const parsed = await simpleParser(rawEmail);

  const fromAddress = extractEmailAddress(parsed.from);
  const toAddress = extractEmailAddress(parsed.to);
  const fromName = extractName(parsed.from);

  // Check if this is an outbound email (sent by user)
  const isOutbound = MONITORED_EMAILS.some(
    (email) => email.toLowerCase() === fromAddress.toLowerCase()
  );

  return {
    messageId: parsed.messageId || generateMessageId(filePath),
    subject: parsed.subject || "(No Subject)",
    from: fromAddress,
    fromName,
    to: toAddress,
    date: parsed.date || new Date(),
    textBody: parsed.text || null,
    htmlBody: parsed.html || null,
    isOutbound,
  };
}

/**
 * Extract email address from parsed address object
 */
function extractEmailAddress(
  addressObject: ParsedMail["from"] | ParsedMail["to"]
): string {
  if (!addressObject) return "";

  if (Array.isArray(addressObject)) {
    // AddressObject[]
    const first = addressObject[0];
    if (first && "value" in first && Array.isArray(first.value)) {
      return first.value[0]?.address || "";
    }
  } else if ("value" in addressObject && Array.isArray(addressObject.value)) {
    // AddressObject
    return addressObject.value[0]?.address || "";
  } else if ("text" in addressObject) {
    // Try to extract from text
    const match = addressObject.text?.match(/<([^>]+)>/);
    if (match) return match[1];
    return addressObject.text || "";
  }

  return "";
}

/**
 * Extract name from parsed address object
 */
function extractName(addressObject: ParsedMail["from"]): string | null {
  if (!addressObject) return null;

  if (Array.isArray(addressObject)) {
    const first = addressObject[0];
    if (first && "value" in first && Array.isArray(first.value)) {
      return first.value[0]?.name || null;
    }
  } else if ("value" in addressObject && Array.isArray(addressObject.value)) {
    return addressObject.value[0]?.name || null;
  }

  return null;
}

/**
 * Generate a fallback message ID from file path
 */
function generateMessageId(filePath: string): string {
  const filename = filePath.split("/").pop() || "";
  return `local-${filename}@jobsync`;
}

/**
 * Extract plain text from HTML, preserving structure for better extraction
 */
export function htmlToText(html: string): string {
  if (!html) return "";

  return html
    // Remove style and script blocks
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // Remove hidden elements
    .replace(/<[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, "")

    // Preserve structure with line breaks
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/h[1-6]>/gi, "\n")

    // Remove remaining tags
    .replace(/<[^>]+>/g, " ")

    // Decode HTML entities
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "--")

    // Clean up whitespace while preserving paragraph breaks
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Get the best text content from a parsed email
 */
export function getEmailTextContent(email: ParsedEmail): string {
  if (email.textBody) {
    return email.textBody;
  }
  if (email.htmlBody) {
    return htmlToText(email.htmlBody);
  }
  return "";
}

/**
 * Extract domain from email address
 */
export function getEmailDomain(email: string): string {
  const parts = email.split("@");
  return parts[1] || "";
}

/**
 * Check if email is from a known ATS/job board domain
 */
export function isJobBoardDomain(domain: string): boolean {
  const jobBoardDomains = [
    "greenhouse.io",
    "lever.co",
    "workday.com",
    "myworkday.com",
    "icims.com",
    "smartrecruiters.com",
    "ashbyhq.com",
    "jobvite.com",
    "taleo.net",
    "breezy.hr",
    "bamboohr.com",
    "linkedin.com",
    "indeed.com",
    "seek.com.au",
    "glassdoor.com",
    "angel.co",
    "wellfound.com",
    "hired.com",
    "dice.com",
    "monster.com",
    "ziprecruiter.com",
  ];

  return jobBoardDomains.some((jbd) => domain.toLowerCase().includes(jbd));
}
