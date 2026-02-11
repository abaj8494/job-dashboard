"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { getCurrentUser } from "@/utils/user.utils";
import { APP_CONSTANTS } from "@/lib/constants";
import { revalidatePath } from "next/cache";

export interface EmailImportListItem {
  id: string;
  messageId: string;
  subject: string;
  fromEmail: string;
  fromName: string | null;
  toEmail: string;
  emailDate: Date;
  classification: string;
  confidence: number;
  isOutbound: boolean;
  extractedData: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  status: string;
  createdAt: Date;
  emailAccount: {
    email: string;
  };
  job: {
    id: string;
  } | null;
}

export type EmailImportSortField = "emailDate" | "subject" | "fromEmail" | "classification" | "confidence" | "status";
export type SortOrder = "asc" | "desc";

/**
 * Get paginated list of email imports
 */
export const getEmailImportsList = async (
  page: number = 1,
  limit: number = APP_CONSTANTS.RECORDS_PER_PAGE,
  status?: string,
  classification?: string,
  sortBy: EmailImportSortField = "emailDate",
  sortOrder: SortOrder = "desc"
): Promise<{ success: boolean; data?: EmailImportListItem[]; total?: number; message?: string } | undefined> => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    const skip = (page - 1) * limit;

    const where: {
      userId: string;
      status?: string;
      classification?: string;
    } = { userId: user.id };

    if (status) where.status = status;
    if (classification) where.classification = classification;

    const [data, total] = await Promise.all([
      prisma.emailImport.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          emailAccount: {
            select: { email: true },
          },
          job: {
            select: { id: true },
          },
        },
      }),
      prisma.emailImport.count({ where }),
    ]);

    return { success: true, data: data as EmailImportListItem[], total };
  } catch (error) {
    return handleError(error, "Failed to fetch email imports");
  }
};

/**
 * Get single email import by ID
 */
export const getEmailImportById = async (id: string) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    const emailImport = await prisma.emailImport.findUnique({
      where: { id, userId: user.id },
      include: {
        emailAccount: true,
        job: {
          include: {
            Company: true,
            JobTitle: true,
            Location: true,
            Status: true,
          },
        },
      },
    });

    if (!emailImport) {
      return { success: false, message: "Email import not found" };
    }

    return { success: true, data: emailImport };
  } catch (error) {
    return handleError(error, "Failed to fetch email import");
  }
};

/**
 * Get pending email imports count
 */
export const getPendingEmailImportsCount = async (): Promise<number> => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return 0;
    }

    const count = await prisma.emailImport.count({
      where: { userId: user.id, status: "pending" },
    });

    return count;
  } catch {
    return 0;
  }
};

/**
 * Approve email import and create job
 */
export const approveEmailImport = async (
  importId: string,
  jobData: {
    title: string; // JobTitle ID
    company: string; // Company ID
    location?: string; // Location ID
    source?: string; // JobSource ID
    status: string; // Status ID
    jobDescription: string;
    jobUrl?: string;
    applied: boolean;
    dateApplied?: Date;
    jobType?: string;
  }
) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    const emailImport = await prisma.emailImport.findUnique({
      where: { id: importId, userId: user.id },
    });

    if (!emailImport) {
      return { success: false, message: "Import not found" };
    }

    if (emailImport.status !== "pending") {
      return { success: false, message: "Import already processed" };
    }

    // Create job and update import in transaction
    const result = await prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          userId: user.id,
          jobTitleId: jobData.title,
          companyId: jobData.company,
          locationId: jobData.location || null,
          statusId: jobData.status,
          jobSourceId: jobData.source || null,
          description: jobData.jobDescription,
          jobUrl: jobData.jobUrl || null,
          applied: jobData.applied,
          appliedDate: jobData.dateApplied || null,
          jobType: jobData.jobType || "FT",
          createdAt: new Date(),
        },
      });

      await tx.emailImport.update({
        where: { id: importId },
        data: {
          status: "approved",
          jobId: job.id,
          reviewedAt: new Date(),
        },
      });

      return job;
    });

    revalidatePath("/dashboard/email-imports");
    revalidatePath("/dashboard/myjobs");

    return { success: true, job: result };
  } catch (error) {
    return handleError(error, "Failed to approve email import");
  }
};

/**
 * Reject email import (mark as not job-related)
 */
export const rejectEmailImport = async (importId: string) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    await prisma.emailImport.update({
      where: { id: importId, userId: user.id },
      data: {
        status: "rejected",
        reviewedAt: new Date(),
      },
    });

    revalidatePath("/dashboard/email-imports");

    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to reject email import");
  }
};

/**
 * Skip email import (reviewed but no action taken)
 */
export const skipEmailImport = async (importId: string) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    await prisma.emailImport.update({
      where: { id: importId, userId: user.id },
      data: {
        status: "skipped",
        reviewedAt: new Date(),
      },
    });

    revalidatePath("/dashboard/email-imports");

    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to skip email import");
  }
};

/**
 * Bulk reject email imports
 */
export const bulkRejectEmailImports = async (importIds: string[]) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    await prisma.emailImport.updateMany({
      where: {
        id: { in: importIds },
        userId: user.id,
        status: "pending",
      },
      data: {
        status: "rejected",
        reviewedAt: new Date(),
      },
    });

    revalidatePath("/dashboard/email-imports");

    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to bulk reject email imports");
  }
};

/**
 * Bulk skip email imports
 */
export const bulkSkipEmailImports = async (importIds: string[]) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    await prisma.emailImport.updateMany({
      where: {
        id: { in: importIds },
        userId: user.id,
        status: "pending",
      },
      data: {
        status: "skipped",
        reviewedAt: new Date(),
      },
    });

    revalidatePath("/dashboard/email-imports");

    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to bulk skip email imports");
  }
};

/**
 * Delete email import
 */
export const deleteEmailImport = async (importId: string) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    await prisma.emailImport.delete({
      where: { id: importId, userId: user.id },
    });

    revalidatePath("/dashboard/email-imports");

    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to delete email import");
  }
};

/**
 * Restore email import to pending status
 */
export const restoreToPending = async (importId: string) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    await prisma.emailImport.update({
      where: { id: importId, userId: user.id },
      data: {
        status: "pending",
        reviewedAt: null,
      },
    });

    revalidatePath("/dashboard/email-imports");

    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to restore email import");
  }
};

/**
 * Link email import to existing job and update job status
 */
export const linkToExistingJob = async (
  importId: string,
  jobId: string,
  newStatusId: string
) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    const emailImport = await prisma.emailImport.findUnique({
      where: { id: importId, userId: user.id },
    });

    if (!emailImport) {
      return { success: false, message: "Import not found" };
    }

    // Verify job belongs to user
    const job = await prisma.job.findUnique({
      where: { id: jobId, userId: user.id },
      include: { Company: true, JobTitle: true, Status: true },
    });

    if (!job) {
      return { success: false, message: "Job not found" };
    }

    // Update job status and link email import in transaction
    await prisma.$transaction(async (tx) => {
      await tx.job.update({
        where: { id: jobId },
        data: {
          statusId: newStatusId,
        },
      });

      await tx.emailImport.update({
        where: { id: importId },
        data: {
          status: "approved",
          jobId: jobId,
          reviewedAt: new Date(),
        },
      });
    });

    revalidatePath("/dashboard/email-imports");
    revalidatePath("/dashboard/myjobs");

    return { success: true, job };
  } catch (error) {
    return handleError(error, "Failed to link email to job");
  }
};

/**
 * Search jobs for linking (used in email import review)
 */
export const searchJobsForLinking = async (search: string) => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    const jobs = await prisma.job.findMany({
      where: {
        userId: user.id,
        OR: [
          { JobTitle: { label: { contains: search } } },
          { Company: { label: { contains: search } } },
        ],
      },
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        Company: { select: { label: true } },
        JobTitle: { select: { label: true } },
        Status: { select: { id: true, label: true, value: true } },
      },
    });

    return { success: true, data: jobs };
  } catch (error) {
    return handleError(error, "Failed to search jobs");
  }
};

/**
 * Get active jobs for linking (excludes rejected/offer statuses)
 */
export const getActiveJobsForLinking = async () => {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("Not authenticated");
    }

    const jobs = await prisma.job.findMany({
      where: {
        userId: user.id,
        Status: {
          value: {
            notIn: ["rejected", "offer"],
          },
        },
      },
      take: 50,
      orderBy: { createdAt: "desc" },
      include: {
        Company: { select: { label: true } },
        JobTitle: { select: { label: true } },
        Status: { select: { id: true, label: true, value: true } },
      },
    });

    return { success: true, data: jobs };
  } catch (error) {
    return handleError(error, "Failed to fetch active jobs");
  }
};
