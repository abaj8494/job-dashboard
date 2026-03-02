import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";

const API_KEY = process.env.EMAIL_SYNC_API_KEY;

interface DiscoverJobImport {
  externalId: string;
  source: string;
  title: string;
  company: string;
  location: string;
  salary?: string;
  url?: string;
  description?: string;
  postedDate?: string;
  matchScore?: number;
}

/**
 * POST /api/discover
 *
 * Accepts { jobs: DiscoverJobImport[] } from the local cron script.
 * Upserts each job into the DiscoveredJob table.
 * Protected by API key (same as email-sync).
 */
export const POST = async (req: NextRequest) => {
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
    const user = await prisma.user.findFirst();
    if (!user) {
      return NextResponse.json(
        { error: "No user found in database" },
        { status: 500 }
      );
    }

    const body = await req.json();
    const jobs: DiscoverJobImport[] = body.jobs;

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return NextResponse.json(
        { error: "Expected { jobs: [...] } with at least one job" },
        { status: 400 }
      );
    }

    let upserted = 0;
    const errors: string[] = [];

    for (const job of jobs) {
      try {
        await prisma.discoveredJob.upsert({
          where: {
            externalId_source: {
              externalId: job.externalId,
              source: job.source,
            },
          },
          create: {
            externalId: job.externalId,
            source: job.source,
            title: job.title,
            company: job.company,
            location: job.location,
            salary: job.salary || null,
            url: job.url || null,
            description: job.description || null,
            postedDate: job.postedDate ? new Date(job.postedDate) : null,
            matchScore: job.matchScore ?? null,
            userId: user.id,
          },
          update: {
            title: job.title,
            company: job.company,
            location: job.location,
            salary: job.salary || null,
            url: job.url || null,
            description: job.description || null,
            postedDate: job.postedDate ? new Date(job.postedDate) : null,
            matchScore: job.matchScore ?? null,
          },
        });
        upserted++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        errors.push(`Error upserting ${job.externalId}: ${msg}`);
      }
    }

    return NextResponse.json({
      message: "Discover import completed",
      upserted,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Discover import error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed" },
      { status: 500 }
    );
  }
};
