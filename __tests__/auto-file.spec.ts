/**
 * @jest-environment node
 */
import { autoFileImport } from "@/lib/email/auto-file";

type Fn = jest.Mock;

function makeDb() {
  const db = {
    job: { findMany: jest.fn() as Fn, update: jest.fn() as Fn, create: jest.fn() as Fn },
    jobStatus: { findUnique: jest.fn() as Fn },
    company: { findUnique: jest.fn() as Fn, create: jest.fn() as Fn },
    jobTitle: { findUnique: jest.fn() as Fn, create: jest.fn() as Fn },
    location: { findFirst: jest.fn() as Fn, create: jest.fn() as Fn },
    jobSource: { findUnique: jest.fn() as Fn },
  };
  db.jobStatus.findUnique.mockImplementation(async ({ where }: { where: { value: string } }) => ({ id: `status-${where.value}`, value: where.value }));
  db.job.findMany.mockResolvedValue([]);
  db.job.update.mockResolvedValue({});
  db.job.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "job-new", ...data }));
  db.company.findUnique.mockResolvedValue(null);
  db.company.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "company-new", ...data }));
  db.jobTitle.findUnique.mockResolvedValue(null);
  db.jobTitle.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "title-new", ...data }));
  db.location.findFirst.mockResolvedValue(null);
  db.location.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "loc-new", ...data }));
  db.jobSource.findUnique.mockResolvedValue(null);
  return db;
}

const base = {
  subject: "Thank you for applying",
  bodyText: "body",
  emailDate: new Date("2026-10-01T00:00:00Z"),
  confidence: 0.95,
  reviewRequired: false,
};

const existingJob = (over: Record<string, unknown> = {}) => ({
  id: "job-1",
  applied: true,
  Company: { label: "Acme", value: "acme" },
  JobTitle: { label: "Software Engineer" },
  Status: { id: "status-applied", value: "applied" },
  ...over,
});

describe("autoFileImport", () => {
  test("missing or true reviewRequired stays pending", async () => {
    const db = makeDb();
    const a = await autoFileImport(db as never, "u1", { ...base, classification: "interview", reviewRequired: undefined, extractedData: { company: "Acme" } });
    const b = await autoFileImport(db as never, "u1", { ...base, classification: "interview", reviewRequired: true, extractedData: { company: "Acme" } });
    expect(a.status).toBe("pending");
    expect(b.status).toBe("pending");
    expect(db.job.findMany).not.toHaveBeenCalled();
  });

  test("'other' and missing company stay pending", async () => {
    const db = makeDb();
    expect((await autoFileImport(db as never, "u1", { ...base, classification: "other", extractedData: { company: "Acme" } })).status).toBe("pending");
    const r = await autoFileImport(db as never, "u1", { ...base, classification: "job_response", extractedData: {} });
    expect(r.status).toBe("pending");
    expect(r.note).toMatch(/no company/);
  });

  test("links to the existing job by company + title and advances status", async () => {
    const db = makeDb();
    db.job.findMany.mockResolvedValue([existingJob()]);
    const r = await autoFileImport(db as never, "u1", {
      ...base,
      classification: "interview",
      extractedData: { company: "ACME", jobTitle: "software engineer" },
    });
    expect(r).toMatchObject({ status: "approved", jobId: "job-1", action: "linked" });
    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { Status: { connect: { id: "status-interview" } } },
    });
    expect(db.job.create).not.toHaveBeenCalled();
  });

  test("never moves a job backwards; rejection always applies", async () => {
    const db = makeDb();
    db.job.findMany.mockResolvedValue([existingJob({ Status: { id: "s", value: "interview" } })]);
    const r = await autoFileImport(db as never, "u1", { ...base, classification: "job_response", extractedData: { company: "Acme", jobTitle: "Software Engineer" } });
    expect(r.action).toBe("linked");
    expect(db.job.update).not.toHaveBeenCalled();

    const rej = await autoFileImport(db as never, "u1", { ...base, classification: "rejection", extractedData: { company: "Acme", jobTitle: "Software Engineer" } });
    expect(rej.action).toBe("linked");
    expect(db.job.update).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { Status: { connect: { id: "status-rejected" } } } });
  });

  test("follow_up links without changing status; marks applied on an application ack", async () => {
    const db = makeDb();
    db.job.findMany.mockResolvedValue([existingJob({ applied: false, Status: { id: "s", value: "draft" } })]);
    const f = await autoFileImport(db as never, "u1", { ...base, classification: "follow_up", extractedData: { company: "Acme", jobTitle: "Software Engineer" } });
    expect(f.action).toBe("linked");
    expect(db.job.update).not.toHaveBeenCalled();

    const ack = await autoFileImport(db as never, "u1", { ...base, classification: "job_response", extractedData: { company: "Acme", jobTitle: "Software Engineer" } });
    expect(ack.action).toBe("linked");
    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { Status: { connect: { id: "status-applied" } }, applied: true, appliedDate: base.emailDate },
    });
  });

  test("single job at the company with no title extracted is linked, unless it is a new application", async () => {
    const db = makeDb();
    db.job.findMany.mockResolvedValue([existingJob()]);
    const r = await autoFileImport(db as never, "u1", { ...base, classification: "rejection", extractedData: { company: "Acme" } });
    expect(r.action).toBe("linked");

    const app = await autoFileImport(db as never, "u1", { ...base, classification: "job_application", extractedData: { company: "Acme", jobTitle: "Data Scientist" } });
    expect(app.action).toBe("created");
  });

  test("several jobs at the company and no title match stays pending", async () => {
    const db = makeDb();
    db.job.findMany.mockResolvedValue([existingJob(), existingJob({ id: "job-2", JobTitle: { label: "Product Manager" } })]);
    const r = await autoFileImport(db as never, "u1", { ...base, classification: "rejection", extractedData: { company: "Acme", jobTitle: "Designer" } });
    expect(r.status).toBe("pending");
    expect(r.note).toMatch(/2 jobs at Acme/);
  });

  test("creates company, title, location and job for a new confident application", async () => {
    const db = makeDb();
    const r = await autoFileImport(db as never, "u1", {
      ...base,
      classification: "job_application",
      extractedData: { company: "Canva", jobTitle: "Data Engineer", location: "Sydney", applicationUrl: "https://x/y", source: "linkedin", jobType: "part-time" },
    });
    expect(r).toMatchObject({ status: "approved", jobId: "job-new", action: "created" });
    expect(db.company.create).toHaveBeenCalledWith({ data: { label: "Canva", value: "canva", createdBy: "u1" } });
    expect(db.jobTitle.create).toHaveBeenCalledWith({ data: { label: "Data Engineer", value: "data engineer", createdBy: "u1" } });
    expect(db.location.create).toHaveBeenCalledWith({ data: { label: "Sydney", value: "sydney", createdBy: "u1" } });
    expect(db.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "u1",
        companyId: "company-new",
        jobTitleId: "title-new",
        locationId: "loc-new",
        statusId: "status-applied",
        jobUrl: "https://x/y",
        applied: true,
        appliedDate: base.emailDate,
        jobType: "PT",
      }),
    });
  });

  test("company match is exact (case-insensitive), never substring", async () => {
    const db = makeDb();
    await autoFileImport(db as never, "u1", { ...base, classification: "rejection", extractedData: { company: "Canva", jobTitle: "Engineer" } });
    expect(db.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1", Company: { value: "canva" } } }));
  });

  test("title containment is on word boundaries", async () => {
    const db = makeDb();
    db.job.findMany.mockResolvedValue([existingJob({ JobTitle: { label: "Engineering Manager" } }), existingJob({ id: "job-2", JobTitle: { label: "Senior Software Engineer" } })]);
    const r = await autoFileImport(db as never, "u1", { ...base, classification: "interview", extractedData: { company: "Acme", jobTitle: "Software Engineer" } });
    expect(r).toMatchObject({ action: "linked", jobId: "job-2" });
  });

  test("no job and no title stays pending", async () => {
    const db = makeDb();
    const r = await autoFileImport(db as never, "u1", { ...base, classification: "rejection", extractedData: { company: "Acme" } });
    expect(r.status).toBe("pending");
    expect(r.note).toMatch(/no job title/);
    expect(db.job.create).not.toHaveBeenCalled();
  });
});
