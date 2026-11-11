import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { createJobRecord, findJob } from "@/lib/email/auto-file";
import { EXTENSION_JOB_SELECT, toExtensionJob } from "@/lib/jobs/extension-job";

const API_KEY = process.env.EMAIL_SYNC_API_KEY;

function text(value: unknown, max = 300): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** "YYYY-MM-DD" (a local calendar date) -> 02:00 UTC, which is midday in Sydney, so it stays that day in any AU timezone. */
function appliedDateFrom(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 2)) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * POST /api/jobs
 *
 * Creates a job from the Chrome extension ("Add job", "Save this job").
 * Body: { title, company, location?, url?, source?, appliedDate? (YYYY-MM-DD) }
 * Saving the same company + title again returns the existing job
 * ({ created: false }) instead of making a duplicate.
 *
 * Protected by the same API key as /api/email-sync.
 */
export const POST = async (req: NextRequest) => {
  if (!API_KEY) {
    return NextResponse.json({ error: "EMAIL_SYNC_API_KEY not configured" }, { status: 500 });
  }
  if (req.headers.get("x-api-key") !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const title = text(body.title);
  const company = text(body.company);
  if (!title || !company) {
    return NextResponse.json({ error: "title and company are required" }, { status: 400 });
  }

  try {
    const user = await prisma.user.findFirst();
    if (!user) return NextResponse.json({ error: "No user found in database" }, { status: 500 });

    const result = await prisma.$transaction(async (tx) => {
      const existing = await findJob(tx, user.id, company, title);
      if (existing) return { id: existing.id, created: false };
      const appliedDate = appliedDateFrom(body.appliedDate) || new Date();
      const job = await createJobRecord(tx, user.id, {
        company,
        title,
        location: text(body.location),
        url: text(body.url, 2000),
        source: text(body.source),
        statusValue: "applied",
        applied: true,
        appliedDate,
        createdAt: new Date(),
        description: "Saved from the JobSync extension",
      });
      return { id: job.id, created: true };
    });

    const job = await prisma.job.findUnique({ where: { id: result.id }, select: EXTENSION_JOB_SELECT });
    return NextResponse.json({ created: result.created, job: job && toExtensionJob(job) }, { status: result.created ? 201 : 200 });
  } catch (error) {
    console.error("Create job API error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create job" }, { status: 500 });
  }
};
