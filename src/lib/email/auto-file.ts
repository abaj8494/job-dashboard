/**
 * Auto-filing of pre-classified email imports.
 *
 * The local classifier marks each import `reviewRequired: false` when it is
 * confident. For those we do what the owner would do in the review dialog:
 * link the email to the matching Job (and advance its status), or create the
 * Job when it is a new application with a company and title. Anything we are
 * not sure about stays `pending` for a human, with a note saying why.
 *
 * Imports without `reviewRequired` (older clients) are treated as pending.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ImportExtractedData {
  company?: string | null;
  jobTitle?: string | null;
  location?: string | null;
  applicationUrl?: string | null;
  recruiterName?: string | null;
  salaryRange?: string | null;
  source?: string | null;
  jobType?: string | null;
  [key: string]: unknown;
}

export interface AutoFileInput {
  subject: string;
  bodyText?: string | null;
  emailDate: Date;
  classification: string;
  confidence: number;
  reviewRequired?: boolean;
  extractedData?: ImportExtractedData | null;
}

export interface AutoFileOutcome {
  status: "approved" | "pending";
  jobId: string | null;
  action: "linked" | "created" | "pending";
  note: string;
}

/** Classification -> job status value (follow_up leaves the status alone). */
const STATUS_FOR_CLASSIFICATION: Record<string, string | null> = {
  job_application: "applied",
  job_response: "applied",
  interview: "interview",
  rejection: "rejected",
  offer: "offer",
  follow_up: null,
};

/** Pipeline order; a later email never moves a job backwards. */
const STATUS_RANK: Record<string, number> = {
  draft: 0,
  applied: 1,
  interview: 2,
  offer: 3,
};

const JOB_TYPE_FOR_EXTRACTED: Record<string, string> = {
  "full-time": "FT",
  "part-time": "PT",
  contract: "C",
  temporary: "C",
  casual: "PT",
};

function norm(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWords(haystack: string, needle: string): boolean {
  return new RegExp(`(^|\\W)${escapeRegExp(needle)}(\\W|$)`, "i").test(haystack);
}

function titlesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // "Senior Software Engineer" vs "Software Engineer" etc., on word boundaries
  // so "Engineer" never matches "Engineering Manager".
  return containsWords(a, b) || containsWords(b, a);
}

/**
 * Decide and apply the filing for one import. Must run inside the caller's
 * transaction together with the EmailImport create so a failure leaves nothing
 * half-filed.
 */
export async function autoFileImport(
  db: Db,
  userId: string,
  imp: AutoFileInput
): Promise<AutoFileOutcome> {
  const pending = (note: string): AutoFileOutcome => ({ status: "pending", jobId: null, action: "pending", note });

  if (imp.reviewRequired !== false) return pending("classifier asked for review");
  if (imp.classification === "other") return pending("classified as other");

  const extracted = imp.extractedData || {};
  const company = clean(extracted.company);
  const jobTitle = clean(extracted.jobTitle);
  if (!company) return pending("no company extracted");

  const companyValue = norm(company);
  const titleValue = norm(jobTitle);

  // ---- 1. Try to link to an existing job at this company --------------------
  // Exact (case-insensitive) company name only: a substring match would file
  // "Canva" mail against "Canvas Co". Unknown spellings go pending instead.
  const candidates = await db.job.findMany({
    where: {
      userId,
      Company: { value: companyValue },
    },
    include: { JobTitle: true, Status: true, Company: true },
    orderBy: { createdAt: "desc" },
  });

  let match: (typeof candidates)[number] | null = null;
  if (candidates.length > 0) {
    if (titleValue) {
      match =
        candidates.find((j) => norm(j.JobTitle?.label) === titleValue) ||
        candidates.find((j) => titlesMatch(norm(j.JobTitle?.label), titleValue)) ||
        null;
    }
    if (!match && candidates.length === 1 && (!titleValue || imp.classification !== "job_application")) {
      // Only one job at this company and this email is about it (a new
      // application with a different title is a different job, handled below).
      match = candidates[0];
    }
    if (!match && candidates.length > 1 && imp.classification !== "job_application") {
      return pending(`${candidates.length} jobs at ${company}, title did not disambiguate`);
    }
  }

  const targetStatusValue = STATUS_FOR_CLASSIFICATION[imp.classification] ?? null;
  const isApplication = imp.classification === "job_application" || imp.classification === "job_response";

  if (match) {
    const currentValue = match.Status?.value || "draft";
    const data: Prisma.JobUpdateInput = {};
    if (targetStatusValue && currentValue !== targetStatusValue) {
      const forward = targetStatusValue === "rejected" || (STATUS_RANK[targetStatusValue] ?? 0) > (STATUS_RANK[currentValue] ?? 0);
      if (forward && currentValue !== "rejected") {
        const status = await db.jobStatus.findUnique({ where: { value: targetStatusValue } });
        if (status) data.Status = { connect: { id: status.id } };
      }
    }
    if (isApplication && (!match.applied || !match.appliedDate)) {
      data.applied = true;
      data.appliedDate = imp.emailDate;
    }
    if (Object.keys(data).length > 0) {
      await db.job.update({ where: { id: match.id }, data });
    }
    return {
      status: "approved",
      jobId: match.id,
      action: "linked",
      note: `linked to ${match.Company?.label} / ${match.JobTitle?.label}${data.Status ? `, status -> ${targetStatusValue}` : ""}`,
    };
  }

  // ---- 2. No job yet: create one when we know what it is ---------------------
  if (!jobTitle) return pending(`no job at ${company} and no job title extracted`);

  const job = await createJobRecord(db, userId, {
    company,
    title: jobTitle,
    location: clean(extracted.location),
    url: clean(extracted.applicationUrl),
    source: clean(extracted.source),
    jobType: clean(extracted.jobType),
    salaryRange: clean(extracted.salaryRange),
    statusValue: targetStatusValue || "applied",
    // A rejection, interview or offer means the person applied, even when the
    // application mail itself was never seen; only an application ack dates it.
    applied: imp.classification !== "follow_up",
    appliedDate: isApplication ? imp.emailDate : null,
    createdAt: imp.emailDate,
    description: imp.bodyText?.substring(0, 500) || `Filed from email (${imp.classification.replace(/_/g, " ")})`,
  });

  return {
    status: "approved",
    jobId: job.id,
    action: "created",
    note: `created ${company} / ${jobTitle} (${targetStatusValue || "applied"})`,
  };
}

export interface NewJobFields {
  company: string;
  title: string;
  location?: string | null;
  url?: string | null;
  source?: string | null;
  jobType?: string | null;
  salaryRange?: string | null;
  statusValue?: string;
  applied?: boolean;
  appliedDate?: Date | null;
  createdAt?: Date;
  description?: string | null;
}

/**
 * Create a Job with its Company / JobTitle / Location rows (reused when they
 * exist). Shared by email auto-filing and the extension's POST /api/jobs.
 */
export async function createJobRecord(db: Db, userId: string, f: NewJobFields) {
  const companyValue = norm(f.company);
  const titleValue = norm(f.title);

  const companyRow =
    (await db.company.findUnique({ where: { value: companyValue } })) ||
    (await db.company.create({ data: { label: f.company.trim(), value: companyValue, createdBy: userId } }));

  const titleRow =
    (await db.jobTitle.findUnique({ where: { value: titleValue } })) ||
    (await db.jobTitle.create({ data: { label: f.title.trim(), value: titleValue, createdBy: userId } }));

  let locationId: string | null = null;
  const location = clean(f.location);
  if (location) {
    const locationValue = norm(location);
    const locationRow =
      (await db.location.findFirst({ where: { value: locationValue, createdBy: userId } })) ||
      (await db.location.create({ data: { label: location, value: locationValue, createdBy: userId } }));
    locationId = locationRow.id;
  }

  let jobSourceId: string | null = null;
  const source = norm(f.source);
  if (source) {
    const sourceRow = await db.jobSource.findUnique({ where: { value: source } });
    jobSourceId = sourceRow?.id ?? null;
  }

  const statusRow = await db.jobStatus.findUnique({ where: { value: f.statusValue || "applied" } });

  return db.job.create({
    data: {
      userId,
      jobTitleId: titleRow.id,
      companyId: companyRow.id,
      locationId,
      statusId: statusRow?.id ?? null,
      jobSourceId,
      description: f.description || null,
      jobUrl: clean(f.url),
      applied: f.applied ?? true,
      appliedDate: f.appliedDate ?? null,
      jobType: JOB_TYPE_FOR_EXTRACTED[norm(f.jobType)] || "FT",
      salaryRange: clean(f.salaryRange),
      createdAt: f.createdAt || new Date(),
    },
  });
}

/**
 * The existing job for this company + title: exact company, then exact title,
 * then (unless exact) a word-boundary title match. POST /api/jobs uses exact,
 * so adding "Data Analyst" next to "Senior Data Analyst" makes a new job.
 */
export async function findJob(db: Db, userId: string, company: string, title: string, { exact = false } = {}) {
  const candidates = await db.job.findMany({
    where: { userId, Company: { value: norm(company) } },
    include: { JobTitle: true, Status: true, Company: true },
    orderBy: { createdAt: "desc" },
  });
  const t = norm(title);
  return (
    candidates.find((j) => norm(j.JobTitle?.label) === t) ||
    (exact ? undefined : candidates.find((j) => titlesMatch(norm(j.JobTitle?.label), t))) ||
    null
  );
}

export interface OwnerCorrectionOutcome {
  changed: boolean;
  note: string;
}

/**
 * The owner retagged mail that is already filed to a job (for example a
 * response to a rejection). Unlike automatic filing this may move the status
 * backwards: it is the owner's explicit call. follow_up and other leave the
 * status alone (other is handled by deleting the import). An application or
 * response also marks the job applied, dated by the mail if it has no date.
 */
export async function applyOwnerCorrection(
  db: Db,
  jobId: string,
  classification: string,
  emailDate: Date
): Promise<OwnerCorrectionOutcome> {
  const job = await db.job.findUnique({ where: { id: jobId }, include: { Status: true } });
  if (!job) return { changed: false, note: "owner correction: job not found" };

  const data: Prisma.JobUpdateInput = {};
  const target = STATUS_FOR_CLASSIFICATION[classification] ?? null;
  if (target && job.Status?.value !== target) {
    const status = await db.jobStatus.findUnique({ where: { value: target } });
    if (status) data.Status = { connect: { id: status.id } };
  }
  if ((classification === "job_application" || classification === "job_response") && (!job.applied || !job.appliedDate)) {
    data.applied = true;
    if (!job.appliedDate) data.appliedDate = emailDate;
  }
  if (Object.keys(data).length === 0) return { changed: false, note: `owner correction to ${classification}: job unchanged` };
  await db.job.update({ where: { id: jobId }, data });
  return { changed: true, note: `owner correction to ${classification}${data.Status ? `: status ${job.Status?.value || "none"} -> ${target}` : ""}` };
}
