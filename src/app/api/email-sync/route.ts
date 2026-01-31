import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import {
  queryNewEmails,
  markEmailProcessed,
  isNotmuchAvailable,
} from "@/lib/email/notmuch";
import { parseEmailFile } from "@/lib/email/parser";
import { classifyEmail, isJobRelated, meetsConfidenceThreshold } from "@/lib/email/classifier";

const API_KEY = process.env.EMAIL_SYNC_API_KEY;
const MONITORED_EMAILS = (
  process.env.MONITORED_EMAILS || "j@abaj.ai,aayushbajaj7@gmail.com"
).split(",");

interface SyncResult {
  processed: number;
  skipped: number;
  errors: string[];
}

/**
 * Pre-classified email import format (sent from local machine with Ollama)
 */
interface PreClassifiedImport {
  messageId: string;
  subject: string;
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  emailDate: string; // ISO date string
  bodyText?: string;
  bodyHtml?: string;
  classification: string;
  confidence: number;
  isOutbound: boolean;
  extractedData?: {
    company?: string;
    jobTitle?: string;
    location?: string;
    applicationUrl?: string;
    recruiterName?: string;
    salaryRange?: string;
  };
}

/**
 * POST /api/email-sync
 *
 * Two modes:
 * 1. Pre-classified mode: Body contains { imports: PreClassifiedImport[] }
 *    - Used when local machine runs Ollama and sends classified data
 *    - Server just stores the data, no notmuch/Ollama needed
 *
 * 2. Local mode: Empty body or { mode: "local" }
 *    - Server queries notmuch and runs Ollama locally
 *    - Requires notmuch and Ollama on server
 *
 * Protected by API key (not user auth since called by shell script).
 */
export const POST = async (req: NextRequest) => {
  // Verify API key
  const authHeader = req.headers.get("x-api-key");
  if (!API_KEY) {
    return NextResponse.json(
      { error: "EMAIL_SYNC_API_KEY not configured" },
      { status: 500 }
    );
  }
  if (authHeader !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Find the user (for now, assume single user based on email)
    const user = await prisma.user.findFirst();
    if (!user) {
      return NextResponse.json(
        { error: "No user found in database" },
        { status: 500 }
      );
    }

    // Parse request body
    let body: { imports?: PreClassifiedImport[]; mode?: string } = {};
    try {
      const text = await req.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch {
      // Empty body is valid (local mode)
    }

    // Check if pre-classified imports are provided
    if (body.imports && Array.isArray(body.imports) && body.imports.length > 0) {
      return handlePreClassifiedImports(user.id, body.imports);
    }

    // Fall back to local mode (query notmuch, run Ollama)
    return handleLocalMode(user.id);
  } catch (error) {
    console.error("Email sync error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Email sync failed" },
      { status: 500 }
    );
  }
};

/**
 * Handle pre-classified imports from local machine
 */
async function handlePreClassifiedImports(
  userId: string,
  imports: PreClassifiedImport[]
): Promise<NextResponse> {
  const result: SyncResult = {
    processed: 0,
    skipped: 0,
    errors: [],
  };

  // Ensure email accounts exist
  const uniqueEmails = new Set<string>();
  for (const imp of imports) {
    uniqueEmails.add(imp.fromEmail);
    uniqueEmails.add(imp.toEmail);
  }

  for (const email of uniqueEmails) {
    if (MONITORED_EMAILS.includes(email)) {
      await prisma.emailAccount.upsert({
        where: { email },
        update: {},
        create: {
          userId,
          email,
          isActive: true,
        },
      });
    }
  }

  for (const imp of imports) {
    try {
      // Check for duplicate
      const existing = await prisma.emailImport.findUnique({
        where: { messageId: imp.messageId },
      });

      if (existing) {
        result.skipped++;
        continue;
      }

      // Find email account
      const accountEmail = imp.isOutbound ? imp.fromEmail : imp.toEmail;
      const emailAccount = await prisma.emailAccount.findFirst({
        where: {
          email: { in: MONITORED_EMAILS },
          isActive: true,
        },
      });

      if (!emailAccount) {
        result.errors.push(`No email account for ${accountEmail}`);
        continue;
      }

      // Store in database
      await prisma.emailImport.create({
        data: {
          userId,
          emailAccountId: emailAccount.id,
          messageId: imp.messageId,
          subject: imp.subject,
          fromEmail: imp.fromEmail,
          fromName: imp.fromName || null,
          toEmail: imp.toEmail,
          emailDate: new Date(imp.emailDate),
          bodyText: imp.bodyText?.substring(0, 10000) || null,
          bodyHtml: imp.bodyHtml?.substring(0, 50000) || null,
          classification: imp.classification,
          confidence: imp.confidence,
          isOutbound: imp.isOutbound,
          extractedData: imp.extractedData
            ? JSON.stringify(imp.extractedData)
            : null,
          status: "pending",
        },
      });

      result.processed++;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      result.errors.push(`Error importing ${imp.messageId}: ${errorMessage}`);
    }
  }

  return NextResponse.json({
    message: "Pre-classified import completed",
    mode: "pre-classified",
    ...result,
    errors: result.errors.length > 0 ? result.errors : undefined,
  });
}

/**
 * Handle local mode (server queries notmuch and runs Ollama)
 */
async function handleLocalMode(userId: string): Promise<NextResponse> {
  // Check if notmuch is available
  const notmuchAvailable = await isNotmuchAvailable();
  if (!notmuchAvailable) {
    return NextResponse.json(
      { error: "notmuch is not installed or not accessible" },
      { status: 500 }
    );
  }

  // Ensure email accounts exist for monitored emails
  for (const email of MONITORED_EMAILS) {
    await prisma.emailAccount.upsert({
      where: { email },
      update: {},
      create: {
        userId,
        email,
        isActive: true,
      },
    });
  }

  // Query notmuch for new emails
  const emailPaths = await queryNewEmails();

  if (emailPaths.length === 0) {
    return NextResponse.json({
      message: "No new job-related emails",
      mode: "local",
      processed: 0,
      skipped: 0,
    });
  }

  const result: SyncResult = {
    processed: 0,
    skipped: 0,
    errors: [],
  };

  // Process each email
  for (const filePath of emailPaths) {
    try {
      // Parse the email
      const parsed = await parseEmailFile(filePath);

      // Check for duplicate by message ID
      const existing = await prisma.emailImport.findUnique({
        where: { messageId: parsed.messageId },
      });

      if (existing) {
        result.skipped++;
        continue;
      }

      // Classify the email with LLM
      const classification = await classifyEmail(parsed);

      // Skip non-job-related emails or low confidence
      if (
        !isJobRelated(classification) ||
        !meetsConfidenceThreshold(classification)
      ) {
        // Mark as processed in notmuch to avoid re-processing
        await markEmailProcessed(parsed.messageId);
        result.skipped++;
        continue;
      }

      // Find the email account
      const emailAccount = await prisma.emailAccount.findFirst({
        where: {
          email: {
            in: MONITORED_EMAILS,
          },
          isActive: true,
        },
      });

      if (!emailAccount) {
        result.skipped++;
        continue;
      }

      // Store in queue for review
      await prisma.emailImport.create({
        data: {
          userId,
          emailAccountId: emailAccount.id,
          messageId: parsed.messageId,
          subject: parsed.subject,
          fromEmail: parsed.from,
          fromName: parsed.fromName,
          toEmail: parsed.to,
          emailDate: parsed.date,
          bodyText: parsed.textBody?.substring(0, 10000) || null,
          bodyHtml: parsed.htmlBody?.substring(0, 50000) || null,
          classification: classification.type,
          confidence: classification.confidence,
          isOutbound: parsed.isOutbound,
          extractedData: JSON.stringify(classification.extractedData),
          status: "pending",
        },
      });

      // Mark as processed in notmuch
      await markEmailProcessed(parsed.messageId);
      result.processed++;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      result.errors.push(`Error processing ${filePath}: ${errorMessage}`);
    }
  }

  return NextResponse.json({
    message: "Email sync completed",
    mode: "local",
    ...result,
    errors: result.errors.length > 0 ? result.errors : undefined,
  });
}

/**
 * PATCH /api/email-sync
 *
 * Update classifications from user corrections.
 * Called by the corrections scanner when user changes tags in notmuch.
 *
 * Body: { corrections: [{ messageId, originalType, correctedType }] }
 */
export const PATCH = async (req: NextRequest) => {
  // Verify API key
  const authHeader = req.headers.get("x-api-key");
  if (!API_KEY) {
    return NextResponse.json(
      { error: "EMAIL_SYNC_API_KEY not configured" },
      { status: 500 }
    );
  }
  if (authHeader !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const corrections = body.corrections as Array<{
      messageId: string;
      originalType: string;
      correctedType: string;
    }>;

    if (!corrections || !Array.isArray(corrections)) {
      return NextResponse.json(
        { error: "Invalid request body - expected { corrections: [...] }" },
        { status: 400 }
      );
    }

    let updated = 0;
    let notFound = 0;
    const errors: string[] = [];

    for (const correction of corrections) {
      try {
        // Clean message ID (remove angle brackets if present)
        const cleanMessageId = correction.messageId.replace(/^<|>$/g, "");

        // Try to find the email import by messageId
        const emailImport = await prisma.emailImport.findFirst({
          where: {
            OR: [
              { messageId: cleanMessageId },
              { messageId: `<${cleanMessageId}>` },
              { messageId: correction.messageId },
            ],
          },
        });

        if (!emailImport) {
          notFound++;
          continue;
        }

        // Update the classification
        await prisma.emailImport.update({
          where: { id: emailImport.id },
          data: {
            classification: correction.correctedType,
            // Optionally track that this was user-corrected
            updatedAt: new Date(),
          },
        });

        updated++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(
          `Error updating ${correction.messageId}: ${errorMessage}`
        );
      }
    }

    return NextResponse.json({
      message: "Corrections applied",
      updated,
      notFound,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Correction sync error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Correction sync failed" },
      { status: 500 }
    );
  }
};

/**
 * GET /api/email-sync
 *
 * Get pending email import count (for dashboard indicator)
 */
export const GET = async (req: NextRequest) => {
  // This endpoint can be called from the UI, so use session auth
  // For simplicity, we'll make it public for now (just returns counts)

  try {
    const pendingCount = await prisma.emailImport.count({
      where: { status: "pending" },
    });

    const totalCount = await prisma.emailImport.count();

    return NextResponse.json({
      pending: pendingCount,
      total: totalCount,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get email import stats" },
      { status: 500 }
    );
  }
};
