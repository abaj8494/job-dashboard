import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";

const API_KEY = process.env.EMAIL_SYNC_API_KEY;

/**
 * GET /api/jobs/recent
 *
 * Returns recent jobs for Chrome extension autofill.
 * Protected by API key (same as email-sync).
 *
 * Query params:
 *   - limit: Max number of jobs to return (default 50)
 *   - days: Jobs from last N days (default 30)
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
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const days = parseInt(searchParams.get("days") || "30");

    // Calculate date cutoff
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    // Fetch recent jobs with relations for form filling
    const jobs = await prisma.job.findMany({
      where: {
        createdAt: {
          gte: cutoffDate,
        },
      },
      select: {
        id: true,
        jobUrl: true,
        appliedDate: true,
        createdAt: true,
        JobTitle: {
          select: {
            label: true,
          },
        },
        Company: {
          select: {
            label: true,
          },
        },
        Location: {
          select: {
            label: true,
          },
        },
        JobSource: {
          select: {
            label: true,
          },
        },
        Status: {
          select: {
            label: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
    });

    // Transform to flat structure for extension
    const transformedJobs = jobs.map((job) => ({
      id: job.id,
      title: job.JobTitle?.label || null,
      company: job.Company?.label || null,
      location: job.Location?.label || null,
      url: job.jobUrl || null,
      source: job.JobSource?.label || null,
      appliedDate: job.appliedDate?.toISOString() || null,
      createdAt: job.createdAt.toISOString(),
      status: job.Status?.label || null,
    }));

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
