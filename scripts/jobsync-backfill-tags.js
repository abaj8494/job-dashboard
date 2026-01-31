#!/usr/bin/env node
/**
 * Backfill Classification Tags Script
 *
 * Adds jobsync/<classification> tags to emails that were processed
 * before the tagging feature was added.
 *
 * Usage:
 *   node scripts/jobsync-backfill-tags.js
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const { PrismaClient } = require("@prisma/client");
const { CLASSIFICATION_TYPES } = require("./lib/classification-rules");

const execAsync = promisify(exec);

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log("Fetching email imports from database...");

    // Get all email imports with their classifications
    const imports = await prisma.emailImport.findMany({
      select: {
        messageId: true,
        classification: true,
        subject: true,
      }
    });

    console.log(`Found ${imports.length} email imports in database`);

    let tagged = 0;
    let skipped = 0;
    let failed = 0;

    for (const emailImport of imports) {
      const { messageId, classification, subject } = emailImport;

      // Skip if classification is not valid
      if (!CLASSIFICATION_TYPES.includes(classification)) {
        skipped++;
        continue;
      }

      // Clean message ID (remove angle brackets if present)
      const cleanId = messageId.replace(/^<|>$/g, "");
      const escapedId = cleanId.replace(/'/g, "'\\''");

      try {
        // Check if already has a jobsync/* tag
        const { stdout: existingTags } = await execAsync(
          `notmuch search --output=tags 'id:${escapedId}'`
        );

        const hasClassificationTag = existingTags
          .split("\n")
          .some(tag => tag.startsWith("jobsync/"));

        if (hasClassificationTag) {
          skipped++;
          continue;
        }

        // Add the classification tag
        await execAsync(
          `notmuch tag +jobsync/${classification} -- 'id:${escapedId}'`
        );

        const shortSubject = (subject || "").substring(0, 40);
        console.log(`Tagged: ${shortSubject}... -> ${classification}`);
        tagged++;

      } catch (e) {
        // Email might not exist in notmuch anymore
        failed++;
      }
    }

    console.log(`\nDone: ${tagged} tagged, ${skipped} skipped, ${failed} failed`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
