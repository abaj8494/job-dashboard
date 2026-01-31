import { z } from "zod";

export const AddJobFormSchema = z.object({
  id: z.string().optional(),
  userId: z.string().optional(),
  title: z
    .string({
      error: "Job title is required.",
    })
    .min(2, {
      message: "Job title must be at least 2 characters.",
    }),
  company: z
    .string({
      error: "Company name is required.",
    })
    .min(2, {
      message: "Company name must be at least 2 characters.",
    }),
  location: z.string().optional(),
  type: z.string().optional(),
  source: z.string().optional(),
  status: z.string().optional().default("draft"),
  dueDate: z.date().optional(),
  dateApplied: z.date().optional(),
  salaryRange: z.string().optional(),
  jobDescription: z.string().optional(),
  jobUrl: z.string().optional(),
  applied: z.boolean().default(false),
  resume: z.string().optional(),
});
