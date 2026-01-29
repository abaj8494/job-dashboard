import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const MAILDIR_PATH = process.env.MAILDIR_PATH || `${process.env.HOME}/Maildir`;
const MONITORED_EMAILS = (
  process.env.MONITORED_EMAILS || "j@abaj.ai,aayushbajaj7@gmail.com"
).split(",");

export interface NotmuchEmail {
  messageId: string;
  filePath: string;
  tags: string[];
}

/**
 * Build notmuch query for emails involving monitored accounts
 */
function buildEmailQuery(emails: string[]): string {
  const emailClauses = emails
    .map((email) => `(from:${email} OR to:${email})`)
    .join(" OR ");

  return `tag:new AND (${emailClauses}) AND NOT tag:spam AND NOT tag:trash AND NOT tag:jobsync-processed`;
}

/**
 * Query notmuch for new job-related emails
 * Returns file paths of matching emails
 */
export async function queryNewEmails(): Promise<string[]> {
  const query = buildEmailQuery(MONITORED_EMAILS);

  try {
    const { stdout } = await execAsync(
      `notmuch search --output=files "${query}"`,
      {
        cwd: MAILDIR_PATH,
        env: { ...process.env, NOTMUCH_CONFIG: `${process.env.HOME}/.notmuch-config` },
      }
    );

    const files = stdout.trim().split("\n").filter(Boolean);
    return files;
  } catch (error) {
    console.error("Notmuch query failed:", error);
    return [];
  }
}

/**
 * Get notmuch message ID for a file
 */
export async function getMessageIdFromFile(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `notmuch search --output=messages "path:${filePath}"`,
      {
        env: { ...process.env, NOTMUCH_CONFIG: `${process.env.HOME}/.notmuch-config` },
      }
    );
    const messageId = stdout.trim();
    return messageId || null;
  } catch {
    return null;
  }
}

/**
 * Add jobsync-processed tag to mark email as processed
 */
export async function markEmailProcessed(messageId: string): Promise<void> {
  try {
    await execAsync(
      `notmuch tag -new +jobsync-processed -- id:${messageId}`,
      {
        env: { ...process.env, NOTMUCH_CONFIG: `${process.env.HOME}/.notmuch-config` },
      }
    );
  } catch (error) {
    console.error("Failed to tag email as processed:", error);
  }
}

/**
 * Get count of new emails for monitored accounts
 */
export async function getNewEmailCount(): Promise<number> {
  const query = buildEmailQuery(MONITORED_EMAILS);

  try {
    const { stdout } = await execAsync(
      `notmuch count "${query}"`,
      {
        env: { ...process.env, NOTMUCH_CONFIG: `${process.env.HOME}/.notmuch-config` },
      }
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Check if notmuch is available
 */
export async function isNotmuchAvailable(): Promise<boolean> {
  try {
    await execAsync("notmuch --version");
    return true;
  } catch {
    return false;
  }
}

export { MONITORED_EMAILS, MAILDIR_PATH };
