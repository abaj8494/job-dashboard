/** The flat job shape the Chrome extension reads (GET /api/jobs/recent, POST /api/jobs). */
export interface ExtensionJobRow {
  id: string;
  jobUrl: string | null;
  applied: boolean;
  appliedDate: Date | null;
  createdAt: Date;
  JobTitle?: { label: string } | null;
  Company?: { label: string } | null;
  Location?: { label: string } | null;
  JobSource?: { label: string } | null;
  Status?: { label: string } | null;
}

export function toExtensionJob(job: ExtensionJobRow) {
  return {
    id: job.id,
    title: job.JobTitle?.label || null,
    company: job.Company?.label || null,
    location: job.Location?.label || null,
    url: job.jobUrl || null,
    source: job.JobSource?.label || null,
    applied: job.applied,
    appliedDate: job.appliedDate?.toISOString() || null,
    createdAt: job.createdAt.toISOString(),
    status: job.Status?.label || null,
  };
}

export const EXTENSION_JOB_SELECT = {
  id: true,
  jobUrl: true,
  applied: true,
  appliedDate: true,
  createdAt: true,
  JobTitle: { select: { label: true } },
  Company: { select: { label: true } },
  Location: { select: { label: true } },
  JobSource: { select: { label: true } },
  Status: { select: { label: true } },
} as const;
