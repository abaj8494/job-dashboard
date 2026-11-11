import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { EXTENSION_JOB_SELECT, toExtensionJob } from "@/lib/jobs/extension-job";

const API_KEY = process.env.EMAIL_SYNC_API_KEY;

/**
 * GET /api/jobs/recent
 *
 * Returns recent jobs for Chrome extension autofill.
 * Protected by API key (same as email-sync).
 *
 * Query params:
 *   - limit: Max number of jobs to return (default 50, at most 1000)
 *   - days: Jobs from last N days (default 30; 0 = all jobs)
 */
export const GET = async (req: NextRequest) => {
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
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50") || 50, 1), 1000);
    const days = parseInt(searchParams.get("days") || "30");

    const where: { createdAt?: { gte: Date } } = {};
    if (days !== 0) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - (Number.isFinite(days) && days > 0 ? days : 30));
      where.createdAt = { gte: cutoffDate };
    }

    // Fetch recent jobs with relations for form filling
    const jobs = await prisma.job.findMany({
      where,
      select: EXTENSION_JOB_SELECT,
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
    });

    // Transform to flat structure for extension
    const transformedJobs = jobs.map(toExtensionJob);

    return NextResponse.json({
      jobs: transformedJobs,
      count: transformedJobs.length,
    });
  } catch (error) {
    console.error("Jobs recent API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch jobs" },
      { status: 500 }
    );
  }
};
