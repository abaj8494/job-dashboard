"use server";

import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { getCurrentUser } from "@/utils/user.utils";
import { APP_CONSTANTS } from "@/lib/constants";
import { searchAdzuna } from "@/lib/discover/adzuna";
import { searchJooble } from "@/lib/discover/jooble";
import { deduplicateJobs } from "@/lib/discover/deduplicator";
import { DiscoverSearchParams } from "@/lib/discover/types";

export type DiscoverSortField = "title" | "company" | "location" | "postedDate" | "source" | "createdAt" | "matchScore";
export type SortOrder = "asc" | "desc";

export async function searchAndStoreJobs(params: DiscoverSearchParams) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error("Not authenticated");

    const source = params.source || "both";

    const results = await Promise.all([
      source === "both" || source === "adzuna" ? searchAdzuna(params) : Promise.resolve([]),
      source === "both" || source === "jooble" ? searchJooble(params) : Promise.resolve([]),
    ]);

    const allJobs = deduplicateJobs([...results[0], ...results[1]]);

    // Upsert each job into the database
    let upsertCount = 0;
    for (const job of allJobs) {
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
          salary: job.salary,
          url: job.url,
          description: job.description,
          postedDate: job.postedDate,
          userId: user.id,
        },
        update: {
          title: job.title,
          company: job.company,
          location: job.location,
          salary: job.salary,
          url: job.url,
          description: job.description,
          postedDate: job.postedDate,
        },
      });
      upsertCount++;
    }

    return { success: true, count: upsertCount };
  } catch (error) {
    return handleError(error, "Failed to search and store jobs.");
  }
}

export async function getDiscoveredJobs(
  page: number = 1,
  limit: number = APP_CONSTANTS.RECORDS_PER_PAGE,
  statusFilter?: string,
  search?: string,
  sortBy: DiscoverSortField = "createdAt",
  sortOrder: SortOrder = "desc"
) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error("Not authenticated");

    const skip = (page - 1) * limit;

    const whereClause: any = {
      userId: user.id,
    };

    if (statusFilter) {
      whereClause.status = statusFilter;
    }

    if (search) {
      whereClause.OR = [
        { title: { contains: search } },
        { company: { contains: search } },
        { location: { contains: search } },
        { description: { contains: search } },
      ];
    }

    const orderByMap: Record<DiscoverSortField, any> = {
      title: { title: sortOrder },
      company: { company: sortOrder },
      location: { location: sortOrder },
      postedDate: { postedDate: sortOrder },
      source: { source: sortOrder },
      createdAt: { createdAt: sortOrder },
      matchScore: { matchScore: sortOrder },
    };

    const [data, total] = await Promise.all([
      prisma.discoveredJob.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: orderByMap[sortBy] || { createdAt: "desc" },
      }),
      prisma.discoveredJob.count({
        where: whereClause,
      }),
    ]);

    return { success: true, data, total };
  } catch (error) {
    return handleError(error, "Failed to fetch discovered jobs.");
  }
}

export async function updateDiscoveredJobStatus(id: string, status: string) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error("Not authenticated");

    const job = await prisma.discoveredJob.update({
      where: { id, userId: user.id },
      data: { status },
    });

    return { success: true, data: job };
  } catch (error) {
    return handleError(error, "Failed to update job status.");
  }
}

export async function saveToMyJobs(discoveredJobId: string) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error("Not authenticated");

    const discoveredJob = await prisma.discoveredJob.findUnique({
      where: { id: discoveredJobId, userId: user.id },
    });

    if (!discoveredJob) throw new Error("Job not found");

    // Find or create JobTitle
    const titleValue = discoveredJob.title.trim().toLowerCase();
    let jobTitle = await prisma.jobTitle.findUnique({
      where: { value: titleValue },
    });
    if (!jobTitle) {
      jobTitle = await prisma.jobTitle.create({
        data: {
          label: discoveredJob.title,
          value: titleValue,
          createdBy: user.id,
        },
      });
    }

    // Find or create Company
    const companyValue = discoveredJob.company.trim().toLowerCase();
    let company = await prisma.company.findUnique({
      where: { value: companyValue },
    });
    if (!company) {
      company = await prisma.company.create({
        data: {
          label: discoveredJob.company,
          value: companyValue,
          createdBy: user.id,
        },
      });
    }

    // Create the Job entry
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        jobTitleId: jobTitle.id,
        companyId: company.id,
        jobUrl: discoveredJob.url,
        description: discoveredJob.description,
        salaryRange: discoveredJob.salary,
        createdAt: new Date(),
      },
    });

    // Mark discovered job as saved
    await prisma.discoveredJob.update({
      where: { id: discoveredJobId },
      data: { status: "saved" },
    });

    return { success: true, data: job };
  } catch (error) {
    return handleError(error, "Failed to save job to My Jobs.");
  }
}

export async function bulkUpdateStatus(ids: string[], status: string) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error("Not authenticated");

    await prisma.discoveredJob.updateMany({
      where: {
        id: { in: ids },
        userId: user.id,
      },
      data: { status },
    });

    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to bulk update job status.");
  }
}
